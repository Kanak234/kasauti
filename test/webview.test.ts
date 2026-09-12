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

test('layout: the shape is a stepped pyramid, not a tower (v0.2.0 regression)', () => {
  // v0.1.0 rendered "one long stick" in a real editor. Each assertion below is
  // one of the four measured causes, so the shape cannot silently regress.
  const shapes: Record<string, string[]> = {
    'flat project (one folder)': ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g.ts'],
    'root only': ['a.py', 'b.py', 'c.py', 'd.py'],
    'typical tree': [...Array(14)].map((_, i) => `src/x${i}.ts`)
      .concat([...Array(34)].map((_, i) => `src/engine/y${i}.ts`), [...Array(9)].map((_, i) => `test/t${i}.ts`), ['README.ts']),
    'large repo': [...Array(300)].map((_, i) => `src/${['core', 'ui', 'api', 'db'][i % 4]}/${i % 3 ? 'sub/' : ''}f${i}.ts`),
  };
  for (const [name, paths] of Object.entries(shapes)) {
    const l = layoutPyramid(paths.map((p, i) => ({ key: 'k' + i, path: p, sloc: 30 + (i * 53) % 500, value: (i * i * 7) % 180 })));
    // D: always enough floors to read as a pyramid
    assert.ok(l.floors.length >= 3, `${name}: only ${l.floors.length} floor(s)`);
    assert.ok(l.floors.length <= 6, `${name}: ${l.floors.length} floors is a tower`);
    // C: wider than tall
    assert.ok(l.height <= 0.55 * l.width, `${name}: height ${l.height.toFixed(1)} vs width ${l.width.toFixed(1)}`);
    for (let i = 1; i < l.floors.length; i++) {
      // B: visible taper — each floor clearly smaller than the one below
      assert.ok(l.floors[i].size <= l.floors[i - 1].size * 0.8, `${name}: floor ${i} barely tapers`);
      assert.ok(l.floors[i].y > l.floors[i - 1].y, `${name}: floors must stack upward`);
      assert.ok(l.floors[i].size > 0, `${name}: floor ${i} has a non-positive size`);
    }
    for (const b of l.blocks) {
      const f = l.floors[b.floor];
      // A: a block is a tile, never a spike
      assert.ok(b.h <= b.w * 1.6 + 1e-9, `${name}: block ${b.key} is ${(b.h / b.w).toFixed(1)}x taller than wide`);
      assert.ok(b.w > 0 && b.h > 0, `${name}: degenerate block`);
      // blocks stay on their slab and never pierce the floor above
      assert.ok(Math.abs(b.x) + b.w / 2 <= f.size / 2 + 1e-9, `${name}: block ${b.key} overhangs its floor`);
      assert.ok(Math.abs(b.z) + b.w / 2 <= f.size / 2 + 1e-9, `${name}: block ${b.key} overhangs its floor`);
      const next = l.floors[b.floor + 1];
      if (next) assert.ok(b.y + b.h <= next.y + 1e-9, `${name}: block ${b.key} pierces the floor above`);
    }
    // every file is placed exactly once
    assert.equal(l.blocks.length, paths.length, `${name}: blocks lost or duplicated`);
    assert.equal(new Set(l.blocks.map((b) => b.key)).size, paths.length);
    assert.equal(l.floors.reduce((s, f) => s + f.files, 0), paths.length);
  }
});

test('layout: floors carry a meaningful label and the biggest tier is the base', () => {
  const paths = [...Array(20)].map((_, i) => `src/engine/a${i}.ts`)
    .concat([...Array(5)].map((_, i) => `src/b${i}.ts`), ['c.ts']);
  const l = layoutPyramid(paths.map((p, i) => ({ key: 'k' + i, path: p, sloc: 50, value: 10 })));
  assert.ok(l.floors[0].files >= l.floors[l.floors.length - 1].files, 'biggest tier is the base');
  assert.ok(l.floors.every((f) => f.label.length > 0), 'every floor is labelled');
});

test('layout: an empty workspace produces nothing, one file still produces a floor', () => {
  assert.deepEqual(layoutPyramid([]), { blocks: [], floors: [], width: 0, height: 0 });
  const one = layoutPyramid([{ key: 'k', path: 'a.py', sloc: 10, value: 5 }]);
  assert.equal(one.blocks.length, 1);
  assert.equal(one.floors.length, 1, 'a single file cannot be split into tiers');
  assert.ok(one.width > 0 && one.height > 0);
});
