/* =============================================================================
 * KASAUTI — test/prove.test.ts   (v2.0)
 * -----------------------------------------------------------------------------
 * WHAT:  (1) The curve fitter on synthetic timings with known growth.
 *        (2) Function extraction rules (methods refused, helpers included).
 *        (3) End-to-end: real Python and Node runs that must label a linear
 *            function O(n), a quadratic one O(n²), and catch a wrong "fix".
 * WHY:   "Proven" is the promise of v2. If the fitter mislabels clean data or
 *        the equivalence check misses a wrong answer, that promise is false.
 * FLOW:  `npm test`. Python tests are skipped (not failed) if no python3.
 * ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { execSync } from 'child_process';
import { extractFunction, fitComplexity, guessInputKind, paramNames } from '../src/prove/core';
import { bench, equivalent } from '../src/prove/runner';
import { analyze } from '../src/engine/analyzer';
import { ParserService } from '../src/engine/parser';

const parser = new ParserService(path.resolve(__dirname, '..', 'dist/wasm'));
const harnessDir = path.resolve(__dirname, '..', 'media/harness');
const hasPython = (() => { try { execSync('python3 -c "pass"', { stdio: 'ignore' }); return true; } catch { return false; } })();

test('fit: synthetic growth curves get the right label', () => {
  const ns = [64, 128, 256, 512, 1024, 2048, 4096, 8192];
  const make = (f: (n: number) => number) => ns.map((n) => ({ n, t: 3e-6 + f(n) * (1 + 0.03 * Math.sin(n)) }));   // overhead + 3% noise
  assert.equal(fitComplexity(make((n) => 1e-8 * n)).best, 'O(n)');
  assert.equal(fitComplexity(make((n) => 1e-9 * n * n)).best, 'O(n²)');
  assert.equal(fitComplexity(make((n) => 1e-12 * n ** 3)).best, 'O(n³)');
  assert.equal(fitComplexity(make((n) => 2e-8 * n * Math.log2(n))).best, 'O(n log n)');
  const exp = [10, 12, 14, 16, 18, 20, 22].map((n) => ({ n, t: 1e-7 * 2 ** n }));
  assert.equal(fitComplexity(exp).best, 'O(2ⁿ)');
  const flat = fitComplexity(ns.map((n) => ({ n, t: 1e-7 })));
  assert.equal(flat.confidence, 'low');                           // too fast to measure
});

test('extract: helpers and imports come along, methods are refused', async () => {
  const src = 'import math\nfrom collections import deque\n\ndef helper(x):\n    return x * 2\n\ndef main(xs):\n    return [helper(v) for v in xs]\n\nclass A:\n    def m(self, xs):\n        return xs\n\nprint("side effect")\n';
  const a = await analyze(parser, 'python', 'x.py', src);
  const main = a.functions.find((f) => f.name === 'main')!;
  const ex = extractFunction(src, 'python', a.functions, main);
  assert.equal(ex.error, undefined);
  assert.match(ex.code, /import math/);
  assert.match(ex.code, /def helper/);
  assert.ok(!ex.code.includes('side effect'), 'module-level statements must never be copied');
  const m = a.functions.find((f) => f.name === 'm')!;
  assert.match(extractFunction(src, 'python', a.functions, m).error!, /method/);
  assert.deepEqual(paramNames('def f(a, b: int = 3, *args, **kw) -> int:'), ['a', 'b', 'args', 'kw']);
  assert.equal(guessInputKind(['nums', 'target']), 'list_int_target');
  assert.equal(guessInputKind(['n']), 'int');
  assert.equal(guessInputKind(['s']), 'string');
});

test('prove (python): linear vs quadratic are told apart on real runs', { skip: !hasPython }, async () => {
  const opt = { harnessDir, python: 'python3', timeoutMs: 60_000 };
  const lin = await bench('python', 'def f(xs):\n    s = 0\n    for x in xs:\n        s += x\n    return s\n', 'f', 'list_int', opt, [256, 512, 1024, 2048, 4096, 8192, 16384, 32768]);
  assert.equal(lin.error, undefined);
  assert.ok(lin.fit, 'fit');
  assert.ok(['O(n)', 'O(n log n)'].includes(lin.fit!.best), `linear got ${lin.fit!.best}`);
  const quad = await bench('python', 'def f(xs):\n    c = 0\n    for a in xs:\n        for b in xs:\n            c += a < b\n    return c\n', 'f', 'list_int', opt, [32, 64, 128, 256, 384, 512, 768]);
  assert.equal(quad.fit?.best, 'O(n²)', JSON.stringify(quad.fit?.ranked.slice(0, 2)));
});

test('prove (python): equivalence catches a wrong optimisation and accepts a right one', { skip: !hasPython }, async () => {
  const opt = { harnessDir, python: 'python3' };
  const orig = 'def uniq(xs):\n    out = []\n    for x in xs:\n        if x not in out:\n            out.append(x)\n    return out\n';
  const wrong = 'def uniq(xs):\n    return list(set(xs))\n';                 // loses order -> must be caught
  const right = 'def uniq(xs):\n    return list(dict.fromkeys(xs))\n';       // same result, O(n)
  const bad = await equivalent('python', orig, wrong, 'uniq', 'list_int', opt);
  assert.equal(bad.equal, false);
  assert.ok(bad.mismatch?.input);
  const good = await equivalent('python', orig, right, 'uniq', 'list_int', opt);
  assert.equal(good.equal, true, JSON.stringify(good));
  assert.ok(good.checked >= 10);
});

test('prove (node): runs JS through the current runtime and detects a crash', async () => {
  const opt = { harnessDir, timeoutMs: 60_000 };
  const r = await bench('javascript', 'function f(xs) { let s = 0; for (const x of xs) s += x; return s; }', 'f', 'list_int', opt, [1024, 4096, 16384, 65536, 131072, 262144]);
  assert.equal(r.error, undefined, r.error);
  assert.ok(r.points.length >= 4);
  const eq = await equivalent('javascript', 'function f(xs){ return xs.length; }', 'function f(xs){ return xs[0].x; }', 'f', 'list_int', opt);
  assert.equal(eq.equal, false);
  assert.match(eq.mismatch!.candidate, /threw TypeError/);
});

test('prove: a function that never returns is killed at the timeout, points kept', { skip: !hasPython }, async () => {
  const t0 = Date.now();
  const r = await bench('python', 'def f(n):\n    if n < 2:\n        return n\n    return f(n - 1) + f(n - 2)\n', 'f', 'int', { harnessDir, python: 'python3', timeoutMs: 8000 });
  assert.ok(Date.now() - t0 < 15_000, 'must not hang');
  assert.ok(r.points.length >= 5, 'points measured before the explosion are kept');
  assert.equal(r.fit?.best, 'O(2ⁿ)', JSON.stringify(r.fit?.ranked.slice(0, 3)));
});
