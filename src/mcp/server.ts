/* =============================================================================
 * KASAUTI — mcp/server.ts   (v2.0 "Parakh")
 * -----------------------------------------------------------------------------
 * WHAT:  A Model Context Protocol server over stdio. Any agent harness —
 *        Claude Code, OpenCode, Codex CLI, Cursor, Windsurf … — can call
 *        KASAUTI as a tool to check the code it just wrote:
 *          kasauti_audit_code        audit a snippet (all CQ + KP rules)
 *          kasauti_audit_file        audit a file on disk (+ dependency check)
 *          kasauti_check_packages    do these package names exist? how old?
 *          kasauti_prove_complexity  measure real Big-O        (needs exec opt-in)
 *          kasauti_verify_fix        prove a rewrite is safe   (exec part opt-in)
 * WHY:   SPEC OD-13. Instead of KASAUTI driving every harness (fragile, one
 *        integration each), every harness drives KASAUTI through one standard
 *        protocol. The agent writes; KASAUTI judges — same rule as in the editor.
 *        Code execution is OFF unless the harness config sets
 *        KASAUTI_ALLOW_EXEC=1: an agent must not be able to run arbitrary code
 *        through this server by default.
 * FLOW:  harness spawns `node dist/mcp.js` -> JSON-RPC lines on stdin/stdout
 *        -> handlers below -> the same engine modules the extension uses.
 *        NOTHING may be printed to stdout except protocol messages; logs go
 *        to stderr.
 * ========================================================================== */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { analyze } from '../engine/analyzer';
import { ParserService } from '../engine/parser';
import { evaluate, DEFAULT_THRESHOLDS, RULE_BY_ID } from '../engine/rules';
import { detectLanguage } from '../engine/languages';
import { scoreOf } from '../engine/scoring';
import type { Finding } from '../engine/types';
import { checkImports, checkRegistry, classifyImport, DepContext, lookupPackage, normalize, parseManifest, Ecosystem } from '../audit/deps';
import { fitComplexity, guessInputKind, INPUT_KINDS, InputKind, paramNames, ProveLanguage } from '../prove/core';
import { bench, equivalent, findPython } from '../prove/runner';
import { verifyCandidate, FixRequest } from '../ai/verify';

const VERSION = '2.0.0';
const ROOT = path.resolve(__dirname, '..');                 // extension folder (dist/..)
const parser = new ParserService(path.join(__dirname, 'wasm'));
const EXEC_ALLOWED = process.env.KASAUTI_ALLOW_EXEC === '1';
const log = (...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n');

/** Language names an agent is likely to send -> KASAUTI language keys. */
const LANG_ALIASES: Record<string, string> = {
  python: 'python', py: 'python', javascript: 'javascript', js: 'javascript', typescript: 'typescript', ts: 'typescript',
  tsx: 'tsx', jsx: 'javascript', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'c_sharp', 'c#': 'c_sharp', go: 'go',
  rust: 'rust', ruby: 'ruby', php: 'php', kotlin: 'kotlin', swift: 'swift', bash: 'bash', shell: 'bash', dart: 'dart', scala: 'scala',
};

/* ---------------------------------------------------------------------------
 * Tool definitions (JSON Schema is what the agent sees)
 * ------------------------------------------------------------------------- */
const TOOLS = [
  { name: 'kasauti_audit_code',
    description: 'Audit a code snippet with KASAUTI: security (injection, secrets, unsafe deserialization), performance (estimated Big-O, O(n) work inside loops), AI-generated-code loopholes (swallowed errors, stubs, unreachable code) and quality metrics (cyclomatic/cognitive complexity, grade A–E). Deterministic, offline. Call this on code you just wrote.',
    inputSchema: { type: 'object', properties: {
      code: { type: 'string', description: 'Source code to audit.' },
      language: { type: 'string', description: 'python, javascript, typescript, tsx, java, c, cpp, go, rust, …' },
      filename: { type: 'string', description: 'Optional file name; used to detect the language when `language` is omitted.' } }, required: ['code'] } },
  { name: 'kasauti_audit_file',
    description: 'Audit a source file on disk with all KASAUTI rules, including the dependency check (imports not declared in requirements.txt / pyproject.toml / package.json — possible hallucinated packages).',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string', description: 'Absolute path of the file.' },
      checkRegistry: { type: 'boolean', description: 'Also verify imported package names on PyPI/npm (network). Default false.' } }, required: ['path'] } },
  { name: 'kasauti_check_packages',
    description: 'Before installing packages an AI suggested: check that each name exists on PyPI or npm and how long ago it was first published (slopsquatting guard).',
    inputSchema: { type: 'object', properties: {
      ecosystem: { type: 'string', enum: ['pypi', 'npm'] },
      packages: { type: 'array', items: { type: 'string' }, description: 'Package names as you would install them.' } }, required: ['ecosystem', 'packages'] } },
  { name: 'kasauti_prove_complexity',
    description: 'Measure the real time complexity of ONE top-level Python or JavaScript function by running it at growing input sizes and fitting O(1)…O(2^n). Requires KASAUTI_ALLOW_EXEC=1 in the server environment.',
    inputSchema: { type: 'object', properties: {
      code: { type: 'string', description: 'A self-contained module defining the function (and any helpers/imports it needs).' },
      function: { type: 'string', description: 'Name of the function to measure.' },
      language: { type: 'string', enum: ['python', 'javascript'] },
      input_kind: { type: 'string', enum: [...INPUT_KINDS], description: 'Shape of the generated input. Guessed from parameter names if omitted.' } }, required: ['code', 'function', 'language'] } },
  { name: 'kasauti_verify_fix',
    description: 'Verify a rewrite of a function before accepting it: same function defined, no NEW security/AI-risk findings, no new third-party packages, and — when KASAUTI_ALLOW_EXEC=1 and the language is Python/JavaScript — identical results on edge-case and random inputs plus a before/after Big-O measurement.',
    inputSchema: { type: 'object', properties: {
      original: { type: 'string', description: 'The original function (self-contained module).' },
      candidate: { type: 'string', description: 'The rewritten function (self-contained module).' },
      function: { type: 'string' },
      language: { type: 'string', description: 'python, javascript, typescript, java …' },
      input_kind: { type: 'string', enum: [...INPUT_KINDS] } }, required: ['original', 'candidate', 'function', 'language'] } },
];

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */
function langKey(language?: string, filename?: string): string | undefined {
  if (language) return LANG_ALIASES[language.toLowerCase()] ?? language.toLowerCase();
  if (filename) return detectLanguage(filename);
  return undefined;
}

/** Findings in a compact, agent-friendly shape (1-based lines, one-line advice). */
function present(findings: Finding[]) {
  return findings.map((f) => ({ rule: f.ruleId, severity: f.severity, line: f.line + 1, message: f.message,
    advice: RULE_BY_ID.get(f.ruleId)?.fix[0], name: RULE_BY_ID.get(f.ruleId)?.name }));
}

async function auditText(languageKey: string, text: string, file = 'snippet') {
  const a = await analyze(parser, languageKey, file, text);
  const findings = evaluate(a, DEFAULT_THRESHOLDS);
  const score = scoreOf(findings.reduce((s, f) => s + f.debtMinutes, 0), a.sloc);
  return { a, findings, score };
}

/** Walk up from a file to collect manifests (stops at the first .git or 8 levels). */
function depContextFor(file: string, eco: Ecosystem): DepContext {
  const declared = new Set<string>();
  let hasManifest = false;
  let dir = path.dirname(file);
  const roots: string[] = [];
  for (let i = 0; i < 8; i++) {
    roots.push(dir);
    for (const name of safeList(dir)) {
      const m = /^(package\.json|requirements.*\.(txt|in)|constraints\.txt|pyproject\.toml|pipfile|setup\.py|setup\.cfg|environment\.yml)$/i.test(name)
        ? parseManifest(name, safeRead(path.join(dir, name))) : undefined;
      if (m && m.ecosystem === eco) { hasManifest = true; m.names.forEach((n) => declared.add(normalize(n))); }
    }
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const isLocal = (name: string) => roots.some((r) => [`${name}.py`, name, path.join('src', name), `${name}.js`, `${name}.ts`].some((c) => fs.existsSync(path.join(r, c))));
  return { declared, hasManifest, isLocal };
}
/** `def f(a, b)` / `function f(a, b)` header of a function, for input-kind guessing. */
function headerOf(code: string, fn: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(fn)) throw new Error(`'${fn}' is not a valid function name.`);
  return new RegExp(`(?:def|function)\\s+${fn.replace(/\$/g, '\\$')}\\s*\\([^)]*\\)`).exec(code)?.[0] ?? '';
}
const safeList = (d: string) => { try { return fs.readdirSync(d); } catch { return []; } };
const safeRead = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

let pythonExe: Promise<string | undefined> | undefined;
const runnerOpts = async () => ({ harnessDir: path.join(ROOT, 'media', 'harness'), python: await (pythonExe ??= findPython(process.env.KASAUTI_PYTHON)), timeoutMs: 45_000 });

const NO_EXEC = 'Execution is disabled. Add "env": {"KASAUTI_ALLOW_EXEC": "1"} to this MCP server\'s config to allow KASAUTI to run the function in a temporary folder (it is not a sandbox — only enable it for code you would run yourself).';

/* ---------------------------------------------------------------------------
 * Tool handlers
 * ------------------------------------------------------------------------- */
async function callTool(name: string, args: Record<string, any>): Promise<unknown> {
  switch (name) {
    case 'kasauti_audit_code': {
      const key = langKey(args.language, args.filename);
      if (!key) throw new Error('Unknown language: pass `language` (e.g. "python") or a `filename` with an extension.');
      const { a, findings, score } = await auditText(key, String(args.code ?? ''), args.filename ?? 'snippet');
      return { language: key, analysis: a.tier === 1 ? 'full' : a.tier === 2 ? 'partial (no parser for this language)' : `skipped: ${a.skipReason}`,
        grade: score.grade, score: score.score, findings: present(findings),
        functions: a.functions.map((f) => ({ name: f.name, line: f.startLine + 1, cyclomatic: f.cyclomatic, cognitive: f.cognitive, nesting: f.maxNesting, lines: f.sloc })) };
    }
    case 'kasauti_audit_file': {
      const file = path.resolve(String(args.path ?? ''));
      if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
      const key = detectLanguage(file);
      if (!key) throw new Error('KASAUTI does not recognise this file type.');
      const text = fs.readFileSync(file, 'utf8');
      const { a, findings, score } = await auditText(key, text, file);
      const eco: Ecosystem | undefined = key === 'python' || key === 'notebook:python' ? 'pypi' : /^(javascript|typescript|tsx)$/.test(key) ? 'npm' : undefined;
      if (eco) {
        const ctx = depContextFor(file, eco);
        findings.push(...checkImports(key, text, ctx));
        if (args.checkRegistry) findings.push(...await checkRegistry(key, text, ctx));
      }
      findings.sort((x, y) => x.line - y.line);
      return { file, language: key, grade: score.grade, score: score.score, findings: present(findings), tier: a.tier };
    }
    case 'kasauti_check_packages': {
      const eco = args.ecosystem as Ecosystem;
      if (eco !== 'pypi' && eco !== 'npm') throw new Error('ecosystem must be "pypi" or "npm".');
      const ctx: DepContext = { declared: new Set(), hasManifest: false, isLocal: () => false };
      const out = [];
      for (const pkg of (args.packages ?? []) as string[]) {
        if (classifyImport({ name: pkg, line: 0, col: 0, ecosystem: eco }, ctx) === 'stdlib') { out.push({ package: pkg, verdict: 'standard library — nothing to install' }); continue; }
        const info = await lookupPackage(eco, pkg);
        const days = info.created ? Math.floor((Date.now() - Date.parse(info.created)) / 86_400_000) : undefined;
        out.push({ package: pkg, exists: info.exists, firstPublished: info.created, ageDays: days,
          verdict: info.error ? `could not check (${info.error})` : !info.exists ? 'DOES NOT EXIST — likely hallucinated; do not install'
            : days !== undefined && days < 90 ? 'very new — inspect author, repository and downloads before installing' : 'exists' });
      }
      return { ecosystem: eco, results: out };
    }
    case 'kasauti_prove_complexity': {
      if (!EXEC_ALLOWED) throw new Error(NO_EXEC);
      const language = args.language as ProveLanguage;
      const header = headerOf(String(args.code), String(args.function));
      const kind = (args.input_kind as InputKind) ?? guessInputKind(paramNames(header));
      const r = await bench(language, String(args.code), String(args.function), kind, await runnerOpts());
      if (r.error) throw new Error(r.error);
      const fit = r.fit ?? fitComplexity(r.points);
      return { function: args.function, inputKind: kind, measured: fit.best, confidence: fit.confidence, logLogSlope: Number(fit.slope.toFixed(2)), note: fit.note,
        points: r.points.map((p) => ({ n: p.n, seconds: Number(p.t.toPrecision(3)) })), runnerUp: fit.ranked[1]?.label };
    }
    case 'kasauti_verify_fix': {
      const key = langKey(args.language);
      if (!key) throw new Error('Unknown language.');
      const provable: ProveLanguage | undefined = key === 'python' ? 'python' : key === 'javascript' ? 'javascript' : undefined;
      const fn = String(args.function);
      const header = headerOf(String(args.original), fn);
      const kind = (args.input_kind as InputKind) ?? guessInputKind(paramNames(header));
      const opts = EXEC_ALLOWED && provable ? await runnerOpts() : undefined;
      const req: FixRequest = { languageKey: key, language: key, fnName: fn, original: String(args.original), preamble: '', findings: [], startLine: 0,
        provable, kind, maxAttempts: 1, provider: 'mcp' };
      const auditFn = async (code: string) => { const a = await analyze(parser, key, 'snippet', code); return { findings: a.audit ?? [], syntaxError: a.hasSyntaxErrors }; };
      const base = await auditFn(req.original);
      const v = await verifyCandidate(req, String(args.candidate), {
        ask: async () => '', audit: auditFn,
        runner: opts ? { equivalent: (x, y) => equivalent(provable!, x, y, fn, kind, opts), bench: (c) => bench(provable!, c, fn, kind, opts) } : undefined,
      }, { findings: base.findings, bench: opts ? await bench(provable!, req.original, fn, kind, opts) : undefined });
      const passed = !v.checks.some((c) => c.status === 'fail');
      return { verdict: passed ? 'ACCEPT' : 'REJECT', checks: v.checks, resolved: v.fixed, stillPresent: v.remaining,
        performance: v.perf ? { before: v.perf.before, after: v.perf.after, speedup: v.perf.speedup && Number(v.perf.speedup.toFixed(2)), atN: v.perf.atN } : undefined,
        executionNote: EXEC_ALLOWED ? undefined : NO_EXEC };
    }
  }
  throw new Error(`Unknown tool: ${name}`);
}

/* ---------------------------------------------------------------------------
 * JSON-RPC over stdio (newline-delimited, as the MCP stdio transport specifies)
 * ------------------------------------------------------------------------- */
const send = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

async function handle(msg: { id?: number | string; method?: string; params?: any }): Promise<void> {
  const { id, method, params } = msg;
  if (method === undefined) return;                        // a response to us: we never send requests
  const reply = (result: unknown) => { if (id !== undefined) send({ id, result }); };
  try {
    switch (method) {
      case 'initialize':
        return reply({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'kasauti', title: 'KASAUTI — 360° code audit', version: VERSION },
          instructions: 'Use kasauti_audit_code on code you write before presenting it. Use kasauti_check_packages before installing any package. Use kasauti_verify_fix to prove a refactor keeps behaviour and does not add vulnerabilities.' });
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': {
        try {
          const result = await callTool(params?.name, params?.arguments ?? {});
          return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
        } catch (e) {
          // Tool errors are results the agent can read and react to (MCP spec), not protocol errors.
          return reply({ content: [{ type: 'text', text: String((e as Error)?.message ?? e) }], isError: true });
        }
      }
      default:
        if (method.startsWith('notifications/')) return;    // initialized, cancelled …: nothing to do
        if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    if (id !== undefined) send({ id, error: { code: -32603, message: String((e as Error)?.message ?? e) } });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  void handle(msg);
});
rl.on('close', () => process.exit(0));
log(`KASAUTI MCP server ${VERSION} ready (code execution ${EXEC_ALLOWED ? 'ENABLED' : 'disabled'})`);
