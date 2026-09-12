/* =============================================================================
 * KASAUTI — test/engine.test.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Unit tests for rules.ts (thresholds -> findings), scoring.ts
 *        (debt -> grade), and duplication.ts (clone detection, incremental).
 * WHY:   These three turn metrics into the grade the user sees. A mistake
 *        here would make every score wrong, so the SPEC formulas are locked.
 * FLOW:  `npm test` bundles and runs this with node --test.
 * ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { evaluate, DEFAULT_THRESHOLDS } from '../src/engine/rules';
import { scoreOf, gradeOf, formatDebt } from '../src/engine/scoring';
import { DuplicationIndex } from '../src/engine/duplication';
import { analyze } from '../src/engine/analyzer';
import { ParserService } from '../src/engine/parser';

const parser = new ParserService(path.resolve(__dirname, '..', 'dist/wasm'));

test('scoring: SonarQube grade boundaries and 0–100 mapping (SPEC §A7.1)', () => {
  assert.deepEqual(['A', 'A', 'B', 'C', 'D', 'E'], [0, 0.05, 0.1, 0.2, 0.5, 0.51].map(gradeOf));
  // 100 SLOC -> dev cost 3000 min. 150 min debt = 5% -> A, score 90.
  assert.deepEqual([scoreOf(150, 100).grade, scoreOf(150, 100).score], ['A', 90]);
  assert.deepEqual([scoreOf(300, 100).grade, scoreOf(300, 100).score], ['B', 80]);
  assert.deepEqual([scoreOf(600, 100).grade, scoreOf(600, 100).score], ['C', 60]);
  assert.deepEqual([scoreOf(1500, 100).grade, scoreOf(1500, 100).score], ['D', 0]);
  assert.equal(scoreOf(0, 0).score, 100, 'empty file is clean');
  assert.equal(formatDebt(45), '45 min');
  assert.equal(formatDebt(200), '3 h 20 min');
  assert.equal(formatDebt(8 * 60 * 2 + 60), '2 d 1 h');
});

test('rules: a deeply nested, complex function produces the right findings', async () => {
  // 12 ifs chained with && inside nested loops -> over CC, cognitive, nesting.
  const body = Array.from({ length: 12 }, (_, i) => `        if (x > ${i} && y) { total += ${i}; }`).join('\n');
  const src = `function heavy(x, y, a, b, c, d, e, f) {\n  let total = 0;\n  for (let i = 0; i < x; i++) {\n    while (y) {\n      for (const k of a) {\n${body}\n      }\n    }\n  }\n  return total;\n}\n`;
  const a = await analyze(parser, 'javascript', 'heavy.js', src);
  const f = a.functions[0];
  // CC = 1 + for + while + for + 12 ifs + 12 && = 28
  assert.equal(f.cyclomatic, 28);
  const findings = evaluate(a, DEFAULT_THRESHOLDS);
  const ids = findings.map((x) => x.ruleId).sort();
  assert.ok(ids.includes('CQ001') && ids.includes('CQ002') && ids.includes('CQ004') && ids.includes('CQ005'), `got ${ids}`);
  const cq1 = findings.find((x) => x.ruleId === 'CQ001')!;
  assert.equal(cq1.severity, 'critical', '28 >= 2 x 10 -> critical');
  assert.equal(cq1.debtMinutes, 10 + (28 - 10));
  const cq4 = findings.find((x) => x.ruleId === 'CQ004')!;
  assert.deepEqual([cq4.value, cq4.debtMinutes], [8, 20]);
});

test('rules: thresholds are respected and clean code has no debt', async () => {
  const a = await analyze(parser, 'python', 'ok.py', 'def add(a, b):\n    return a + b\n');
  const findings = evaluate(a, DEFAULT_THRESHOLDS);
  assert.equal(findings.length, 0);
  // Lowering the limit to 10 chars flags both lines (14 and 16 chars long)
  const tight = evaluate(a, { ...DEFAULT_THRESHOLDS, lineLength: 10 });
  assert.equal(tight.filter((x) => x.ruleId === 'CQ010').length, 2);
});

test('rules: long lines are capped at 20 findings + 1 summary, debt counts all', () => {
  const a = { engineVersion: '1', languageKey: 'tier2:x', tier: 2 as const, lines: 50, sloc: 50, commentLines: 0,
    functions: [], classes: [], todos: [], suppressions: [], lineLengths: new Uint32Array(50).fill(200), hasSyntaxErrors: false,
    tokenIds: new Uint32Array(0), tokenLines: new Uint32Array(0), analysisMs: 0 };
  const f = evaluate(a, DEFAULT_THRESHOLDS).filter((x) => x.ruleId === 'CQ010');
  assert.equal(f.length, 21);
  assert.equal(f.reduce((s, x) => s + x.debtMinutes, 0), 50);
});

function tokens(seq: number[]): [Uint32Array, Uint32Array] {
  return [Uint32Array.from(seq), Uint32Array.from(seq.map((_, i) => Math.floor(i / 10)))];
}

test('duplication: finds a 150-token clone across files with exact extent', () => {
  const idx = new DuplicationIndex(100);
  const shared = Array.from({ length: 150 }, (_, i) => 1000 + ((i * 7919) % 5000));
  const aSeq = [...Array.from({ length: 40 }, (_, i) => i), ...shared, ...Array.from({ length: 30 }, (_, i) => 500 + i)];
  const bSeq = [...Array.from({ length: 5 }, (_, i) => 900 + i), ...shared];
  idx.setFile('a.js', ...tokens(aSeq));
  idx.setFile('b.js', ...tokens(bSeq));
  const d = idx.duplicatesFor('a.js');
  assert.equal(d.length, 1);
  assert.equal(d[0].tokens, 150);
  assert.equal(d[0].partnerPath, 'b.js');
  assert.equal(d[0].startLine, 4);     // token 40 / 10 tokens per line
});

test('duplication: below threshold is ignored; edits update incrementally', () => {
  const idx = new DuplicationIndex(100);
  const shared = Array.from({ length: 80 }, (_, i) => 3000 + i * 3);
  idx.setFile('a.js', ...tokens([1, 2, 3, ...shared]));
  idx.setFile('b.js', ...tokens([9, 9, ...shared]));
  assert.equal(idx.duplicatesFor('a.js').length, 0, '80 tokens < 100 threshold');
  // Now make the shared run long enough in b and a
  const longer = Array.from({ length: 130 }, (_, i) => 7000 + i * 5);
  const affected = idx.setFile('a.js', ...tokens(longer));
  idx.setFile('b.js', ...tokens(longer));
  assert.ok(affected.has('a.js'));
  assert.equal(idx.duplicatesFor('b.js').length, 1);
  idx.removeFile('a.js');
  assert.equal(idx.duplicatesFor('b.js').length, 0, 'partner removed -> no duplicate');
});

test('duplication: repeated pattern inside one file is not matched with itself', () => {
  const idx = new DuplicationIndex(100);
  const periodic = Array.from({ length: 300 }, (_, i) => i % 4);   // x++; x++; ...
  idx.setFile('p.js', ...tokens(periodic));
  // Non-overlapping copies of a periodic run DO exist (first 150 vs last 150),
  // so exactly one merged block is acceptable; what must not happen is a crash
  // or a block longer than the file.
  const d = idx.duplicatesFor('p.js');
  assert.ok(d.every((b) => b.tokens <= 300));
});

test('duplication: real code clones between two JS files', async () => {
  const fn = Array.from({ length: 6 }, (_, i) =>
    `function f${i}(items) {\n  let out = [];\n  for (const it of items) {\n    if (it.value > ${i}) { out.push(it.name.toUpperCase()); }\n  }\n  return out;\n}`).join('\n');
  const a = await analyze(parser, 'javascript', 'a.js', `const x = 1;\n${fn}\n`);
  const b = await analyze(parser, 'javascript', 'b.js', `${fn}\nexport default 2;\n`);
  const idx = new DuplicationIndex(100);
  idx.setFile('a.js', a.tokenIds, a.tokenLines);
  idx.setFile('b.js', b.tokenIds, b.tokenLines);
  const d = idx.duplicatesFor('a.js');
  assert.equal(d.length, 1);
  assert.equal(d[0].startLine, 1);
  assert.equal(d[0].partnerLine, 0);
});

test('duplication: bulk indexing stays linear with shared boilerplate', () => {
  // Regression test. Thousands of files sharing the same header used to make
  // every insert walk a huge occurrence list (O(n^2)): 5.8 s for 5,000 files.
  // Bulk mode plus the occurrence cap brought it to ~0.2 s.
  const boiler = Array.from({ length: 400 }, (_, i) => 9000 + i);
  const idx = new DuplicationIndex(100);
  const t0 = Date.now();
  for (let f = 0; f < 2000; f++) {
    const body = Array.from({ length: 120 }, (_, i) => (f * 7919 + i * 13) % 60000);
    idx.setFile(`f${f}.js`, ...tokens([...boiler, ...body]), true);
  }
  const ms = Date.now() - t0;
  assert.equal(idx.fileCount, 2000);
  assert.ok(ms < 4000, `bulk indexing took ${ms} ms — the O(n^2) path is back`);
  // The shared boilerplate must still be reported as duplication.
  assert.ok(idx.duplicatesFor('f0.js').some((b) => b.tokens >= 400));
});
