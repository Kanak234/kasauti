/* =============================================================================
 * KASAUTI — prove/core.ts   (v2.0 "Parakh")
 * -----------------------------------------------------------------------------
 * WHAT:  The pure (no I/O) half of "Prove Complexity":
 *          extractFunction()  — cut one function (plus what it needs) out of a file
 *          guessInputKind()   — pick a sensible input shape from parameter names
 *          sizesFor()         — which n values to measure
 *          fitComplexity()    — turn (n, time) points into "O(n²)"
 * WHY:   Kept free of child processes and vscode so every decision here is
 *        unit-tested with synthetic data (test/prove.test.ts). The impure
 *        half (spawning Python/Node) is prove/runner.ts.
 * FLOW:  host command / MCP tool -> extractFunction -> runner.bench(...)
 *        -> fitComplexity(points) -> proof webview / tool result.
 * ========================================================================== */

import type { FunctionMetrics } from '../engine/types';

export type ProveLanguage = 'python' | 'javascript';
export const INPUT_KINDS = ['list_int', 'sorted_list_int', 'list_int_target', 'two_lists', 'string', 'two_strings', 'list_str', 'matrix', 'int'] as const;
export type InputKind = typeof INPUT_KINDS[number];

/** Plain-language labels for the quick pick. */
export const INPUT_LABELS: Record<InputKind, string> = {
  list_int: 'f(list of n integers)', sorted_list_int: 'f(sorted list of n integers)', list_int_target: 'f(list of n integers, target)',
  two_lists: 'f(list, list) — both of size n', string: 'f(string of length n)', two_strings: 'f(string, string) — both length n',
  list_str: 'f(list of n short strings)', matrix: 'f(√n × √n grid)', int: 'f(n) — a single integer',
};

export function proveLanguage(languageKey: string): ProveLanguage | undefined {
  if (languageKey === 'python' || languageKey === 'notebook:python') return 'python';
  if (languageKey === 'javascript') return 'javascript';
  return undefined;   // TypeScript needs a compiler we do not ship; Java needs javac (SPEC OD-15)
}

/* ---------------------------------------------------------------------------
 * Extraction
 * ------------------------------------------------------------------------- */
export interface Extracted {
  /** Runnable module: imports + helper functions + the target function. */
  code: string;
  /** Everything except the target (so an AI candidate can be swapped in). */
  preamble: string;
  /** The target function alone, dedented (what the AI is shown and rewrites). */
  target: string;
  name: string;
  params: string[];
  error?: string;
}

/** Parameter names from a def/function header line(s). Defaults and types dropped. */
export function paramNames(header: string): string[] {
  const m = /\(([\s\S]*?)\)\s*(?:->[^:]*)?[:{=]/.exec(header) ?? /\(([\s\S]*?)\)/.exec(header);
  if (!m) return [];
  return m[1].split(',').map((p) => p.trim().replace(/^[*]+/, '').split(/[:=\s]/)[0]).filter((p) => p && p !== '/' && p !== '*');
}

/** Strip the common leading indentation (methods of a class are refused anyway). */
function dedent(lines: string[]): string[] {
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
  return lines.map((l) => l.slice(Number.isFinite(ind) ? ind : 0));
}

/**
 * Cut `target` out of `source` so it can run alone.
 * Included alongside it: every top-level import line and every OTHER top-level
 * function (helpers it may call), with their decorators. NOT included: any
 * other module-level statement, because those may do I/O (input(), open(),
 * network) — running a file's top level as a side effect of measuring one
 * function would be a nasty surprise.
 */
export function extractFunction(source: string, language: ProveLanguage, fns: FunctionMetrics[], target: FunctionMetrics): Extracted {
  const lines = source.split(/\r?\n/);
  const header = lines.slice(target.startLine, Math.min(target.endLine + 1, target.startLine + 6)).join('\n');
  const name = target.name.replace(/ \(cell \d+\)$/, '');
  const params = paramNames(header);
  if (target.kind === 'method' || /^(self|cls|this)$/.test(params[0] ?? ''))
    return { code: '', preamble: '', target: '', name, params, error: `'${name}' is a method — it needs an object to run on. Prove works on stand-alone (top-level) functions.` };
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return { code: '', preamble: '', target: '', name, params, error: `'${name}' is an anonymous function — give it a name to prove it.` };

  // Top-level functions = not inside any other function's line range.
  const inside = (a: FunctionMetrics, b: FunctionMetrics) => a !== b && a.startLine >= b.startLine && a.endLine <= b.endLine;
  const topLevel = fns.filter((f) => f.kind !== 'method' && !fns.some((g) => inside(f, g)));
  if (!topLevel.includes(target)) return { code: '', preamble: '', target: '', name, params, error: `'${name}' is nested inside another function — move it to the top level to prove it alone.` };

  const block = (f: FunctionMetrics) => {
    let start = f.startLine;
    if (language === 'python') while (start > 0 && /^\s*@/.test(lines[start - 1])) start--;   // keep @lru_cache etc.
    return dedent(lines.slice(start, f.endLine + 1)).join('\n');
  };
  const imports = language === 'python'
    ? lines.filter((l) => /^(import|from)\s+[\w.]+/.test(l) && !/^from\s+\./.test(l))
    : lines.filter((l) => /^(const|let|var)\s+[\w{}\s,]+=\s*require\(\s*['"][^'"./][^'"]*['"]\s*\)/.test(l));
  const helpers = topLevel.filter((f) => f !== target).map(block);
  const preamble = [...imports, '', ...helpers, ''].join('\n');
  const body = block(target);
  return { code: `${preamble}\n${body}\n`, preamble, target: body, name, params };
}

/* ---------------------------------------------------------------------------
 * Inputs
 * ------------------------------------------------------------------------- */
const INT_NAMES = /^(n|num|number|k|count|size|limit|steps|depth|level|x|i)$/i;
const STR_NAMES = /^(s|str_?|text|string|word|sentence|line|pattern|pat|haystack|needle|t|s1|s2)$/i;
const STRLIST_NAMES = /^(words|names|strs|strings|tokens|lines|sentences)$/i;
const GRID_NAMES = /^(matrix|grid|board|mat|image|img|table)$/i;

/** Best guess of the input shape from parameter names. The user can override. */
export function guessInputKind(params: string[]): InputKind {
  const [a, b] = params;
  if (params.length === 1) {
    if (INT_NAMES.test(a)) return 'int';
    if (STR_NAMES.test(a)) return 'string';
    if (STRLIST_NAMES.test(a)) return 'list_str';
    if (GRID_NAMES.test(a)) return 'matrix';
    return 'list_int';
  }
  if (params.length >= 2) {
    if (STR_NAMES.test(a) && STR_NAMES.test(b)) return 'two_strings';
    if (/^(target|k|x|value|val|key|t|goal|item)$/i.test(b)) return 'list_int_target';
    return 'two_lists';
  }
  return 'int';
}

/** n values to measure. Integers grow linearly (exponential code explodes
 *  fast — fib(64) would never return); collections grow geometrically. */
export function sizesFor(kind: InputKind): number[] {
  if (kind === 'int') return Array.from({ length: 30 }, (_, i) => 2 + i * 2);       // 2..60
  return Array.from({ length: 13 }, (_, i) => 2 ** (i + 4));                          // 16..65536
}

/* ---------------------------------------------------------------------------
 * Fitting
 * ------------------------------------------------------------------------- */
export interface Point { n: number; t: number }
export interface ModelFit { label: string; error: number; a: number; b: number }
export interface Fit { best: string; ranked: ModelFit[]; slope: number; used: number; confidence: 'high' | 'medium' | 'low'; note?: string }

const LOG2 = (n: number) => Math.log2(Math.max(2, n));
export const MODELS: Array<[string, (n: number) => number]> = [
  ['O(1)', () => 1],
  ['O(log n)', (n) => LOG2(n)],
  ['O(n)', (n) => n],
  ['O(n log n)', (n) => n * LOG2(n)],
  ['O(n²)', (n) => n * n],
  ['O(n³)', (n) => n * n * n],
  ['O(2ⁿ)', (n) => 2 ** n],
];

/**
 * Fit t ≈ a + b·f(n) for every model and pick the one with the smallest
 * RELATIVE error. Relative, because times span many orders of magnitude: an
 * absolute least-squares fit would only care about the largest point.
 * The constant `a` absorbs fixed call overhead, so O(1) code is not mistaken
 * for O(log n) just because the first calls are slightly slower.
 */
export function fitComplexity(points: Point[]): Fit {
  // Drop timer-noise points (< 2 µs), keep the larger half where growth shows.
  const usable = points.filter((p) => p.t > 2e-6 && p.n > 0).sort((x, y) => x.n - y.n);
  const pts = usable.length > 6 ? usable.slice(Math.floor(usable.length / 3)) : usable;
  if (pts.length < 3) {
    return { best: 'O(1)', ranked: [], slope: 0, used: pts.length, confidence: 'low',
      note: 'The function ran too fast to measure growth (under 2 µs per call at every size). Treat it as constant time, or give it bigger inputs.' };
  }
  const maxN = pts[pts.length - 1].n;
  const ranked: ModelFit[] = [];
  for (const [label, f] of MODELS) {
    if (label === 'O(2ⁿ)' && maxN > 60) continue;                   // 2^n overflows and is meaningless here
    // Weighted least squares with weights 1/t²  ==  minimise Σ((t − a − b·f)/t)².
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of pts) { const w = 1 / (p.t * p.t), x = f(p.n); sw += w; sx += w * x; sy += w * p.t; sxx += w * x * x; sxy += w * x * p.t; }
    const det = sw * sxx - sx * sx;
    let b = Math.abs(det) < 1e-300 ? 0 : (sw * sxy - sx * sy) / det;
    let a = (sy - b * sx) / sw;
    if (b < 0) { b = 0; a = sy / sw; }                                 // time never shrinks as n grows
    if (a < 0) { a = 0; b = sxx > 0 ? sxy / sxx : 0; }
    const error = Math.sqrt(pts.reduce((s, p) => s + ((p.t - a - b * f(p.n)) / p.t) ** 2, 0) / pts.length);
    ranked.push({ label, error, a, b });
  }
  ranked.sort((x, y) => x.error - y.error);
  // Slope on a log–log plot: 1 ≈ linear, 2 ≈ quadratic. A second, model-free opinion.
  const lx = pts.map((p) => Math.log(p.n)), ly = pts.map((p) => Math.log(p.t));
  const mx = lx.reduce((a, b) => a + b, 0) / lx.length, my = ly.reduce((a, b) => a + b, 0) / ly.length;
  const slope = lx.reduce((s, x, i) => s + (x - mx) * (ly[i] - my), 0) / Math.max(1e-12, lx.reduce((s, x) => s + (x - mx) ** 2, 0));
  const [first, second] = ranked;
  const gap = second ? second.error / Math.max(1e-9, first.error) : Infinity;
  const confidence = first.error < 0.15 && gap > 1.5 ? 'high' : first.error < 0.3 ? 'medium' : 'low';
  const note = confidence === 'low' ? 'Timings were noisy (another program busy?). Run it again before trusting the label.'
    : second && gap < 1.25 ? `${first.label} and ${second.label} fit almost equally well at these sizes.` : undefined;
  return { best: first.label, ranked, slope, used: pts.length, confidence, note };
}

/** Rank of a complexity label, to say whether a fix made growth better/worse. */
export const orderRank = (label: string) => MODELS.findIndex(([l]) => l === label);
