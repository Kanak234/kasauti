/* =============================================================================
 * KASAUTI — test/golden.test.ts
 * -----------------------------------------------------------------------------
 * WHAT:  "Golden file" tests. Every Tier 1 language has the SAME two functions
 *        written idiomatically (test/samples/sample.*), whose metrics were
 *        computed BY HAND:
 *          classify(a, b): if + logical-and + else-if + else
 *              CC = 1 + if + && + else-if            = 4
 *              Cognitive = if 1 + && 1 + else-if 1 + else 1 = 4
 *          loop(n, m): for > while > if (three levels deep)
 *              CC = 1 + for + while + if             = 4
 *              Cognitive = 1 + (1+1) + (1+2)         = 6
 *              Max nesting                            = 3
 * WHY:   This suite is what makes the "industrial level" claim defensible:
 *        the numbers are locked against hand-computed values (SPEC §A10.6).
 * FLOW:  `npm test` -> esbuild bundles this -> node --test runs it against the
 *        real WASM grammars in dist/wasm.
 * ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { analyze } from '../src/engine/analyzer';
import { ParserService } from '../src/engine/parser';
import { detectLanguage } from '../src/engine/languages';

const ROOT = path.resolve(__dirname, '..');
const parser = new ParserService(path.join(ROOT, 'dist/wasm'));
const sample = (f: string) => path.join(ROOT, 'test/samples', f);

async function run(file: string) {
  const key = detectLanguage(file);
  assert.ok(key, `no language detected for ${file}`);
  return analyze(parser, key!, file, fs.readFileSync(sample(file), 'utf8'));
}

// file -> [classify name, loop name, params per function, expected kind]
const STANDARD: Array<[string, string, string, number]> = [
  ['sample.py', 'classify', 'loop', 2], ['sample.js', 'classify', 'loop', 2],
  ['sample.ts', 'classify', 'loop', 2], ['sample.tsx', 'classify', 'loop', 2],
  ['sample.java', 'classify', 'loop', 2], ['sample.cs', 'Classify', 'Loop', 2],
  ['sample.c', 'classify', 'loop', 2], ['sample.cpp', 'classify', 'loop', 2],
  ['sample.m', 'classify', 'loop', 2], ['sample.go', 'classify', 'loop', 2],
  ['sample.kt', 'classify', 'loop', 2], ['sample.lua', 'classify', 'loop', 2],
  ['sample.rb', 'classify', 'loop', 2], ['sample.rs', 'classify', 'looper', 2],
  ['sample.php', 'classify', 'loop', 2], ['sample.swift', 'classify', 'loop', 2],
  ['sample.scala', 'classify', 'loop', 2], ['sample.dart', 'classify', 'loop', 2],
  ['sample.sol', 'classify', 'loop', 2], ['sample.zig', 'classify', 'loop', 2],
  ['sample.sh', 'classify', 'loop', 0], ['sample.ml', 'classify', 'loop', 2],
  ['sample.res', 'classify', 'loop', 2],
];

for (const [file, cName, lName, params] of STANDARD) {
  test(`golden metrics: ${file}`, async () => {
    const a = await run(file);
    assert.equal(a.tier, 1, `${file} should be Tier 1 (note: ${a.fallbackNote ?? ''})`);
    assert.equal(a.hasSyntaxErrors, false, `${file} parsed with syntax errors`);
    const names = a.functions.map((f) => f.name);
    const c = a.functions.find((f) => f.name === cName);
    const l = a.functions.find((f) => f.name === lName);
    assert.ok(c, `${file}: function ${cName} not found; got [${names}]`);
    assert.ok(l, `${file}: function ${lName} not found; got [${names}]`);
    assert.equal(a.functions.length, 2, `${file}: expected 2 functions, got [${names}]`);
    assert.deepEqual([c!.cyclomatic, c!.cognitive, c!.params], [4, 4, params], `${file} classify [cc, cog, params]`);
    assert.deepEqual([l!.cyclomatic, l!.cognitive, l!.maxNesting, l!.params], [4, 6, 3, params], `${file} loop [cc, cog, nest, params]`);
    assert.ok(c!.sloc >= 3 && l!.sloc >= 6, `${file}: implausible SLOC ${c!.sloc}/${l!.sloc}`);
    assert.ok(c!.halstead.volume > 0 && c!.mi > 0 && c!.mi <= 100, `${file}: Halstead/MI not computed`);
  });
}

test('golden metrics: sample.ex (Elixir idioms: cond + for/if)', async () => {
  const a = await run('sample.ex');
  assert.equal(a.tier, 1);
  const c = a.functions.find((f) => f.name === 'classify')!;
  const l = a.functions.find((f) => f.name === 'loop')!;
  assert.ok(c && l, `got [${a.functions.map((f) => f.name)}]`);
  // classify: cond (+1 cog), 2 non-default clauses (+2 CC), `and` (+1 CC, +1 cog)
  assert.deepEqual([c.cyclomatic, c.cognitive, c.params, c.kind], [4, 2, 2, 'method']);
  // loop: for (+1,+1), if at level 1 (+1, +2), `and` (+1,+1), else (+0,+1)
  assert.deepEqual([l.cyclomatic, l.cognitive, l.maxNesting], [4, 5, 2]);
  assert.equal(a.classes[0]?.methods, 2);
});

test('golden metrics: mixed.js (switch, ternary, catch, lambda, mixed && ||)', async () => {
  const a = await run('mixed.js');
  assert.equal(a.functions.length, 1, 'the inner arrow function must NOT be a separate unit');
  const f = a.functions[0];
  // CC  = 1 + case1 + ternary + case2 + catch + if + && + ||           = 8
  // Cog = switch 1 + ternary(L1) 2 + catch 1 + if(L2: catch+lambda) 3
  //       + two different logical sequences 2                          = 9
  assert.deepEqual([f.name, f.cyclomatic, f.cognitive, f.maxNesting, f.params], ['mixed', 8, 9, 2, 3]);
});

test('golden metrics: mixed.py (match/case _, ternary, except, and/or)', async () => {
  const a = await run('mixed.py');
  const f = a.functions[0];
  // CC  = 1 + case 1 + ternary + except + if + and + or                = 7
  // Cog = match 1 + ternary(L1) 2 + except 1 + if(L1) 2 + and/or seqs 2 = 8
  assert.deepEqual([f.cyclomatic, f.cognitive, f.maxNesting], [7, 8, 2]);
});

test('classes and methods: Java and C++', async () => {
  const j = await run('sample.java');
  assert.equal(j.classes.length, 1);
  assert.equal(j.classes[0].methods, 2);
  assert.ok(j.functions.every((f) => f.kind === 'method'));
  const c = await run('sample.cpp');
  assert.equal(c.classes[0].methods, 1);
  assert.equal(c.functions.find((f) => f.name === 'loop')!.kind, 'function');
});

test('tier 2: Pascal gets generic analysis', async () => {
  const a = await run('sample.pas');
  assert.equal(a.tier, 2);
  assert.equal(a.functions.length, 0);
  assert.ok(a.sloc >= 9 && a.commentLines === 1, `sloc=${a.sloc} comments=${a.commentLines}`);
  assert.equal(a.todos.length, 1);
  assert.ok(a.tokenIds.length > 20);
  assert.ok(a.indentNesting && a.indentNesting.depth >= 2);
});

test('tier 3: generated and minified files are skipped', async () => {
  const gen = await analyze(parser, 'python', 'x.py', '# Auto-generated by protoc. DO NOT EDIT.\nx = 1\n');
  assert.deepEqual([gen.tier, gen.skipReason], [3, 'generated']);
  const min = await analyze(parser, 'javascript', 'a.js', 'var a=1;'.repeat(1000));
  assert.deepEqual([min.tier, min.skipReason], [3, 'minified']);
});

test('syntax errors are flagged but still analyzed', async () => {
  const a = await analyze(parser, 'python', 'broken.py', 'def f(x):\n    if x:\n        return (\n');
  assert.equal(a.tier, 1);
  assert.equal(a.hasSyntaxErrors, true);
});

test('determinism: same input -> identical output', async () => {
  const a = await run('mixed.js');
  const b = await run('mixed.js');
  const strip = (x: typeof a) => JSON.stringify({ ...x, analysisMs: 0, tokenIds: [...x.tokenIds], tokenLines: [...x.tokenLines] });
  assert.equal(strip(a), strip(b));
});

test('notebook: code cells analyzed as Python', async () => {
  const nb = JSON.stringify({ cells: [
    { cell_type: 'markdown', source: ['# Title'] },
    { cell_type: 'code', source: ['!pip install x\n', 'def load(p):\n', '    if p:\n', '        return 1\n'] },
  ] });
  const a = await analyze(parser, 'notebook:python', 'n.ipynb', nb);
  assert.equal(a.tier, 1);
  assert.equal(a.functions.length, 1);
  assert.equal(a.functions[0].name, 'load (cell 2)');
});

test('stability: every grammar gives identical results on repeated parses', async () => {
  // Regression test: the tree-sitter-wasms Lua build broke after its first
  // parse (found 11 Sep 2026). Parse every sample 3x, interleaved, and
  // require identical metrics each time.
  const files = STANDARD.map((s) => s[0]).concat(['sample.ex']);
  const first = new Map<string, string>();
  for (let round = 0; round < 3; round++) {
    for (const f of files) {
      const a = await run(f);
      const sig = JSON.stringify([a.hasSyntaxErrors, a.functions.map((x) => [x.name, x.cyclomatic, x.cognitive, x.maxNesting])]);
      if (round === 0) first.set(f, sig);
      else assert.equal(sig, first.get(f), `${f} changed on parse #${round + 1}`);
    }
  }
});
