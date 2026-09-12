/* =============================================================================
 * KASAUTI — test/webview.test.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Runs the REAL bundled webviews (dist/webview.js, dist/overview.js)
 *        inside jsdom with a fake VS Code bridge, and drives them with the
 *        same messages the host sends.
 * WHY:   Verifies the UI logic without a browser: WebGL fallback to treemap,
 *        list sorting, live updates, detail drawer, empty states, sidebar.
 *        (jsdom has no WebGL, so the 3D renderer itself is NOT covered here.)
 * FLOW:  `npm test`
 * ========================================================================== */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { layoutPyramid } from '../webview/layout';

const ROOT = path.resolve(__dirname, '..');
/** jsdom objects come from another JS realm; compare by value via JSON. */
const same = (actual: unknown, expected: unknown) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);

function boot(bundle: string, bodyClass: string) {
  const dom = new JSDOM(`<!DOCTYPE html><body class="${bodyClass}"><div id="app"></div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window as any;
  const sent: any[] = [];
  w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => sent.push(m), getState: () => undefined, setState: () => {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.eval(fs.readFileSync(path.join(ROOT, 'dist', bundle), 'utf8'));
  const post = (data: unknown) => w.dispatchEvent(new w.MessageEvent('message', { data }));
  return { w, doc: w.document as Document, sent, post };
}

const file = (i: number, grade: string, extra: object = {}) => ({ key: `file:///w/src/f${i}.py`, path: `src/f${i}.py`, lang: 'Python', tier: 1, grade, score: 80 - i, sloc: 10 * (i + 1), debt: i * 7, maxCC: i, maxCog: i * 2, dupLines: 0, counts: { critical: 0, major: 0, minor: 0, info: 0 }, ...extra });
const summary = (extra: object = {}) => ({ score: 71, grade: 'C', debt: 120, debtText: '2 h', sloc: 900, files: 3, tier1: 2, tier2: 1, skipped: 0, duplicatedPct: 1.5, byCategory: { complexity: 60, size: 30, duplication: 20, style: 10 }, hotspots: [{ key: 'file:///w/src/f2.py', path: 'src/f2.py', grade: 'D', debtText: '14 min' }], scanned: true, ...extra });

test('pyramid panel: without WebGL it falls back to the treemap and says why', () => {
  const { doc, sent, post } = boot('webview.js', 'pyramid');
  same(sent[0], { type: 'ready' });
  post({ type: 'init', files: [file(0, 'A'), file(1, 'B'), file(2, 'E', { tier: 2, lang: 'Pascal' })], summary: summary(), colorBlind: false });
  assert.match(doc.querySelector('.notice')!.textContent!, /3D view unavailable/);
  const leaves = doc.querySelectorAll('.treemap g.leaf');
  assert.equal(leaves.length, 3);
  assert.equal(doc.querySelectorAll('.treemap g.partial').length, 1, 'partial-analysis file is striped');
  assert.match(doc.querySelector('.mini-mark')!.textContent!, /C.*71/);
});

test('pyramid panel: list view sorts, selects, opens detail drawer', () => {
  const { doc, sent, post } = boot('webview.js', 'pyramid');
  post({ type: 'init', files: [file(0, 'A'), file(1, 'B'), file(2, 'D')], summary: summary(), colorBlind: false });
  (doc.querySelector('.seg button[data-v="list"]') as HTMLButtonElement).click();
  let rows = [...doc.querySelectorAll('.list tbody tr')];
  assert.equal(rows.length, 3);
  assert.equal(rows[0].querySelector('td')!.textContent, 'src/f2.py', 'default sort: most debt first');
  // Sort by File ascending
  (doc.querySelector('.list th button') as HTMLButtonElement).click();
  rows = [...doc.querySelectorAll('.list tbody tr')];
  assert.equal(rows[0].querySelector('td')!.textContent, 'src/f0.py');
  (rows[1] as HTMLElement).click();
  same(sent.at(-1), { type: 'detail', key: 'file:///w/src/f1.py' });
  post({ type: 'detail', detail: { file: file(1, 'B'), note: undefined,
    functions: [{ name: 'load', kind: 'function', startLine: 4, params: 2, cyclomatic: 12, cognitive: 20, maxNesting: 4, sloc: 40, mi: 30, grade: 'D' }],
    findings: [{ ruleId: 'CQ002', ruleName: 'Function is hard to understand', severity: 'major', message: "'load' has cognitive complexity 20 (limit 15).", line: 4, debtText: '15 min', why: 'Because.', fix: ['Flatten nesting.'] }] } });
  const drawer = doc.querySelector('.drawer') as HTMLElement;
  assert.equal(drawer.hidden, false);
  assert.match(drawer.textContent!, /cognitive complexity 20/);
  (drawer.querySelector('.fns tbody tr') as HTMLElement).click();
  same(sent.at(-1), { type: 'open', key: 'file:///w/src/f1.py', line: 4 });
  doc.dispatchEvent(new (doc.defaultView as any).KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(drawer.hidden, true);
});

test('pyramid panel: live update replaces a file and removes deleted ones', async () => {
  const { doc, post, w } = boot('webview.js', 'pyramid');
  post({ type: 'init', files: [file(0, 'A'), file(1, 'B')], summary: summary(), colorBlind: false });
  (doc.querySelector('.seg button[data-v="list"]') as HTMLButtonElement).click();
  post({ type: 'files', upsert: [file(1, 'E', { score: 3 })], remove: ['file:///w/src/f0.py'], summary: summary({ grade: 'D', score: 40 }) });
  await new Promise((r) => w.setTimeout(r, 350));     // 2D views are throttled to 300 ms
  const rows = [...doc.querySelectorAll('.list tbody tr')];
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent!, /E/);
  assert.match(doc.querySelector('.mini-mark')!.textContent!, /D.*40/);
});

test('pyramid panel: empty workspace shows a scan call to action', () => {
  const { doc, sent, post } = boot('webview.js', 'pyramid');
  post({ type: 'init', files: [], summary: summary({ scanned: false, files: 0 }), colorBlind: false });
  const btn = [...doc.querySelectorAll('.notice button')].find((b) => b.textContent === 'Scan workspace') as HTMLButtonElement;
  assert.ok(btn);
  btn.click();
  same(sent.at(-1), { type: 'command', id: 'scan' });
});

test('sidebar overview: hallmark, breakdown, hotspots, scan progress, empty state', () => {
  const { doc, sent, post } = boot('overview.js', 'overview');
  post({ type: 'init', files: [], summary: summary({ scanned: false }), colorBlind: false });
  assert.match(doc.body.textContent!, /Scan the workspace/);
  post({ type: 'summary', summary: summary() });
  assert.equal(doc.querySelector('.hallmark .grade')!.textContent, 'C');
  assert.match(doc.querySelector('.hallmark .score')!.textContent!, /^71/);
  assert.equal(doc.querySelectorAll('.stack i').length, 4);
  assert.match(doc.querySelector('.note')!.textContent!, /1 file had partial analysis/);
  (doc.querySelector('.hot-item') as HTMLButtonElement).click();
  same(sent.at(-1), { type: 'open', key: 'file:///w/src/f2.py' });
  post({ type: 'summary', summary: summary({ scanning: { done: 5, total: 20 } }) });
  assert.equal(doc.querySelector('.progress')!.getAttribute('aria-valuenow'), '25');
  post({ type: 'palette', colorBlind: true });
  assert.ok(doc.body.classList.contains('cb'));
});

test('layout: every upper floor is smaller; blocks never leave their floor', () => {
  const files = Array.from({ length: 300 }, (_, i) => ({ key: `k${i}`, path: ['a.py', 'src/b.py', 'src/x/c.py', 'src/x/y/d.py'][i % 4].replace('.py', `${i}.py`), sloc: (i * 37) % 900 + 1, value: (i * 13) % 200 }));
  const l = layoutPyramid(files);
  assert.equal(l.floors.length, 4);
  for (let i = 1; i < l.floors.length; i++) {
    assert.ok(l.floors[i].size < l.floors[i - 1].size, 'stepped pyramid');
    assert.ok(l.floors[i].y > l.floors[i - 1].y, 'floors stack upward');
  }
  for (const b of l.blocks) {
    const f = l.floors[b.floor];
    assert.ok(Math.abs(b.x) + b.w / 2 <= f.size / 2 && Math.abs(b.z) + b.w / 2 <= f.size / 2, `block ${b.key} overflows its floor`);
    const next = l.floors[b.floor + 1];
    if (next) assert.ok(b.y + b.h < next.y, 'no block pierces the floor above');
  }
});
