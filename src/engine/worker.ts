/* =============================================================================
 * KASAUTI — engine/worker.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Entry point of each background worker thread.
 * WHY:   Parsing thousands of files on VS Code's extension-host thread would
 *        freeze the editor. Workers keep typing smooth (SPEC FR-02).
 * FLOW:  workerPool.ts posts WorkerRequest  ->  analyze()  ->  WorkerResponse
 *        is posted back. Token arrays are *transferred* (zero-copy), not cloned.
 *        On a GrammarError the host is told which grammar broke; the host then
 *        terminates this worker and starts a fresh one (SPEC §B9).
 * ========================================================================== */

import { parentPort, workerData } from 'worker_threads';
import { analyze } from './analyzer';
import { GrammarError, ParserService } from './parser';
import type { WorkerRequest, WorkerResponse } from './types';

const service = new ParserService((workerData as { wasmDir: string }).wasmDir);
// Warm up the WASM runtime immediately so the first real request is fast.
void service.init();

parentPort!.on('message', async (req: WorkerRequest) => {
  try {
    const analysis = await analyze(service, req.languageKey, req.path, req.text, req.forceGeneric);
    const res: WorkerResponse = { id: req.id, ok: true, analysis };
    parentPort!.postMessage(res, [analysis.tokenIds.buffer as ArrayBuffer, analysis.tokenLines.buffer as ArrayBuffer, analysis.lineLengths.buffer as ArrayBuffer]);
  } catch (e) {
    const res: WorkerResponse = {
      id: req.id, ok: false,
      error: String((e as Error)?.message ?? e),
      brokenGrammar: e instanceof GrammarError ? e.grammar : undefined,
    };
    parentPort!.postMessage(res);
  }
});
