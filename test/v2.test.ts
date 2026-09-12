/* =============================================================================
 * KASAUTI — test/v2.test.ts
 * -----------------------------------------------------------------------------
 * Covers everything v0.2.0 added, plus the one test that matters most:
 * GRADE INVARIANCE. v0.2.0 promised no metric and no grade boundary would
 * change. These fixtures were graded by the v0.1.0 engine; if any grade here
 * moves, the promise is broken and the release must not ship.
 * ========================================================================== */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Worker } from 'node:worker_threads';
import { analyze } from '../src/engine/analyzer';
import { detectLanguage } from '../src/engine/languages';
import { ParserService } from '../src/engine/parser';
import { scoreOf } from '../src/engine/scoring';
import { DEFAULT_THRESHOLDS } from '../src/engine/rules';
import { applySuppressions, parseDirectives, suppressionComment } from '../src/engine/suppress';
import { ResultStore } from '../src/store';
import {
  evaluateGate, mergeThresholds, parsePackageJsonConfig, parseProjectConfig, thresholdSources,
} from '../src/config/projectConfig';
import { compact, History, HistorySample, MAX_SAMPLES, sparklinePath } from '../src/history';
import { safeSplitPoint } from '../src/fixes/split';
import { matchesFilter } from '../webview/filter';

const DIST = path.join(__dirname, '..', 'dist');
const TEST_DIR = path.join(__dirname, '..', 'test');   // __dirname is dist-test at runtime
const parser = new ParserService(path.join(DIST, 'wasm'));

/* =============================================================================
 * 1. GRADE INVARIANCE — the release gate for v0.2.0
 * ========================================================================== */

/**
 * The strongest form of the promise: run the SHIPPED v0.1.0 worker and the
 * current worker over the same corpus and require every metric to be
 * identical. No hand-copied expected numbers — those only prove that someone
 * typed today's output into a test file.
 *
 * test/fixtures/worker-0.1.0.js is lifted verbatim from kasauti-0.1.0.vsix.
 * Both runs share dist/wasm: the grammar versions did not change in v0.2.0,
 * so the parsers are the same and any difference is ours.
 */
function runWorker(workerPath: string, lang: string, name: string, text: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerPath, { workerData: { wasmDir: path.join(DIST, 'wasm') } });
    const done = (fn: () => void) => { void w.terminate(); fn(); };
    w.on('message', (m: { ok: boolean; analysis?: Record<string, unknown>; error?: string }) =>
      done(() => (m.ok && m.analysis ? resolve(m.analysis) : reject(new Error(m.error ?? 'worker failed')))));
    w.on('error', (e) => done(() => reject(e)));
    w.postMessage({ id: 1, languageKey: lang, path: name, text });
  });
}

/** Fields that must be bit-identical between the two engine versions. */
const METRIC_FIELDS = ['sloc', 'lines', 'commentLines', 'tier', 'hasSyntaxErrors'] as const;
const FUNCTION_FIELDS = ['name', 'startLine', 'endLine', 'params', 'cyclomatic', 'cognitive', 'maxNesting', 'sloc', 'mi'] as const;

test('grade invariance: every metric matches the shipped v0.1.0 engine', { timeout: 300_000 }, async () => {
  const v1 = path.join(TEST_DIR, 'fixtures', 'worker-0.1.0.js');
  assert.ok(fs.existsSync(v1), 'the v0.1.0 worker fixture is missing');
  const samples = fs.readdirSync(path.join(TEST_DIR, 'samples')).filter((f) => !f.startsWith('.'));
  assert.ok(samples.length >= 20, `expected the full sample corpus, found ${samples.length}`);

  let compared = 0;
  for (const file of samples) {
    const full = path.join(TEST_DIR, 'samples', file);
    const text = fs.readFileSync(full, 'utf8');
    const lang = detectLanguage(full, []);
    if (!lang) continue;
    const [before, after] = await Promise.all([
      runWorker(v1, lang, file, text),
      runWorker(path.join(DIST, 'worker.js'), lang, file, text),
    ]);
    for (const f of METRIC_FIELDS) {
      assert.deepEqual(after[f], before[f], `${file}: ${f} changed from ${String(before[f])} to ${String(after[f])}`);
    }
    const fnsBefore = (before.functions ?? []) as Array<Record<string, unknown>>;
    const fnsAfter = (after.functions ?? []) as Array<Record<string, unknown>>;
    assert.equal(fnsAfter.length, fnsBefore.length, `${file}: function count changed`);
    fnsBefore.forEach((fn, i) => {
      for (const k of FUNCTION_FIELDS) {
        assert.deepEqual(fnsAfter[i][k], fn[k], `${file}: ${String(fn.name)}.${k} changed`);
      }
    });
    compared++;
  }
  assert.ok(compared >= 20, `only ${compared} files were compared`);
});

test('grade invariance: the grade boundaries are exactly where v0.1.0 put them', () => {
  // SonarQube debt-ratio bands: A <= 5%, B <= 10%, C <= 20%, D <= 50%, else E.
  // A change here silently re-grades every project that ever used KASAUTI.
  const at = (ratio: number) => scoreOf(ratio * 30 * 100, 100).grade;   // 100 SLOC x 30 min
  assert.equal(at(0), 'A');
  assert.equal(at(0.05), 'A');
  assert.equal(at(0.0501), 'B');
  assert.equal(at(0.10), 'B');
  assert.equal(at(0.1001), 'C');
  assert.equal(at(0.20), 'C');
  assert.equal(at(0.2001), 'D');
  assert.equal(at(0.50), 'D');
  assert.equal(at(0.5001), 'E');
  assert.equal(scoreOf(0, 0).grade, 'A', 'an empty file is not a failure');
});

/* =============================================================================
 * 2. Suppressions (F4 R4.5)
 * ========================================================================== */

test('suppress: directives are recognised in every comment style', () => {
  assert.deepEqual(parseDirectives('// kasauti-disable-next-line CQ001', 4),
    [{ scope: 'nextLine', line: 4, rules: ['CQ001'] }]);
  assert.deepEqual(parseDirectives('# kasauti-disable-line CQ001, CQ010', 0),
    [{ scope: 'line', line: 0, rules: ['CQ001', 'CQ010'] }]);
  assert.deepEqual(parseDirectives('/* kasauti-disable-file */', 0),
    [{ scope: 'file', line: 0, rules: [] }]);
  // no ids means "every rule"
  assert.deepEqual(parseDirectives('-- kasauti-disable-next-line', 2),
    [{ scope: 'nextLine', line: 2, rules: [] }]);
  // ordinary comments are untouched
  assert.deepEqual(parseDirectives('// just a note about kasauti', 0), []);
});

test('suppress: findings are filtered by scope and rule id', () => {
  const f = (line: number, ruleId: string) => ({
    ruleId, line, endLine: line, col: 0, endCol: 1,
    severity: 'major' as const, message: '', debtMinutes: 10,
  });
  const findings = [f(3, 'CQ001'), f(3, 'CQ002'), f(9, 'CQ001')];
  assert.equal(applySuppressions(findings, [{ scope: 'nextLine', line: 2, rules: ['CQ001'] }]).length, 2);
  assert.equal(applySuppressions(findings, [{ scope: 'line', line: 3, rules: [] }]).length, 1);
  assert.equal(applySuppressions(findings, [{ scope: 'file', line: 0, rules: [] }]).length, 0);
  assert.equal(applySuppressions(findings, [{ scope: 'file', line: 0, rules: ['CQ001'] }]).length, 1);
  assert.equal(applySuppressions(findings, []).length, 3);
});

test('suppress: a suppressed finding costs no debt, end to end', async () => {
  const bad = 'function wide(a, b, c, d, e, f, g, h, i) {\n  return a;\n}\n';
  const withDirective = '// kasauti-disable-next-line CQ004\n' + bad;
  const grade = async (text: string) => {
    const store = new ResultStore(DEFAULT_THRESHOLDS, true);
    store.set('file:///s.js', 's.js', await analyze(parser, 'javascript', 's.js', text), true);
    return store.get('file:///s.js')!;
  };
  const before = await grade(bad);
  const after = await grade(withDirective);
  assert.ok(before.findings.length > 0, 'the fixture must produce a finding to suppress');
  assert.equal(after.findings.length, before.findings.length - 1);
  assert.ok(after.score.debtMinutes < before.score.debtMinutes, 'debt must fall when a finding is silenced');
});

test('suppress: the comment syntax matches the language', () => {
  assert.equal(suppressionComment('python', 'CQ001'), '# kasauti-disable-next-line CQ001');
  assert.equal(suppressionComment('lua', 'CQ001'), '-- kasauti-disable-next-line CQ001');
  assert.equal(suppressionComment('typescript', 'CQ001'), '// kasauti-disable-next-line CQ001');
  assert.equal(suppressionComment('ocaml', 'CQ001'), '(* kasauti-disable-next-line CQ001 *)');
});

/* =============================================================================
 * 3. Project configuration and the gate (F5)
 * ========================================================================== */

test('config: a valid file is read, and precedence is default < file < setting', () => {
  const cfg = parseProjectConfig(`
[thresholds]
cyclomatic = 5
lineLength = 100
exclude = ["**/gen/**"]
`);
  assert.equal(cfg.problems.length, 0);
  assert.equal(cfg.thresholds.cyclomatic, 5);
  const merged = mergeThresholds(cfg.thresholds, { cyclomatic: 20 });
  assert.equal(merged.cyclomatic, 20, 'an explicit setting beats the project file');
  assert.equal(merged.lineLength, 100, 'the project file beats the default');
  assert.equal(merged.nesting, DEFAULT_THRESHOLDS.nesting, 'untouched values stay at the default');
  const src = thresholdSources(cfg.thresholds, { cyclomatic: 20 });
  assert.equal(src.cyclomatic, 'VS Code setting');
  assert.equal(src.lineLength, 'project file');
  assert.equal(src.nesting, 'default');
});

test('config: a malformed file reports every problem and still yields usable values', () => {
  const cfg = parseProjectConfig(`
[thresholds]
cyclomatic = "ten"
this line is nonsense
lineLength = 90
[gate]
minGrade = "Z"
maxDebtRatio = 500
failOn = ["CQ001", "nope"]
`);
  assert.ok(cfg.problems.length >= 4, `expected several problems, got ${cfg.problems.length}`);
  assert.equal(cfg.thresholds.cyclomatic, undefined, 'the bad value is dropped, not guessed');
  assert.equal(cfg.thresholds.lineLength, 90, 'the good value survives');
  assert.equal(cfg.gate?.minGrade, undefined);
  assert.equal(cfg.gate?.maxDebtRatio, undefined);
  assert.deepEqual(cfg.gate?.failOn, ['CQ001'], 'only real rule ids are kept');
});

test('config: package.json carries the same settings', () => {
  const cfg = parsePackageJsonConfig({ kasauti: { thresholds: { cyclomatic: 4 }, exclude: ['a/**'], gate: { minGrade: 'B' } } });
  assert.equal(cfg?.thresholds.cyclomatic, 4);
  assert.deepEqual(cfg?.exclude, ['a/**']);
  assert.equal(cfg?.gate?.minGrade, 'B');
  assert.equal(parsePackageJsonConfig({ name: 'x' }), undefined);
});

test('gate: off by default, and every rule is enforced when it is on', () => {
  const input = { grade: 'D' as const, debtRatio: 0.3, firedRules: new Set(['CQ001']) };
  assert.equal(evaluateGate(undefined, input).pass, true, 'no gate configured means no gate');
  assert.equal(evaluateGate({ failOn: [] }, input).pass, true, 'an empty gate passes everything');
  assert.equal(evaluateGate({ failOn: [], minGrade: 'C' }, input).pass, false);
  assert.equal(evaluateGate({ failOn: [], minGrade: 'E' }, input).pass, true);
  assert.equal(evaluateGate({ failOn: [], maxDebtRatio: 20 }, input).pass, false);
  assert.equal(evaluateGate({ failOn: [], maxDebtRatio: 40 }, input).pass, true);
  assert.equal(evaluateGate({ failOn: ['CQ001'] }, input).pass, false);
  assert.equal(evaluateGate({ failOn: ['CQ099'] }, input).pass, true);
  const all = evaluateGate({ failOn: ['CQ001'], minGrade: 'A', maxDebtRatio: 1 }, input);
  assert.equal(all.reasons.length, 3, 'every failing condition is reported, not just the first');
});

/* =============================================================================
 * 4. The CLI (F5) — exit codes, and that it agrees with the extension
 * ========================================================================== */

function withTempProject(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasauti-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }
    fn(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function runCli(dir: string, args: string[]): { code: number; out: string; err: string } {
  // spawnSync, not execFileSync: the latter returns stdout only, and the gate's
  // reasons and the config warnings are written to stderr.
  const r = spawnSync(process.execPath, [path.join(DIST, 'cli.js'), ...args], {
    cwd: dir, encoding: 'utf8',
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const HEAVY = 'def heavy(a, b, c, d, e, f, g, h, i):\n    t = 0\n'
  + [...Array(16)].map((_, i) => `    if a > ${i} and b < ${i}:\n        for x in range(${i}):\n            while x > 0:\n                t += ${i}\n`).join('')
  + '    return t\n';

test('cli: exit 0 with no gate, exit 1 when the gate fails, exit 0 with --no-gate', { timeout: 120_000 }, () => {
  withTempProject({ 'heavy.py': HEAVY }, (dir) => {
    assert.equal(runCli(dir, ['scan', '.', '--quiet']).code, 0, 'no gate configured must never fail a build');

    fs.writeFileSync(path.join(dir, '.kasauti.toml'), '[gate]\nfailOn = ["CQ001"]\n');
    const failed = runCli(dir, ['scan', '.', '--quiet']);
    assert.equal(failed.code, 1);
    assert.match(failed.err, /CQ001/);

    assert.equal(runCli(dir, ['scan', '.', '--quiet', '--no-gate']).code, 0);
  });
});

test('cli: a malformed config warns but still scans', { timeout: 120_000 }, () => {
  withTempProject({ 'heavy.py': HEAVY, '.kasauti.toml': '[thresholds]\ncyclomatic = "ten"\n' }, (dir) => {
    const r = runCli(dir, ['scan', '.', '--quiet']);
    assert.equal(r.code, 0);
    assert.match(r.err, /cyclomatic/);
    assert.match(r.out, /KASAUTI [A-E]/);
  });
});

test('cli: init writes a config with the gate commented out', { timeout: 60_000 }, () => {
  withTempProject({}, (dir) => {
    assert.equal(runCli(dir, ['init', '.']).code, 0);
    const body = fs.readFileSync(path.join(dir, '.kasauti.toml'), 'utf8');
    assert.match(body, /\[thresholds\]/);
    assert.match(body, /#\s*\[gate\]/, 'the gate must ship commented out');
    assert.equal(runCli(dir, ['init', '.']).code, 2, 'an existing config is never overwritten');
  });
});

test('cli: the CLI and the extension engine produce the same grade', { timeout: 120_000 }, async () => {
  await withTempProjectAsync({ 'heavy.py': HEAVY }, async (dir) => {
    const cli = runCli(dir, ['scan', '.', '--quiet']);
    const m = /KASAUTI ([A-E]) · (\d+)\/100/.exec(cli.out);
    assert.ok(m, `could not read the CLI summary from: ${cli.out}`);

    const store = new ResultStore(DEFAULT_THRESHOLDS, true);
    store.set('file:///heavy.py', 'heavy.py', await analyze(parser, 'python', 'heavy.py', HEAVY), true);
    const ws = store.workspaceScore();
    assert.equal(m![1], ws.grade, 'CLI grade must match the editor grade');
    assert.equal(Number(m![2]), ws.score, 'CLI score must match the editor score');
  });
});

async function withTempProjectAsync(files: Record<string, string>, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasauti-'));
  try {
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    await fn(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/* =============================================================================
 * 5. History (F6)
 * ========================================================================== */

class MemStore {
  private data: HistorySample[] | undefined;
  get(): HistorySample[] | undefined { return this.data; }
  update(_k: string, v: HistorySample[] | undefined): void { this.data = v; }
}

const sample = (score: number) => ({ grade: 'C' as const, score, debtMinutes: 100, sloc: 1000, files: 10 });

test('history: records one sample per scan and collapses rapid repeats', () => {
  const h = new History(new MemStore());
  h.record(sample(50), 1_000_000);
  h.record(sample(60), 1_010_000);        // 10 s later: same scan burst
  assert.equal(h.series().length, 1);
  assert.equal(h.series()[0].score, 60, 'the later sample wins');
  h.record(sample(70), 1_200_000);        // 200 s later: a real second scan
  assert.equal(h.series().length, 2);
});

test('history: the ring buffer is capped and old samples roll up by month', () => {
  const h = new History(new MemStore());
  const now = Date.UTC(2026, 5, 1);
  for (let i = 0; i < 400; i++) h.record(sample(i % 100), now + i * 120_000);
  assert.ok(h.series().length <= MAX_SAMPLES, `series grew to ${h.series().length}`);

  const old: HistorySample[] = [...Array(40)].map((_, i) => ({
    t: Date.UTC(2025, 0, 1) + i * 3_600_000, grade: 'C', score: 50, debtMinutes: 10, sloc: 100, files: 1,
  }));
  const rolled = compact(old, now);
  assert.equal(rolled.length, 1, 'a month of old samples becomes one row');
  assert.equal(rolled[0].n, 40, 'the row remembers how many scans it represents');
  assert.equal(rolled[0].score, 50);
});

test('history: delta and sparkline', () => {
  const h = new History(new MemStore());
  h.record(sample(40), 1_000_000);
  h.record(sample(55), 2_000_000);
  h.record(sample(70), 3_000_000);
  assert.equal(h.delta().sinceStart, 30);
  assert.equal(h.delta().sinceLast, 15);
  const pts = sparklinePath(h.series(), 100, 20).split(' ');
  assert.equal(pts.length, 3);
  assert.equal(pts[0].split(',')[0], '0.0');
  assert.equal(pts[2].split(',')[0], '100.0');
  assert.equal(sparklinePath([], 100, 20), '', 'no line from no data');
  h.clear();
  assert.equal(h.series().length, 0);
});

/* =============================================================================
 * 6. Quick Fix line splitting (F4)
 * ========================================================================== */

test('fixes: a long line splits only at a genuinely safe point', () => {
  // splits after a top-level argument comma
  const call = 'const result = computeSomething(firstArgument, secondArgument, thirdArgument);';
  const at = safeSplitPoint(call);
  assert.ok(at !== undefined && call.slice(at).trim().startsWith('second' ) || call.slice(at!).trim().startsWith('third'),
    `unexpected split: ${JSON.stringify(call.slice(at!))}`);

  // never inside a string
  const str = 'const message = "one, two, three, four, five, six, seven, eight, nine, ten";';
  assert.equal(safeSplitPoint(str), undefined, 'a comma inside a string is not a split point');

  // never inside a comment
  assert.equal(safeSplitPoint('// a long explanatory comment, with commas, that must stay whole'), undefined);
  assert.equal(safeSplitPoint('# python comment, with a comma in it, staying whole'), undefined);

  // nothing to split
  assert.equal(safeSplitPoint('const x = 1;'), undefined);
  assert.equal(safeSplitPoint('foo(a)'), undefined);

  // unterminated string: refuse rather than guess
  assert.equal(safeSplitPoint('const s = "unterminated, with a comma'), undefined);
});

/* =============================================================================
 * 7. Pyramid filter (F7)
 * ========================================================================== */

const uiFile = (over: Partial<Record<string, unknown>> = {}) => ({
  key: 'k', path: 'src/api/handler.ts', lang: 'TypeScript', tier: 1, grade: 'C', score: 70,
  sloc: 100, debt: 30, maxCC: 5, maxCog: 6, dupLines: 0,
  counts: { critical: 0, major: 1, minor: 0, info: 0 }, rules: ['CQ001', 'CQ010'], ...over,
}) as never;

test('filter: grade, rule, path and partial terms, combined with AND', () => {
  const f = uiFile();
  assert.equal(matchesFilter(f, ''), true, 'an empty filter shows everything');
  assert.equal(matchesFilter(f, 'grade:C'), true);
  assert.equal(matchesFilter(f, 'grade:A'), false);
  assert.equal(matchesFilter(f, 'grade:>=B'), true, 'C is worse than B');
  assert.equal(matchesFilter(f, 'grade:>=D'), false);
  assert.equal(matchesFilter(f, 'rule:CQ001'), true);
  assert.equal(matchesFilter(f, 'rule:cq010'), true, 'case does not matter');
  assert.equal(matchesFilter(f, 'rule:CQ003'), false);
  assert.equal(matchesFilter(f, 'src/api'), true);
  assert.equal(matchesFilter(f, 'src/db'), false);
  assert.equal(matchesFilter(f, 'grade:C src/api'), true, 'terms combine with AND');
  assert.equal(matchesFilter(f, 'grade:A src/api'), false);
  assert.equal(matchesFilter(uiFile({ tier: 2 }), 'partial:yes'), true);
  assert.equal(matchesFilter(f, 'partial:yes'), false);
  // a nonsense term degrades to a text search rather than erroring
  assert.equal(matchesFilter(f, 'grade:'), false);
  assert.equal(matchesFilter(uiFile({ rules: undefined }), 'rule:CQ001'), false);
});
