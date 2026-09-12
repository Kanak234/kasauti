/* =============================================================================
 * KASAUTI — test/host.test.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Tests the host-side pieces that do not need VS Code:
 *        - WorkerPool with REAL worker threads (dist/worker.js)
 *        - recovery when a grammar file is corrupt (worker recycled, Tier 2)
 *        - ResultStore: findings, duplication across files, aggregates, batch
 * WHY:   These are the moving parts of live mode; a bug here would show as a
 *        frozen or wrong pyramid.
 * FLOW:  `npm test` -> node --test
 * ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkerPool } from '../src/workerPool';
import { ResultStore, StoreChange } from '../src/store';
import { DEFAULT_THRESHOLDS } from '../src/engine/rules';
import type { FileAnalysis } from '../src/engine/types';

const ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(ROOT, 'dist/worker.js');
const WASM = path.join(ROOT, 'dist/wasm');
const read = (f: string) => fs.readFileSync(path.join(ROOT, 'test/samples', f), 'utf8');

test('worker pool: analyzes many files in parallel threads', async () => {
  const pool = new WorkerPool(WORKER, WASM, 3);
  try {
    const files = ['sample.py', 'sample.js', 'sample.go', 'sample.rs', 'sample.java', 'sample.lua', 'sample.kt'];
    const keys = ['python', 'javascript', 'go', 'rust', 'java', 'lua', 'kotlin'];
    const jobs: Array<Promise<FileAnalysis>> = [];
    for (let round = 0; round < 4; round++) {
      files.forEach((f, i) => jobs.push(pool.analyze({ languageKey: keys[i], path: f, text: read(f) })));
    }
    const results = await Promise.all(jobs);
    assert.equal(results.length, 28);
    assert.ok(results.every((r) => r.tier === 1 && r.functions.length === 2 && !r.hasSyntaxErrors));
  } finally { pool.dispose(); }
});

test('worker pool: live (high) jobs overtake a queued background scan', async () => {
  const pool = new WorkerPool(WORKER, WASM, 1);
  try {
    const order: string[] = [];
    const bg = Array.from({ length: 15 }, (_, i) =>
      pool.analyze({ languageKey: 'python', path: `bg${i}.py`, text: read('sample.py') }).then(() => order.push('bg')));
    const live = pool.analyze({ languageKey: 'javascript', path: 'live.js', text: read('sample.js') }, 'high').then(() => order.push('live'));
    await Promise.all([...bg, live]);
    assert.ok(order.indexOf('live') <= 2, `live finished at position ${order.indexOf('live')}`);
  } finally { pool.dispose(); }
});

test('worker pool: a corrupt grammar is isolated; its files fall back to Tier 2', async () => {
  // Copy the wasm folder and corrupt the Go grammar on purpose.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasauti-wasm-'));
  for (const f of fs.readdirSync(WASM)) fs.copyFileSync(path.join(WASM, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'tree-sitter-go.wasm'), Buffer.from('not a wasm module'));
  const logs: string[] = [];
  const pool = new WorkerPool(WORKER, dir, 1, (m) => logs.push(m));
  try {
    const go = await pool.analyze({ languageKey: 'go', path: 'a.go', text: read('sample.go') });
    assert.equal(go.tier, 2, 'Go falls back to generic analysis');
    assert.ok(go.fallbackNote);
    assert.ok(pool.brokenGrammars.has('go'));
    // Other languages still work in the recycled worker.
    const py = await pool.analyze({ languageKey: 'python', path: 'a.py', text: read('sample.py') });
    assert.equal(py.tier, 1);
    assert.ok(logs.some((l) => l.includes("'go'")));
  } finally { pool.dispose(); }
});

test('store: findings, duplication across files, aggregates and removal', async () => {
  const pool = new WorkerPool(WORKER, WASM, 2);
  try {
    const store = new ResultStore(DEFAULT_THRESHOLDS);
    const changes: string[][] = [];
    store.onChange((c) => changes.push(c.changed));
    const block = Array.from({ length: 6 }, (_, i) =>
      `def f${i}(items):\n    out = []\n    for it in items:\n        if it.value > ${i}:\n            out.append(it.name.upper())\n    return out\n`).join('\n');
    const a = await pool.analyze({ languageKey: 'python', path: 'a.py', text: 'import os\n' + block });
    const b = await pool.analyze({ languageKey: 'python', path: 'b.py', text: block + '\nprint(1)\n' });
    store.set('file:///w/src/a.py', 'src/a.py', a, true);
    store.set('file:///w/lib/b.py', 'lib/b.py', b, true);
    const ra = store.get('file:///w/src/a.py')!;
    const dup = ra.findings.find((f) => f.ruleId === 'CQ007');
    assert.ok(dup, 'duplicate detected in a.py');
    assert.match(dup!.message, /lib\/b\.py:1/);
    // 41 duplicated lines cost 10 + 41/5 = 18 min; on ~37 SLOC that is a 1.6%
    // debt ratio, which is still grade A in the debt model (by design; the
    // duplication percentage is shown separately in the UI).
    assert.equal(dup!.debtMinutes, 18);
    assert.ok(ra.score.debtMinutes >= 18);
    // Adding b.py must have re-scored a.py too (incremental duplication).
    assert.ok(changes[1].includes('file:///w/src/a.py'));
    // Aggregates sum debt and SLOC.
    const ws = store.workspaceScore();
    assert.equal(ws.sloc, a.sloc + b.sloc);
    assert.ok(store.folderScores().has('src') && store.folderScores().has('lib'));
    assert.equal(store.hotspots(1).length, 1);
    // Removing b.py clears a.py's duplication finding.
    store.remove('file:///w/lib/b.py');
    assert.equal(store.get('file:///w/src/a.py')!.findings.filter((f) => f.ruleId === 'CQ007').length, 0);
    // Threshold change re-evaluates without re-parsing.
    store.updateSettings({ ...DEFAULT_THRESHOLDS, lineLength: 10 }, true);
    assert.ok(store.get('file:///w/src/a.py')!.findings.some((f) => f.ruleId === 'CQ010'));
  } finally { pool.dispose(); }
});

test('store: batch mode shows files immediately, resolves duplication at the end', async () => {
  const pool = new WorkerPool(WORKER, WASM, 2);
  try {
    const store = new ResultStore(DEFAULT_THRESHOLDS);
    const events: StoreChange[] = [];
    store.onChange((c) => events.push(c));
    const text = read('sample.js').repeat(3);
    const x = await pool.analyze({ languageKey: 'javascript', path: 'x.js', text });
    const y = await pool.analyze({ languageKey: 'javascript', path: 'y.js', text });
    store.beginBatch();
    store.set('k:x', 'x.js', x, true);
    store.set('k:y', 'y.js', y, true);
    assert.equal(events.length, 2, 'each file is emitted as soon as it is analyzed (live build-up)');
    assert.ok(!store.get('k:x')!.findings.some((f) => f.ruleId === 'CQ007'), 'duplication deferred during batch');
    store.endBatch();
    assert.equal(events.length, 3);
    assert.equal(events[2].all, true);
    assert.ok(store.get('k:x')!.findings.some((f) => f.ruleId === 'CQ007'), 'duplication resolved after batch');
  } finally { pool.dispose(); }
});
