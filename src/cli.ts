/* =============================================================================
 * KASAUTI — cli.ts   (v0.2.0, feature F5)
 * -----------------------------------------------------------------------------
 * WHAT:  `kasauti scan <dir>` — the same analysis, outside VS Code. Prints a
 *        table, optionally writes HTML/JSON/SARIF, and exits 1 if the project's
 *        gate fails.
 * WHY:   A quality tool a team cannot enforce stays a personal toy. This is
 *        what makes KASAUTI usable in GitHub Actions.
 * HOW:   Imports NOTHING from `vscode`. The v0.2.0 audit confirmed the whole
 *        analysis chain (engine, store, worker pool, cache, export) is already
 *        editor-independent, so this file reuses it verbatim — which is why the
 *        CLI and the extension cannot drift apart (test: cli.test.ts).
 * FLOW:  argv -> find files -> worker pool -> store -> report + gate -> exit
 *
 * Exit codes:  0 pass · 1 gate failed · 2 usage or runtime error
 * ========================================================================== */

import * as fs from 'fs';
import * as path from 'path';
import { detectLanguage, displayName } from './engine/languages';
import { DEFAULT_THRESHOLDS } from './engine/rules';
import { formatDebt } from './engine/scoring';
import { skipped } from './engine/analyzer';
import { toHTML, toJSON, toSARIF } from './export/report';
import { ResultStore } from './store';
import { WorkerPool } from './workerPool';
import { EMPTY_CONFIG, evaluateGate, mergeThresholds, parsePackageJsonConfig, parseProjectConfig, ProjectConfig, SAMPLE_CONFIG } from './config/projectConfig';

const VERSION = '0.2.0';
const DEFAULT_EXCLUDES = new Set(['node_modules', '.git', 'venv', '.venv', '__pycache__', 'dist', 'build', 'out',
  'target', 'bin', 'obj', '.next', 'vendor', 'Pods', '.gradle', 'coverage', '.dart_tool', '_build', '.terraform']);

const HELP = `KASAUTI ${VERSION} — code quality, measured the same way in CI and in the editor.

  kasauti scan [dir]        analyse a directory (default: .)
  kasauti init [dir]        write a starter .kasauti.toml
  kasauti --help            this text

Options for scan:
  --format <list>   comma-separated: table, json, sarif, html   (default: table)
  --out <path>      write the non-table report here (default: kasauti-report.<ext>)
  --min-grade <A-E> override the gate's minimum grade
  --no-gate         report only; always exit 0
  --quiet           print only the summary line

Exit codes: 0 pass · 1 gate failed · 2 error
`;

interface Args { cmd: string; dir: string; formats: string[]; out?: string; minGrade?: string; noGate: boolean; quiet: boolean }

function parseArgs(argv: string[]): Args {
  const a: Args = { cmd: 'scan', dir: '.', formats: ['table'], noGate: false, quiet: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--help' || t === '-h') { a.cmd = 'help'; return a; }
    else if (t === '--version' || t === '-v') { a.cmd = 'version'; return a; }
    else if (t === '--format') a.formats = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (t === '--out') a.out = argv[++i];
    else if (t === '--min-grade') a.minGrade = (argv[++i] ?? '').toUpperCase();
    else if (t === '--no-gate') a.noGate = true;
    else if (t === '--quiet' || t === '-q') a.quiet = true;
    else if (t.startsWith('-')) { console.error(`Unknown option ${t}`); process.exit(2); }
    else rest.push(t);
  }
  if (rest.length && ['scan', 'init', 'help'].includes(rest[0])) a.cmd = rest.shift()!;
  if (rest.length) a.dir = rest[0];
  return a;
}

/** Load .kasauti.toml, else the package.json key, else nothing. */
export function loadConfig(dir: string): ProjectConfig {
  const toml = path.join(dir, '.kasauti.toml');
  if (fs.existsSync(toml)) return parseProjectConfig(fs.readFileSync(toml, 'utf8'), '.kasauti.toml');
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const fromPkg = parsePackageJsonConfig(JSON.parse(fs.readFileSync(pkgPath, 'utf8')));
      if (fromPkg) return fromPkg;
    } catch { /* a broken package.json is not our business */ }
  }
  return EMPTY_CONFIG;
}

/** Walk a directory, honouring default excludes, config excludes and .gitignore. */
export function findFiles(root: string, excludes: string[], extraExts: string[] = []): Array<{ abs: string; rel: string; lang: string }> {
  const globs = excludes.map(globToRegExp);
  const gitignore = readGitignore(root);
  const out: Array<{ abs: string; rel: string; lang: string }> = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;                 // never follow symlinks
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (DEFAULT_EXCLUDES.has(e.name) || e.name.startsWith('.') && e.name !== '.') continue;
        if (globs.some((g) => g.test(rel) || g.test(rel + '/'))) continue;
        if (gitignore(rel + '/')) continue;
        walk(abs);
      } else {
        const lang = detectLanguage(abs, extraExts);
        if (!lang) continue;
        if (globs.some((g) => g.test(rel))) continue;
        if (gitignore(rel)) continue;
        out.push({ abs, rel, lang });
      }
    }
  };
  walk(root);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

/** Same minimal glob semantics the extension uses, so both skip the same files. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function readGitignore(root: string): (rel: string) => boolean {
  const file = path.join(root, '.gitignore');
  if (!fs.existsSync(file)) return () => false;
  const patterns = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
    .map((l) => {
      const bare = l.replace(/\/$/, '');
      return globToRegExp(bare.includes('/') ? bare.replace(/^\//, '') : '**/' + bare);
    });
  return (rel: string) => patterns.some((p) => p.test(rel) || p.test(rel.replace(/\/$/, '')) || rel.split('/').some((_, i, a) => p.test(a.slice(0, i + 1).join('/'))));
}

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
const padL = (s: string, n: number) => s.padStart(n);

async function scan(args: Args): Promise<number> {
  const root = path.resolve(args.dir);
  if (!fs.existsSync(root)) { console.error(`No such directory: ${root}`); return 2; }
  const cfg = loadConfig(root);
  for (const p of cfg.problems) {
    console.error(`Warning: ${cfg.source}${p.line ? `:${p.line}` : ''} — ${p.key}: ${p.message}. Using the default instead.`);
  }
  const thresholds = mergeThresholds(cfg.thresholds);
  const store = new ResultStore(thresholds, cfg.includePartialAnalysisInScore ?? true);

  const dist = __dirname;
  const pool = new WorkerPool(path.join(dist, 'worker.js'), path.join(dist, 'wasm'), undefined, (m) => { if (!args.quiet) console.error(m); });
  const files = findFiles(root, cfg.exclude);
  if (!files.length) { console.error('No source files found.'); pool.dispose(); return 2; }
  if (!args.quiet) process.stderr.write(`Analysing ${files.length} files…`);

  store.beginBatch();
  let next = 0;
  await Promise.all(Array.from({ length: 32 }, async () => {
    while (next < files.length) {
      const f = files[next++];
      const key = 'file://' + f.abs;
      try {
        const stat = fs.statSync(f.abs);
        if (stat.size > 1024 * 1024) { store.set(key, f.rel, skipped(f.lang, 'too large'), true); continue; }
        const buf = fs.readFileSync(f.abs);
        if (buf.subarray(0, 8192).includes(0)) { store.set(key, f.rel, skipped(f.lang, 'binary'), true); continue; }
        store.set(key, f.rel, await pool.analyze({ languageKey: f.lang, path: f.abs, text: buf.toString('utf8') }), true);
      } catch (e) {
        store.set(key, f.rel, skipped(f.lang, `unreadable (${(e as Error).message})`), true);
      }
    }
  }));
  store.endBatch();
  pool.dispose();
  if (!args.quiet) process.stderr.write('\r' + ' '.repeat(40) + '\r');

  const ws = store.workspaceScore();
  const analysed = store.workspaceFiles().filter((r) => r.analysis.tier !== 3);

  if (args.formats.includes('table') && !args.quiet) printTable(store, analysed.length);

  for (const fmt of args.formats) {
    if (fmt === 'table') continue;
    const body = fmt === 'json' ? toJSON(store, VERSION)
      : fmt === 'sarif' ? toSARIF(store, VERSION)
        : fmt === 'html' ? toHTML(store, VERSION, path.basename(root)) : undefined;
    if (body === undefined) { console.error(`Unknown format: ${fmt}`); return 2; }
    const out = args.out && args.formats.filter((f) => f !== 'table').length === 1
      ? path.resolve(args.out) : path.join(root, `kasauti-report.${fmt}`);
    fs.writeFileSync(out, body);
    console.error(`Wrote ${path.relative(process.cwd(), out) || out}`);
  }

  const partial = store.workspaceFiles().filter((r) => r.analysis.tier === 2).length;
  console.log(`KASAUTI ${ws.grade} · ${ws.score}/100 · debt ${formatDebt(ws.debtMinutes)} · ${ws.sloc.toLocaleString('en')} lines · ${analysed.length} files${partial ? ` (${partial} partial)` : ''}`);

  // ---- gate -------------------------------------------------------------
  if (args.noGate) return 0;
  const gate = args.minGrade ? { ...(cfg.gate ?? { failOn: [] }), minGrade: args.minGrade as never } : cfg.gate;
  if (!gate) return 0;                 // no gate configured: reporting only
  const fired = new Set<string>();
  for (const r of store.workspaceFiles()) for (const f of r.findings) fired.add(f.ruleId);
  const result = evaluateGate(gate, { grade: ws.grade, debtRatio: ws.debtRatio, firedRules: fired });
  if (result.pass) { console.log('Gate passed.'); return 0; }
  console.error('Gate failed:');
  for (const r of result.reasons) console.error(`  - ${r}`);
  return 1;
}

function printTable(store: ResultStore, total: number): void {
  const rows = store.workspaceFiles()
    .filter((r) => r.analysis.tier !== 3 && r.score.debtMinutes > 0)
    .sort((a, b) => b.score.debtMinutes - a.score.debtMinutes).slice(0, 25);
  if (!rows.length) { console.log(`No findings with remediation cost across ${total} files.`); return; }
  const w = Math.min(58, Math.max(12, ...rows.map((r) => r.relPath.length)));
  console.log(`${pad('FILE', w)}  GR  ${padL('SCORE', 5)}  ${padL('LINES', 6)}  ${padL('DEBT', 9)}  FINDINGS`);
  console.log('-'.repeat(w + 38));
  for (const r of rows) {
    console.log(`${pad(r.relPath, w)}  ${r.score.grade}${r.analysis.tier === 2 ? '~' : ' '}  ${padL(String(r.score.score), 5)}  ${padL(String(r.analysis.sloc), 6)}  ${padL(formatDebt(r.score.debtMinutes), 9)}  ${r.findings.length}`);
  }
  if (rows.length < total) console.log(`… and ${total - rows.length} more files with no remediation cost.`);
  const cat = store.debtByCategory();
  console.log(`\nDebt: complexity ${formatDebt(cat.complexity)} · size ${formatDebt(cat.size)} · duplication ${formatDebt(cat.duplication)} · style ${formatDebt(cat.style)}`);
}

function init(dir: string): number {
  const target = path.join(path.resolve(dir), '.kasauti.toml');
  if (fs.existsSync(target)) { console.error(`${target} already exists — not overwriting.`); return 2; }
  fs.writeFileSync(target, SAMPLE_CONFIG);
  console.log(`Wrote ${target}. The CI gate is off until you uncomment the [gate] block.`);
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.cmd === 'help') { console.log(HELP); return 0; }
  if (args.cmd === 'version') { console.log(VERSION); return 0; }
  if (args.cmd === 'init') return init(args.dir);
  return scan(args);
}

// Only run when executed directly, so tests can import main() safely.
if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error('KASAUTI failed:', (e as Error)?.stack ?? e);
    process.exit(2);
  });
}
