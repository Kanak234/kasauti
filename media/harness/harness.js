// =============================================================================
// KASAUTI — media/harness/harness.js   (v2.0 "Parakh")
// -----------------------------------------------------------------------------
// WHAT:  JavaScript twin of harness.py: `bench` times one function at growing
//        n, `equiv` checks that two versions return identical results.
// WHY:   Same reasons as the Python harness — evidence instead of estimates,
//        and no AI "optimisation" accepted unless it behaves identically.
// FLOW:  src/prove/runner.ts runs `node <this file>` (inside VS Code: the
//        editor's own runtime with ELECTRON_RUN_AS_NODE=1, so no Node install
//        is needed), sends one JSON request on stdin, reads JSON lines back.
// SAFETY: code runs in a separate vm context (its own globals) inside a
//        separate process with a timeout. vm is NOT a security boundary; the
//        host only runs code that passed the static audit (SPEC OD-14).
// =============================================================================
'use strict';
const vm = require('vm');
const util = require('util');

/** One JSON object per line; the runner may kill us at any moment. */
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

/** Small seeded PRNG (mulberry32): same seed -> same inputs on every machine. */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), pick: (s) => s[Math.floor(next() * s.length)] };
}

/** Evaluate the extracted code in a fresh context and return the function. */
function load(code, fn) {
  const sandbox = { console, Math, JSON, Map, Set, Array, Object, Number, String, Boolean, require, module: { exports: {} } };
  vm.createContext(sandbox);
  vm.runInContext(`${code}\n;globalThis.__kasauti_fn = (typeof ${fn} !== 'undefined') ? ${fn} : module.exports.${fn};`, sandbox, { timeout: 5000 });
  if (typeof sandbox.__kasauti_fn !== 'function') throw new Error(`function '${fn}' is not defined by the code`);
  return sandbox.__kasauti_fn;
}

/** Argument array of size n for the chosen input shape (mirrors harness.py). */
function make(kind, n, r) {
  const ints = (k, lo, hi) => Array.from({ length: k }, () => r.int(lo, hi));
  const str = (k, alpha) => Array.from({ length: k }, () => r.pick(alpha)).join('');
  switch (kind) {
    case 'list_int': return [ints(n, -n, n)];
    case 'sorted_list_int': return [ints(n, -n, n).sort((a, b) => a - b)];
    case 'list_int_target': return [ints(n, -n, n), r.int(-n, n)];
    case 'two_lists': return [ints(n, 0, n), ints(n, 0, n)];
    case 'string': return [str(n, 'abcde ')];
    case 'two_strings': return [str(n, 'abc'), str(n, 'abc')];
    case 'list_str': return [Array.from({ length: n }, () => str(3, 'abc'))];
    case 'matrix': { const k = Math.max(1, Math.round(Math.sqrt(n))); return [Array.from({ length: k }, () => ints(k, 0, 9))]; }
    case 'int': return [n];
    default: throw new Error(`unknown input kind '${kind}'`);
  }
}

function edgeCases(kind) {
  switch (kind) {
    case 'list_int': case 'sorted_list_int': return [[[]], [[7]], [[3, 3, 3]], [[-1, -5, 0]], [[1, 2, 3, 4]], [[4, 3, 2, 1]]];
    case 'list_int_target': return [[[], 1], [[5], 5], [[2, 2, 2], 2], [[1, -1], 0], [[1, 2, 3], 99]];
    case 'two_lists': return [[[], []], [[1], []], [[], [1]], [[1, 1], [1]], [[3, 2, 1], [1, 2, 3]]];
    case 'string': return [[''], ['a'], ['aaaa'], ['ab ba'], ['  ']];
    case 'two_strings': return [['', ''], ['a', ''], ['', 'a'], ['ab', 'ba'], ['aaa', 'aa']];
    case 'list_str': return [[[]], [['a']], [['a', 'a']], [['b', 'a', 'c']]];
    case 'matrix': return [[[[1]]], [[[1, 2], [3, 4]]], [[[0, 0], [0, 0]]]];
    case 'int': return [[0], [1], [2], [3], [10]];
    default: return [];
  }
}

/** Run on a deep copy so mutation cannot leak between runs. */
function call(f, args) {
  const a = structuredClone(args);
  try { return { ok: true, v: f(...a), args: a }; } catch (e) { return { ok: false, v: (e && e.constructor && e.constructor.name) || 'Error' }; }
}
const same = (x, y) => (typeof x === 'number' && typeof y === 'number')
  ? (x === y || Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y)) || (Number.isNaN(x) && Number.isNaN(y)))
  : util.isDeepStrictEqual(x, y);
const short = (v) => { const s = util.inspect(v, { depth: 3, breakLength: Infinity }); return s.length > 200 ? s.slice(0, 200) + '…' : s; };

function bench(req) {
  const f = load(req.code, req.fn);
  const r = rng(req.seed ?? 7);
  const budget = (req.budgetSec ?? 1) * 1000, limit = (req.totalSec ?? 15) * 1000;
  const start = performance.now();
  for (const n of req.sizes) {
    const args = make(req.kind, n, r);
    let best = Infinity, reps = 0, spent = 0;
    // Minimum of several runs: the least-disturbed run is closest to true cost.
    while (reps < 25 && (reps < 3 || spent < 50)) {
      const a = structuredClone(args);
      const t0 = performance.now(); f(...a); const dt = performance.now() - t0;
      best = Math.min(best, dt); spent += dt; reps++;
      if (dt > budget) break;
    }
    emit({ type: 'point', n, t: best / 1000, reps });
    if (best > budget || performance.now() - start > limit) break;
  }
  emit({ type: 'done' });
}

function equiv(req) {
  const fa = load(req.codeA, req.fn), fb = load(req.codeB, req.fn);
  const r = rng(req.seed ?? 11);
  const cases = [...edgeCases(req.kind), ...(req.sizes ?? [0, 1, 2, 3, 5, 8, 13, 21, 50, 120]).map((n) => make(req.kind, n, r))];
  let checked = 0;
  for (const args of cases) {
    const a = call(fa, args), b = call(fb, args);
    checked++;
    const ok = a.ok === b.ok && same(a.v, b.v) && (!a.ok || same(a.args, b.args));
    if (!ok) {
      emit({ type: 'mismatch', input: short(args), original: a.ok ? short(a.v) : `threw ${a.v}`, candidate: b.ok ? short(b.v) : `threw ${b.v}`, sideEffect: a.ok && b.ok && same(a.v, b.v) });
      break;
    }
  }
  emit({ type: 'done', checked });
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try { const req = JSON.parse(input); (req.mode === 'bench' ? bench : equiv)(req); }
  catch (e) { emit({ type: 'error', error: `${(e && e.name) || 'Error'}: ${(e && e.message) || e}` }); }
});
