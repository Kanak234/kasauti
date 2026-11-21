/* =============================================================================
 * KASAUTI — prove/runner.ts   (v2.0 "Parakh")
 * -----------------------------------------------------------------------------
 * WHAT:  The impure half of Prove: starts Python or Node on the harness,
 *        feeds it one JSON request, collects the JSON lines it prints, and
 *        kills it at the timeout.
 *          bench()      -> measured points + fitted Big-O
 *          equivalent() -> do two versions return the same results?
 * WHY:   Isolation by process: whatever the measured code does (infinite
 *        loop, crash, huge allocation), the editor keeps running and the user
 *        gets every point measured before things went wrong.
 *        Environment is scrubbed to an allow-list, so API keys in the user's
 *        environment (OPENAI_API_KEY …) are invisible to the code being run.
 * FLOW:  views/parakh.ts (editor) and mcp/server.ts call these; results go to
 *        the proof webview / the verify loop / the MCP tool reply.
 * ========================================================================== */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fitComplexity, Fit, InputKind, Point, ProveLanguage, sizesFor } from './core';

export interface RunnerOptions {
  /** Folder holding harness.py / harness.js (the extension's media/harness). */
  harnessDir: string;
  /** Python executable (python3 / python / py / a venv path). */
  python?: string;
  /** Node-compatible executable; defaults to the current runtime. Inside VS
   *  Code that is Electron, which acts as Node with ELECTRON_RUN_AS_NODE=1. */
  node?: string;
  timeoutMs?: number;
}

interface RawResult { lines: Array<Record<string, any>>; stderr: string; timedOut: boolean; code: number | null }

/** Environment variables the child may see. Everything else (tokens, keys,
 *  cloud credentials) is withheld. */
const ENV_ALLOW = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL',
  'VIRTUAL_ENV', 'CONDA_PREFIX', 'PYTHONHOME', 'APPDATA', 'LOCALAPPDATA'];
function scrubbedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', ...extra };
}

/** Spawn, send the request, collect JSON lines, enforce the timeout. */
function run(language: ProveLanguage, request: object, opt: RunnerOptions): Promise<RawResult> {
  const harness = path.join(opt.harnessDir, language === 'python' ? 'harness.py' : 'harness.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kasauti-prove-'));   // empty folder: the code sees nothing of the project
  const [cmd, args, extraEnv] = language === 'python'
    ? [opt.python ?? 'python3', [harness], {}]
    : [opt.node ?? process.execPath, [harness], { ELECTRON_RUN_AS_NODE: '1' }];
  return new Promise((resolve) => {
    const lines: RawResult['lines'] = [];
    let stdout = '', stderr = '', timedOut = false, settled = false;
    const child = spawn(cmd, args, { cwd, env: scrubbedEnv(extraEnv), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdout.trim()) { try { lines.push(JSON.parse(stdout)); } catch { /* partial line from a killed process */ } }
      fs.rm(cwd, { recursive: true, force: true }, () => undefined);
      resolve({ lines, stderr: stderr.slice(-2000), timedOut, code });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opt.timeoutMs ?? 30_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
      let i: number;
      while ((i = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, i); stdout = stdout.slice(i + 1);
        if (line.trim()) { try { lines.push(JSON.parse(line)); } catch { stderr += line + '\n'; } }   // stray print() from the user's code
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => { stderr += c; });
    child.on('error', (e) => { stderr += String(e.message); finish(null); });
    child.on('close', finish);
    child.stdin.on('error', () => undefined);       // child died before reading: reported via 'close'
    child.stdin.end(JSON.stringify(request));
  });
}

export interface BenchResult { points: Point[]; fit?: Fit; error?: string; timedOut: boolean }

/** Measure one function at growing n and fit its growth. */
export async function bench(language: ProveLanguage, code: string, fn: string, kind: InputKind, opt: RunnerOptions, sizes = sizesFor(kind)): Promise<BenchResult> {
  const r = await run(language, { mode: 'bench', code, fn, kind, sizes, budgetSec: 1.0, totalSec: Math.max(5, ((opt.timeoutMs ?? 30_000) / 1000) - 5) }, opt);
  const points = r.lines.filter((l) => l.type === 'point').map((l) => ({ n: l.n as number, t: l.t as number }));
  const err = r.lines.find((l) => l.type === 'error')?.error as string | undefined;
  if (err || (!points.length && r.code !== 0)) return { points, timedOut: r.timedOut, error: err ?? launchError(language, opt, r) };
  return { points, fit: fitComplexity(points), timedOut: r.timedOut };
}

export interface EquivResult { equal: boolean; checked: number; mismatch?: { input: string; original: string; candidate: string; sideEffect: boolean }; error?: string }

/** Do `codeA` and `codeB` (both defining `fn`) behave identically? */
export async function equivalent(language: ProveLanguage, codeA: string, codeB: string, fn: string, kind: InputKind, opt: RunnerOptions): Promise<EquivResult> {
  const r = await run(language, { mode: 'equiv', codeA, codeB, fn, kind }, { ...opt, timeoutMs: Math.min(opt.timeoutMs ?? 30_000, 20_000) });
  const err = r.lines.find((l) => l.type === 'error')?.error as string | undefined;
  if (err) return { equal: false, checked: 0, error: err };
  const mm = r.lines.find((l) => l.type === 'mismatch');
  const done = r.lines.find((l) => l.type === 'done');
  if (!done && !mm) return { equal: false, checked: 0, error: r.timedOut ? 'Timed out while comparing — one version may loop forever.' : launchError(language, opt, r) };
  return { equal: !mm, checked: (done?.checked as number) ?? 0, mismatch: mm as EquivResult['mismatch'] };
}

/** Turn "spawn python3 ENOENT" into an instruction the user can follow. */
function launchError(language: ProveLanguage, opt: RunnerOptions, r: RawResult): string {
  if (/ENOENT/.test(r.stderr)) return language === 'python'
    ? `Python was not found ("${opt.python ?? 'python3'}"). Set kasauti.prove.pythonPath to your interpreter.`
    : 'Could not start a JavaScript runtime.';
  if (r.timedOut) return 'Timed out before the first measurement — the function may never return for these inputs.';
  return (r.stderr.trim().split('\n').slice(-3).join(' ') || `process exited with code ${r.code}`).slice(0, 400);
}

/** Find a working Python: the configured one, else common names. */
export async function findPython(preferred?: string): Promise<string | undefined> {
  const candidates = [preferred, process.platform === 'win32' ? 'python' : 'python3', 'python', process.platform === 'win32' ? 'py' : undefined]
    .filter((x): x is string => !!x);
  for (const c of candidates) {
    const ok = await new Promise<boolean>((res) => {
      const p = spawn(c, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { windowsHide: true });
      p.on('error', () => res(false));
      p.on('close', (code) => res(code === 0));
    });
    if (ok) return c;
  }
  return undefined;
}
