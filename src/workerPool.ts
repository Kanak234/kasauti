/* =============================================================================
 * KASAUTI — workerPool.ts
 * -----------------------------------------------------------------------------
 * WHAT:  A small pool of analysis worker threads with two priority lanes:
 *          'high'   = the file you are typing in right now (live preview)
 *          'normal' = background workspace scan
 * WHY:   - Live mode must feel instant even while a 5,000-file scan is running,
 *          so live requests jump the queue (SPEC FR-04, live requirement).
 *        - A grammar crash can corrupt a worker's WASM runtime (verified in the
 *          M1 spike), so a worker that reports a broken grammar or crashes is
 *          terminated and replaced, and that grammar is forced to Tier 2.
 *        - A per-job timeout protects against pathological inputs.
 * FLOW:  controller.ts -> pool.analyze(req, lane) -> worker.ts -> result
 * ========================================================================== */

import { Worker } from 'worker_threads';
import * as os from 'os';
import type { FileAnalysis, WorkerRequest, WorkerResponse } from './engine/types';

type Lane = 'high' | 'normal';
interface Job {
  req: Omit<WorkerRequest, 'id'>;
  resolve(a: FileAnalysis): void;
  reject(e: Error): void;
}
interface Slot { worker: Worker; job?: Job; id?: number; timer?: NodeJS.Timeout }

export class CancelledError extends Error { constructor() { super('cancelled'); } }

const JOB_TIMEOUT_MS = 20_000;

export class WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly high: Job[] = [];
  private readonly normal: Job[] = [];
  private nextId = 1;
  private disposed = false;
  /** Grammars that failed on this machine; their files go to Tier 2. */
  readonly brokenGrammars = new Set<string>();

  constructor(private readonly workerJs: string, private readonly wasmDir: string,
    size = Math.max(1, Math.min(4, os.cpus().length - 1)),
    private readonly log: (msg: string) => void = () => {}) {
    for (let i = 0; i < size; i++) {
      const slot = {} as Slot;
      this.attachWorker(slot);
      this.slots.push(slot);
    }
  }

  get queued(): number { return this.high.length + this.normal.length; }

  /** Queue a file for analysis. Resolves with its FileAnalysis. */
  analyze(req: Omit<WorkerRequest, 'id'>, lane: Lane = 'normal'): Promise<FileAnalysis> {
    if (this.disposed) return Promise.reject(new CancelledError());
    const grammar = req.languageKey.startsWith('notebook:') ? 'python' : req.languageKey;
    const forced = { ...req, forceGeneric: req.forceGeneric || this.brokenGrammars.has(grammar) };
    return new Promise((resolve, reject) => {
      (lane === 'high' ? this.high : this.normal).push({ req: forced, resolve, reject });
      this.pump();
    });
  }

  /** Drop every queued background job (scan cancelled). Live jobs stay. */
  cancelBackground(): void {
    for (const j of this.normal.splice(0)) j.reject(new CancelledError());
  }

  dispose(): void {
    this.disposed = true;
    for (const j of [...this.high.splice(0), ...this.normal.splice(0)]) j.reject(new CancelledError());
    for (const s of this.slots) { if (s.timer) clearTimeout(s.timer); void s.worker.terminate(); }
  }

  /* ---------------- internals ------------------------------------------- */
  /** Start a worker thread and bind its events to THIS slot object (the slot
   *  survives worker replacement, so listeners must reference the slot). */
  private attachWorker(slot: Slot): void {
    const w = new Worker(this.workerJs, { workerData: { wasmDir: this.wasmDir } });
    slot.worker = w;
    w.on('message', (res: WorkerResponse) => { if (slot.worker === w) this.onMessage(slot, res); });
    w.on('error', (err) => { if (slot.worker === w) this.onCrash(slot, err); });
    w.on('exit', (code) => { if (slot.worker === w && code !== 0 && !this.disposed) this.onCrash(slot, new Error(`worker exited with code ${code}`)); });
  }

  /** Give idle workers the next job: high lane first. */
  private pump(): void {
    for (const s of this.slots) {
      if (s.job) continue;
      const job = this.high.shift() ?? this.normal.shift();
      if (!job) return;
      s.job = job;
      s.id = this.nextId++;
      s.timer = setTimeout(() => this.onTimeout(s), JOB_TIMEOUT_MS);
      s.worker.postMessage({ ...job.req, id: s.id } satisfies WorkerRequest);
    }
  }

  private finish(s: Slot): Job | undefined {
    const job = s.job;
    if (s.timer) clearTimeout(s.timer);
    s.job = undefined; s.id = undefined; s.timer = undefined;
    return job;
  }

  private onMessage(s: Slot, res: WorkerResponse): void {
    if (res.id !== s.id) return;                   // stale reply from a replaced job
    const job = this.finish(s)!;
    if (res.ok && res.analysis) { job.resolve(res.analysis); this.pump(); return; }
    if (res.brokenGrammar) {
      // The runtime in this worker may now be corrupt: replace the worker and
      // retry this file once in generic (Tier 2) mode.
      this.brokenGrammars.add(res.brokenGrammar);
      this.log(`Grammar '${res.brokenGrammar}' failed (${res.error}); its files will use partial analysis.`);
      this.replace(s);
      this.high.unshift({ ...job, req: { ...job.req, forceGeneric: true } });
    } else {
      job.reject(new Error(res.error ?? 'analysis failed'));
    }
    this.pump();
  }

  private onTimeout(s: Slot): void {
    const job = this.finish(s);
    this.log('Analysis timed out; restarting worker.');
    this.replace(s);
    job?.reject(new Error('analysis timed out'));
    this.pump();
  }

  private onCrash(s: Slot, err: Error): void {
    if (this.disposed) return;
    const job = this.finish(s);
    this.log(`Worker crashed: ${err.message}; restarting.`);
    this.replace(s);
    job?.reject(err);
    this.pump();
  }

  private replace(s: Slot): void {
    const old = s.worker;
    old.removeAllListeners();
    void old.terminate();
    this.attachWorker(s);
  }
}
