/* =============================================================================
 * KASAUTI — config/projectConfig.ts   (v0.2.0, feature F5)
 * -----------------------------------------------------------------------------
 * WHAT:  Reads `.kasauti.toml` (or a `kasauti` key in package.json) from the
 *        workspace root: thresholds, excludes, and the CI `gate` block.
 * WHY:   Without a file in the repo, KASAUTI stays a personal tool — every
 *        teammate gets different grades. With one, the project decides, and
 *        the same numbers come out in the editor and in CI.
 * HOW:   Contains a small, dependency-free TOML reader. KASAUTI ships no
 *        parser dependency for a ~40-line config format, and a hand-written
 *        reader lets errors name the exact line (R5.1).
 * FLOW:  editor  -> controller reads settings, then merges this on top
 *        CI      -> cli.ts reads this alone (no VS Code API on that path)
 *
 * PRECEDENCE (R5.1): explicit VS Code setting > project file > defaults.
 * "Explicit" means the user actually set it; an untouched setting sitting at
 * its default must NOT beat the project file, or the project file would never
 * apply to anyone. The editor decides that; this module only parses and
 * validates, and records where each value came from so the Overview can say so.
 * ========================================================================== */

import { DEFAULT_THRESHOLDS } from '../engine/rules';
import type { Thresholds } from '../engine/types';
import type { Grade } from '../engine/types';

export interface GateConfig {
  /** Fail below this grade. Undefined = not enforced. */
  minGrade?: Grade;
  /** Fail above this debt-ratio percentage (e.g. 20 = 20%). */
  maxDebtRatio?: number;
  /** Always fail if any of these rules fired, whatever the grade. */
  failOn: string[];
}

export interface ProjectConfig {
  thresholds: Partial<Thresholds>;
  exclude: string[];
  includePartialAnalysisInScore?: boolean;
  gate?: GateConfig;
  /** Where each value came from, for the "why do we disagree?" question. */
  source: string;
  /** Problems found while reading. Never fatal (R5.1). */
  problems: ConfigProblem[];
}

export interface ConfigProblem { line: number; key: string; message: string }

export const EMPTY_CONFIG: ProjectConfig = { thresholds: {}, exclude: [], source: 'defaults', problems: [] };

/** Config key -> Thresholds field. Keys are what users write in the file. */
const THRESHOLD_KEYS: Record<string, keyof Thresholds> = {
  cyclomatic: 'cyclomatic', cognitive: 'cognitive', functionlength: 'functionLength',
  parameters: 'parameters', nesting: 'nesting', filelength: 'fileLength',
  duplicationtokens: 'duplicationTokens', maintainabilitywarning: 'miWarning',
  maintainabilitycritical: 'miCritical', classmethods: 'classMethods', linelength: 'lineLength',
};
const GRADES = ['A', 'B', 'C', 'D', 'E'];

/* -----------------------------------------------------------------------------
 * A deliberately small TOML reader: tables, strings, numbers, booleans, and
 * single-line arrays. That is the whole config surface. Anything else is
 * reported as a problem rather than silently ignored, so a typo is visible.
 * --------------------------------------------------------------------------- */
type Scalar = string | number | boolean | Array<string | number>;

function parseToml(text: string): { data: Record<string, Record<string, Scalar>>; problems: ConfigProblem[] } {
  const data: Record<string, Record<string, Scalar>> = { '': {} };
  const problems: ConfigProblem[] = [];
  let table = '';
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();     // strip comments
    if (!line) return;
    const tableMatch = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (tableMatch) { table = tableMatch[1].toLowerCase(); data[table] ??= {}; return; }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) { problems.push({ line: i + 1, key: line.slice(0, 30), message: 'not a key = value pair' }); return; }
    const [, key, rawValue] = kv;
    const value = parseValue(rawValue.trim(), i + 1, key, problems);
    if (value !== undefined) data[table][key.toLowerCase()] = value;
  });
  return { data, problems };
}

function parseValue(v: string, line: number, key: string, problems: ConfigProblem[]): Scalar | undefined {
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v.slice(1, -1);
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) { problems.push({ line, key, message: 'array must be on one line' }); return undefined; }
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((x) => {
      const t = x.trim();
      return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t.replace(/^["']|["']$/g, '');
    });
  }
  problems.push({ line, key, message: `value ${v} is not a string, number, boolean or array` });
  return undefined;
}

/* -----------------------------------------------------------------------------
 * Validation: every value is checked; a bad one is reported and dropped, the
 * rest of the file still applies (R5.1 — never fail to activate).
 * --------------------------------------------------------------------------- */
function build(data: Record<string, Record<string, Scalar>>, problems: ConfigProblem[], source: string): ProjectConfig {
  const cfg: ProjectConfig = { thresholds: {}, exclude: [], source, problems };
  const root = { ...(data[''] ?? {}), ...(data['kasauti'] ?? {}) };
  const thresholdTable = { ...(data['thresholds'] ?? {}), ...(data['kasauti.thresholds'] ?? {}) };

  const num = (v: Scalar | undefined, key: string, min = 1): number | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
      problems.push({ line: 0, key, message: `must be a number of at least ${min}` });
      return undefined;
    }
    return v;
  };

  for (const [key, field] of Object.entries(THRESHOLD_KEYS)) {
    const v = num(thresholdTable[key] ?? root[key], key, field === 'duplicationTokens' ? 20 : 1);
    if (v !== undefined) cfg.thresholds[field] = v;
  }

  const ex = root['exclude'];
  if (ex !== undefined) {
    if (Array.isArray(ex)) cfg.exclude = ex.map(String);
    else problems.push({ line: 0, key: 'exclude', message: 'must be an array of glob strings' });
  }
  const partial = root['includepartialanalysisinscore'];
  if (typeof partial === 'boolean') cfg.includePartialAnalysisInScore = partial;

  // ---- gate block: absent means no gate. Default is OFF by design: a build
  // must never start failing because someone installed a quality tool.
  const gateTable = data['gate'] ?? data['kasauti.gate'];
  if (gateTable) {
    const gate: GateConfig = { failOn: [] };
    const mg = gateTable['mingrade'];
    if (mg !== undefined) {
      const g = String(mg).toUpperCase();
      if (GRADES.includes(g)) gate.minGrade = g as Grade;
      else problems.push({ line: 0, key: 'gate.minGrade', message: 'must be one of A, B, C, D, E' });
    }
    const mdr = gateTable['maxdebtratio'];
    if (mdr !== undefined) {
      if (typeof mdr === 'number' && mdr >= 0 && mdr <= 100) gate.maxDebtRatio = mdr;
      else problems.push({ line: 0, key: 'gate.maxDebtRatio', message: 'must be a percentage between 0 and 100' });
    }
    const fo = gateTable['failon'];
    if (fo !== undefined) {
      if (Array.isArray(fo)) gate.failOn = fo.map((x) => String(x).toUpperCase()).filter((x) => /^CQ\d{3}$/.test(x));
      else problems.push({ line: 0, key: 'gate.failOn', message: 'must be an array of rule ids like ["CQ001"]' });
    }
    cfg.gate = gate;
  }
  return cfg;
}

/** Parse a `.kasauti.toml` file's text. */
export function parseProjectConfig(text: string, source = '.kasauti.toml'): ProjectConfig {
  const { data, problems } = parseToml(text);
  return build(data, problems, source);
}

/** Parse the `kasauti` key of a package.json object. */
export function parsePackageJsonConfig(pkg: unknown, source = 'package.json'): ProjectConfig | undefined {
  const k = (pkg as { kasauti?: Record<string, unknown> } | null)?.kasauti;
  if (!k || typeof k !== 'object') return undefined;
  // Reshape into the same table form the TOML reader produces.
  const data: Record<string, Record<string, Scalar>> = { '': {}, thresholds: {}, gate: {} };
  for (const [key, value] of Object.entries(k)) {
    const lower = key.toLowerCase();
    if (lower === 'thresholds' && value && typeof value === 'object') {
      for (const [tk, tv] of Object.entries(value as Record<string, Scalar>)) data['thresholds'][tk.toLowerCase()] = tv;
    } else if (lower === 'gate' && value && typeof value === 'object') {
      for (const [gk, gv] of Object.entries(value as Record<string, Scalar>)) data['gate'][gk.toLowerCase()] = gv;
    } else {
      data[''][lower] = value as Scalar;
    }
  }
  if (!Object.keys(data['gate']).length) delete data['gate'];
  return build(data, [], source);
}

/** Merge: defaults < project file < explicit editor settings. */
export function mergeThresholds(project: Partial<Thresholds>, explicit: Partial<Thresholds> = {}): Thresholds {
  return { ...DEFAULT_THRESHOLDS, ...project, ...explicit };
}

/** Which source won for each threshold — shown in the Overview (R5.1). */
export function thresholdSources(project: Partial<Thresholds>, explicit: Partial<Thresholds> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(DEFAULT_THRESHOLDS) as Array<keyof Thresholds>) {
    out[key] = explicit[key] !== undefined ? 'VS Code setting' : project[key] !== undefined ? 'project file' : 'default';
  }
  return out;
}

/* -----------------------------------------------------------------------------
 * The gate itself: pure, so the editor and the CLI reach the same verdict.
 * --------------------------------------------------------------------------- */
export interface GateInput { grade: Grade; debtRatio: number; firedRules: Set<string> }
export interface GateResult { pass: boolean; reasons: string[] }

export function evaluateGate(gate: GateConfig | undefined, input: GateInput): GateResult {
  if (!gate) return { pass: true, reasons: [] };
  const reasons: string[] = [];
  if (gate.minGrade && GRADES.indexOf(input.grade) > GRADES.indexOf(gate.minGrade)) {
    reasons.push(`grade ${input.grade} is below the required ${gate.minGrade}`);
  }
  if (gate.maxDebtRatio !== undefined && input.debtRatio * 100 > gate.maxDebtRatio) {
    reasons.push(`debt ratio ${(input.debtRatio * 100).toFixed(1)}% exceeds the limit of ${gate.maxDebtRatio}%`);
  }
  for (const rule of gate.failOn) {
    if (input.firedRules.has(rule)) reasons.push(`rule ${rule} fired and is listed in failOn`);
  }
  return { pass: reasons.length === 0, reasons };
}

/** The file a user gets from `kasauti init`, and what the docs show. */
export const SAMPLE_CONFIG = `# KASAUTI project configuration.
# Committed to the repo so everyone on the team gets the same grades.

[thresholds]
cyclomatic = 10          # CQ001 max paths through a function
cognitive = 15           # CQ002 how hard it is to read
functionLength = 50      # CQ003 lines of code
parameters = 7           # CQ004
nesting = 3              # CQ005
fileLength = 1000        # CQ006
duplicationTokens = 100  # CQ007 smallest block counted as duplicated
lineLength = 120         # CQ010

exclude = ["**/generated/**", "**/*.min.js"]

# The CI gate is OFF unless this block exists. Uncomment to enforce.
# [gate]
# minGrade = "C"
# maxDebtRatio = 20.0
# failOn = ["CQ001"]
`;
