/* =============================================================================
 * KASAUTI — engine/rules.ts
 * -----------------------------------------------------------------------------
 * WHAT:  (1) The rule catalog CQ001–CQ012: name, why it matters, how to fix.
 *        (2) Default thresholds (SPEC §B4.2) and remediation costs (§B4.3).
 *        (3) evaluate(): measurements + thresholds  ->  Finding[].
 * WHY:   Measurements (metrics.ts) never change when a user edits a threshold;
 *        only this step re-runs. That makes settings changes instant (§B5).
 * FLOW:  store.ts calls evaluate(analysis, thresholds) -> findings
 *        + duplication.ts adds CQ007 findings -> scoring.ts computes the grade.
 * ========================================================================== */

import type { FileAnalysis, Finding, Severity, Thresholds } from './types';

/** SPEC §B4.2 defaults, with the source each value is based on. */
export const DEFAULT_THRESHOLDS: Thresholds = {
  cyclomatic: 10,          // McCabe's recommended upper limit
  cognitive: 15,           // SonarSource default (rule S3776)
  functionLength: 50,      // common industry guideline (SLOC)
  parameters: 7,           // SonarSource default (S107)
  nesting: 3,              // SonarSource default (S134)
  fileLength: 1000,        // SonarSource default (S104)
  duplicationTokens: 100,  // SonarQube-like minimum clone size
  miWarning: 20,           // Visual Studio: 10–19 = yellow band
  miCritical: 10,          // Visual Studio: 0–9 = red band
  classMethods: 35,        // SonarSource default (S1448)
  lineLength: 120,         // common style guideline
};

/** Human-facing rule documentation. Shown in hovers, the detail drawer,
 *  bundled rule pages, and the SARIF rule table. */
export interface RuleInfo {
  id: string;
  name: string;
  summary: string;          // one line
  why: string;              // 2–3 sentences
  fix: string[];            // concrete steps
  tiers: Array<1 | 2>;
}

export const RULES: RuleInfo[] = [
  { id: 'CQ001', name: 'Function is too complex (cyclomatic)', tiers: [1],
    summary: 'Too many independent paths through one function.',
    why: 'Cyclomatic complexity counts the paths a test suite must cover. Past about 10, a function needs so many tests that bugs slip through, and every change risks breaking a path nobody remembered.',
    fix: ['Extract each branch body into a well-named helper function.', 'Replace long if/else-if chains on one value with a lookup table or polymorphism.', 'Use early returns (guard clauses) for error cases.'] },
  { id: 'CQ002', name: 'Function is hard to understand (cognitive)', tiers: [1],
    summary: 'Nested and tangled control flow makes this function hard to read.',
    why: 'Cognitive complexity charges extra for nesting, because each level of nesting is something a reader must hold in their head. High values predict slow reviews and misunderstood code.',
    fix: ['Flatten nesting with guard clauses: handle the special case first and return.', 'Move the body of deep loops into a separate function.', 'Split mixed && / || conditions into named boolean variables.'] },
  { id: 'CQ003', name: 'Function is too long', tiers: [1],
    summary: 'This function has more lines of code than the limit.',
    why: 'Long functions usually do several jobs at once. They are harder to name, test, and reuse, and changes in one part affect the others.',
    fix: ['Find the separate steps (often marked by blank lines or comments) and extract each into a function.', 'Name each extracted function after what it does, not how.'] },
  { id: 'CQ004', name: 'Too many parameters', tiers: [1],
    summary: 'The function takes more parameters than the limit.',
    why: 'Many parameters make calls hard to read and easy to get wrong (two arguments of the same type swapped). It often means the function does too much.',
    fix: ['Group related parameters into one object, struct, or data class.', 'Split the function if the parameters serve different jobs.'] },
  { id: 'CQ005', name: 'Control flow is nested too deeply', tiers: [1, 2],
    summary: 'if/for/while/switch/try are nested deeper than the limit.',
    why: 'Every nesting level multiplies the conditions a reader must track. Deep nesting is the most common cause of "arrow-shaped" code that nobody wants to touch.',
    fix: ['Invert conditions and return early.', 'Extract the innermost block into its own function.', 'Replace nested loops with a helper that processes one item.'] },
  { id: 'CQ006', name: 'File is too long', tiers: [1, 2],
    summary: 'This file has more lines than the limit.',
    why: 'Very long files usually hold several unrelated responsibilities, which leads to merge conflicts and makes code hard to find.',
    fix: ['Group related functions/classes and move each group into its own file or module.'] },
  { id: 'CQ007', name: 'Duplicated code', tiers: [1, 2],
    summary: 'This block also appears elsewhere.',
    why: 'Copy-pasted code must be fixed in every copy. Sooner or later one copy is forgotten, and the same bug lives on in another place.',
    fix: ['Extract the shared code into one function and call it from both places.', 'If the copies differ slightly, pass the difference as a parameter.'] },
  { id: 'CQ008', name: 'Low maintainability index', tiers: [1],
    summary: 'Size, complexity, and vocabulary together make this function hard to maintain.',
    why: 'The Maintainability Index combines Halstead volume, cyclomatic complexity, and lines of code. Visual Studio treats values below 20 as a warning and below 10 as a problem.',
    fix: ['Reduce complexity first (see CQ001/CQ002).', 'Shorten the function by extracting helpers.'] },
  { id: 'CQ009', name: 'Class has too many methods', tiers: [1],
    summary: 'This class defines more methods than the limit.',
    why: 'A class with very many methods usually has more than one responsibility (a "god class"), which makes it fragile and hard to test.',
    fix: ['Identify groups of methods that use the same fields and move each group into its own class.'] },
  { id: 'CQ010', name: 'Line is too long', tiers: [1, 2],
    summary: 'This line is longer than the limit.',
    why: 'Long lines force horizontal scrolling and hide logic off-screen, especially in side-by-side reviews.',
    fix: ['Break long expressions across lines.', 'Introduce intermediate variables with descriptive names.'] },
  { id: 'CQ011', name: 'TODO / FIXME left in code', tiers: [1, 2],
    summary: 'A TODO, FIXME, HACK, or XXX marker is present.',
    why: 'Markers are useful reminders, but forgotten ones hide known problems. This finding is informational and adds no debt.',
    fix: ['Resolve the item, or move it to your issue tracker and delete the marker.'] },
  { id: 'CQ012', name: 'File contains syntax errors', tiers: [1],
    summary: 'The parser found syntax errors; results may be incomplete.',
    why: 'Metrics are computed from the parts of the file that parse. Fix the syntax errors to get complete results.',
    fix: ['Check the editor\'s Problems panel for the language\'s own error messages.'] },
];

export const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

/** Over-threshold severity: far over (>= 2x the limit) is critical. */
const sev = (value: number, limit: number): Severity => (value >= 2 * limit ? 'critical' : 'major');

/** Long lines are capped at this many individual findings per file; the rest
 *  are summarized in one finding so the Problems panel stays readable. */
const MAX_LINE_FINDINGS = 20;

/**
 * Turn raw measurements into actionable findings.
 * Pure function: same inputs -> same outputs (determinism, SPEC §A10.3).
 */
export function evaluate(a: FileAnalysis, t: Thresholds): Finding[] {
  const out: Finding[] = [];
  if (a.tier === 3) return out;

  // ---- function-level rules (Tier 1) ------------------------------------
  for (const f of a.functions) {
    const at = { line: f.startLine, col: f.startCol, endLine: f.startLine, endCol: f.startCol + Math.max(1, f.name.length), symbol: f.name };
    if (f.cyclomatic > t.cyclomatic) out.push({ ...at, ruleId: 'CQ001', severity: sev(f.cyclomatic, t.cyclomatic),
      message: `'${f.name}' has cyclomatic complexity ${f.cyclomatic} (limit ${t.cyclomatic}).`,
      value: f.cyclomatic, threshold: t.cyclomatic, debtMinutes: 10 + (f.cyclomatic - t.cyclomatic) });
    if (f.cognitive > t.cognitive) out.push({ ...at, ruleId: 'CQ002', severity: sev(f.cognitive, t.cognitive),
      message: `'${f.name}' has cognitive complexity ${f.cognitive} (limit ${t.cognitive}).`,
      value: f.cognitive, threshold: t.cognitive, debtMinutes: 10 + (f.cognitive - t.cognitive) });
    if (f.sloc > t.functionLength) out.push({ ...at, ruleId: 'CQ003', severity: sev(f.sloc, t.functionLength),
      message: `'${f.name}' has ${f.sloc} lines of code (limit ${t.functionLength}).`,
      value: f.sloc, threshold: t.functionLength, debtMinutes: 20 + Math.ceil((f.sloc - t.functionLength) / 5) });
    if (f.params > t.parameters) out.push({ ...at, ruleId: 'CQ004', severity: sev(f.params, t.parameters),
      message: `'${f.name}' takes ${f.params} parameters (limit ${t.parameters}).`,
      value: f.params, threshold: t.parameters, debtMinutes: 15 + 5 * (f.params - t.parameters) });
    if (f.maxNesting > t.nesting) out.push({ ...at, ruleId: 'CQ005', severity: sev(f.maxNesting, t.nesting),
      message: `'${f.name}' nests control flow ${f.maxNesting} levels deep (limit ${t.nesting}).`,
      value: f.maxNesting, threshold: t.nesting, debtMinutes: 10 * (f.maxNesting - t.nesting) });
    if (f.mi < t.miWarning && f.sloc >= 5) {
      const critical = f.mi < t.miCritical;
      out.push({ ...at, ruleId: 'CQ008', severity: critical ? 'critical' : 'major',
        message: `'${f.name}' has maintainability index ${f.mi.toFixed(1)} (warning below ${t.miWarning}).`,
        value: f.mi, threshold: t.miWarning, debtMinutes: critical ? 30 : 15 });
    }
  }

  // ---- class-level rules -------------------------------------------------
  for (const c of a.classes) {
    if (c.methods > t.classMethods) out.push({ ruleId: 'CQ009', severity: sev(c.methods, t.classMethods),
      message: `'${c.name}' has ${c.methods} methods (limit ${t.classMethods}).`,
      line: c.startLine, col: c.startCol, endLine: c.startLine, endCol: c.startCol + c.name.length,
      value: c.methods, threshold: t.classMethods, debtMinutes: 30 + 2 * (c.methods - t.classMethods), symbol: c.name });
  }

  // ---- Tier 2 nesting estimate --------------------------------------------
  if (a.tier === 2 && a.indentNesting && a.indentNesting.depth > t.nesting) {
    const n = a.indentNesting;
    out.push({ ruleId: 'CQ005', severity: sev(n.depth, t.nesting),
      message: `Code is nested about ${n.depth} levels deep (estimated from indentation; limit ${t.nesting}).`,
      line: n.line, col: 0, endLine: n.line, endCol: a.lineLengths[n.line] ?? 1,
      value: n.depth, threshold: t.nesting, debtMinutes: 10 * (n.depth - t.nesting) });
  }

  // ---- file-level rules ----------------------------------------------------
  if (a.lines > t.fileLength) out.push({ ruleId: 'CQ006', severity: sev(a.lines, t.fileLength),
    message: `File has ${a.lines} lines (limit ${t.fileLength}).`,
    line: 0, col: 0, endLine: 0, endCol: a.lineLengths[0] ?? 1,
    value: a.lines, threshold: t.fileLength, debtMinutes: 60 + Math.ceil((a.lines - t.fileLength) / 100) * 10 });

  const long: number[] = [];
  for (let i = 0; i < a.lineLengths.length; i++) if (a.lineLengths[i] > t.lineLength) long.push(i);
  long.slice(0, MAX_LINE_FINDINGS).forEach((i) => out.push({ ruleId: 'CQ010', severity: 'minor',
    message: `Line has ${a.lineLengths[i]} characters (limit ${t.lineLength}).`,
    line: i, col: t.lineLength, endLine: i, endCol: a.lineLengths[i],
    value: a.lineLengths[i], threshold: t.lineLength, debtMinutes: 1 }));
  if (long.length > MAX_LINE_FINDINGS) {
    const rest = long.length - MAX_LINE_FINDINGS;
    const i = long[MAX_LINE_FINDINGS];
    out.push({ ruleId: 'CQ010', severity: 'minor',
      message: `${rest} more lines exceed ${t.lineLength} characters.`,
      line: i, col: 0, endLine: i, endCol: a.lineLengths[i], value: rest, threshold: t.lineLength, debtMinutes: rest });
  }

  for (const td of a.todos) out.push({ ruleId: 'CQ011', severity: 'info', message: td.text,
    line: td.line, col: td.col, endLine: td.line, endCol: td.col + 4, debtMinutes: 0 });

  if (a.hasSyntaxErrors) out.push({ ruleId: 'CQ012', severity: 'info',
    message: 'File contains syntax errors — results may be incomplete.',
    line: 0, col: 0, endLine: 0, endCol: 1, debtMinutes: 0 });

  return out;
}

/** CQ007 remediation cost for a duplicated block of `lines` lines. */
export function duplicationDebt(lines: number): number { return 10 + Math.round(lines / 5); }
