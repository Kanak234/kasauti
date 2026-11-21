/* =============================================================================
 * KASAUTI — snapshot.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Converts store records into small, plain JSON objects for the UI:
 *        UiFile (one pyramid block), UiSummary (Overview), UiDetail (drawer).
 * WHY:   Webviews run in a sandboxed browser context and receive data only by
 *        postMessage. Sending compact, UI-shaped data (instead of whole
 *        FileAnalysis objects with token arrays) keeps live updates fast.
 *        No vscode import: shared by the webviews AND the HTML report exporter.
 * FLOW:  store change -> controller -> toUiFile()/summary() -> postMessage ->
 *        webview/main.ts renders it.
 * ========================================================================== */

import { displayName } from './engine/languages';
import { RULE_BY_ID } from './engine/rules';
import { formatDebt } from './engine/scoring';
import type { FunctionMetrics, Grade, Severity } from './engine/types';
import type { DebtCategory, FileRecord, ResultStore } from './store';
import { plainCat, PlainCat, PLAIN_ORDER } from './audit/plain';

export interface UiFile {
  key: string;
  path: string;
  lang: string;
  tier: 1 | 2 | 3;
  skip?: string;
  grade: Grade;
  score: number;
  sloc: number;
  debt: number;             // minutes
  maxCC: number;
  maxCog: number;
  dupLines: number;
  counts: Record<Severity, number>;
  top?: string;             // most expensive finding message
  /** v0.2.0 F7: distinct rule ids that fired here, so the webview can filter
   *  by rule without shipping every finding to it. */
  rules?: string[];
  /** v2.1 Code Map: raw import specifiers (resolved to files in the webview). */
  imp?: string[];
  /** v2.1 Code Map: the file's functions (capped) with their own grade. */
  fns?: Array<{ name: string; line: number; grade: Grade; cc: number }>;
  /** v2.1 Code Map: 360° audit finding counts [performance, security, AI-risk]. */
  kp?: [number, number, number];
  /** v2.2: the file's most serious problems in plain words (max 4), for tooltips. */
  issues?: Array<{ cat: PlainCat; title: string; line: number }>;
}

export interface UiSummary {
  score: number;
  grade: Grade;
  debt: number;
  debtText: string;
  sloc: number;
  files: number;
  tier1: number;
  tier2: number;
  skipped: number;
  duplicatedPct: number;
  byCategory: Record<DebtCategory, number>;
  hotspots: Array<{ key: string; path: string; grade: Grade; debtText: string }>;
  scanned: boolean;
  scanning?: { done: number; total: number };
  /** v0.2.0 F6: score history for the sparkline, oldest first. */
  trend?: Array<{ t: number; score: number; grade: Grade }>;
  /** v0.2.0 F5: where the thresholds came from, so a surprising grade is
   *  explainable without hunting through settings. */
  thresholdNote?: string;
  /** v0.2.0 F5: problems found in .kasauti.toml, shown as a warning. */
  configProblems?: string[];
  /** v2.2: which AI proposes fixes (shown in the sidebar so it is not hidden in settings). */
  ai?: { label: string; model: string; local: boolean };
}

export interface UiFinding {
  ruleId: string; ruleName: string; severity: Severity; message: string; line: number;
  /** v2.2 plain-language group */
  cat?: PlainCat;
  debtText: string; why: string; fix: string[];
}

export interface UiFunction extends Pick<FunctionMetrics, 'name' | 'kind' | 'startLine' | 'params' | 'cyclomatic' | 'cognitive' | 'maxNesting' | 'sloc' | 'mi'> {
  grade: Grade;
}

export interface UiDetail {
  file: UiFile;
  functions: UiFunction[];
  findings: UiFinding[];
  note?: string;
}

/** Functions shipped per file to the Code Map. More are summarised as "+N". */
const MAX_FNS = 60;

export function toUiFile(r: FileRecord, store?: ResultStore): UiFile {
  const counts: Record<Severity, number> = { critical: 0, major: 0, minor: 0, info: 0 };
  const rules = new Set<string>();
  let dupLines = 0;
  for (const f of r.findings) {
    counts[f.severity]++;
    rules.add(f.ruleId);
    if (f.ruleId === 'CQ007') dupLines += f.endLine - f.line + 1;
  }
  const top = [...r.findings].sort((a, b) => b.debtMinutes - a.debtMinutes)[0];
  return {
    key: r.key, path: r.relPath, lang: displayName(r.analysis.languageKey),
    tier: r.analysis.tier, skip: r.analysis.skipReason,
    grade: r.score.grade, score: r.score.score, sloc: r.analysis.sloc, debt: r.score.debtMinutes,
    maxCC: Math.max(0, ...r.analysis.functions.map((f) => f.cyclomatic)),
    maxCog: Math.max(0, ...r.analysis.functions.map((f) => f.cognitive)),
    dupLines, counts,
    top: top && top.debtMinutes > 0 ? top.message : undefined,
    rules: rules.size ? [...rules].sort() : undefined,
    imp: r.analysis.imports?.length ? r.analysis.imports : undefined,
    fns: codeMapFunctions(r, store),
    kp: kpCounts(r),
    issues: plainIssues(r),
  };
}

/** Up to 4 problems, most dangerous group first, then by severity. Info-level
 *  notes (TODO markers) are not "problems" and are left out. */
const SEV_RANK = { critical: 0, major: 1, minor: 2, info: 3 } as const;
function plainIssues(r: FileRecord): UiFile['issues'] {
  const list = r.findings.filter((f) => f.severity !== 'info')
    .map((f) => ({ cat: plainCat(f.ruleId), title: RULE_BY_ID.get(f.ruleId)?.name ?? f.ruleId, line: f.line, sev: SEV_RANK[f.severity] }))
    .sort((a, b) => PLAIN_ORDER.indexOf(a.cat) - PLAIN_ORDER.indexOf(b.cat) || a.sev - b.sev || a.line - b.line);
  const seen = new Set<string>();
  const out = list.filter((x) => { const k = x.title; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4).map(({ sev, ...x }) => x);
  return out.length ? out : undefined;
}

/** [performance, security, AI-risk] KP finding counts, or undefined if none. */
function kpCounts(r: FileRecord): [number, number, number] | undefined {
  const c: [number, number, number] = [0, 0, 0];
  for (const f of r.findings) { const band = f.ruleId.startsWith('KP') ? Number(f.ruleId[2]) : 0; if (band >= 1 && band <= 3) c[band - 1]++; }
  return c[0] + c[1] + c[2] ? c : undefined;
}

/** Functions for the Code Map, worst first, with their own grade when the
 *  store is available (otherwise the file grade stands in). */
function codeMapFunctions(r: FileRecord, store?: ResultStore): UiFile['fns'] {
  const fns = r.analysis.functions;
  if (!fns.length) return undefined;
  const grades = store ? store.functionScores(r).map((s) => s.grade) : fns.map(() => r.score.grade);
  return fns.map((f, i) => ({ name: f.name, line: f.startLine, grade: grades[i], cc: f.cyclomatic }))
    .sort((a, b) => b.cc - a.cc).slice(0, MAX_FNS);
}

export function summary(store: ResultStore, scanned: boolean, scanning?: { done: number; total: number }): UiSummary {
  const ws = store.workspaceScore();
  const files = store.workspaceFiles();
  let dup = 0, sloc = 0;
  for (const r of files) {
    if (!store.counts(r)) continue;
    sloc += r.analysis.sloc;
    for (const f of r.findings) if (f.ruleId === 'CQ007') dup += f.endLine - f.line + 1;
  }
  return {
    score: ws.score, grade: ws.grade, debt: ws.debtMinutes, debtText: formatDebt(ws.debtMinutes), sloc: ws.sloc,
    files: files.length,
    tier1: files.filter((r) => r.analysis.tier === 1).length,
    tier2: files.filter((r) => r.analysis.tier === 2).length,
    skipped: files.filter((r) => r.analysis.tier === 3).length,
    duplicatedPct: sloc ? Math.round((dup / sloc) * 1000) / 10 : 0,
    byCategory: store.debtByCategory(),
    hotspots: store.hotspots(5).map((r) => ({ key: r.key, path: r.relPath, grade: r.score.grade, debtText: formatDebt(r.score.debtMinutes) })),
    scanned, scanning,
  };
}

export function detail(store: ResultStore, key: string): UiDetail | undefined {
  const r = store.get(key);
  if (!r) return undefined;
  const fscores = store.functionScores(r);
  return {
    file: toUiFile(r),
    functions: r.analysis.functions.map((f, i) => ({
      name: f.name, kind: f.kind, startLine: f.startLine, params: f.params, cyclomatic: f.cyclomatic,
      cognitive: f.cognitive, maxNesting: f.maxNesting, sloc: f.sloc, mi: f.mi, grade: fscores[i].grade,
    })),
    findings: r.findings.map((f) => {
      const rule = RULE_BY_ID.get(f.ruleId)!;
      return { ruleId: f.ruleId, ruleName: rule.name, cat: plainCat(f.ruleId), severity: f.severity, message: f.message, line: f.line,
        debtText: formatDebt(f.debtMinutes), why: rule.why, fix: rule.fix };
    }),
    note: r.analysis.skipReason ? `Skipped: ${r.analysis.skipReason}.`
      : r.analysis.tier === 2 ? `Partial analysis: no parser for ${displayName(r.analysis.languageKey)}. ${r.analysis.fallbackNote ?? ''}`.trim()
        : r.analysis.fallbackNote,
  };
}
