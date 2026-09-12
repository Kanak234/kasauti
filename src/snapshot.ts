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
import type { FileRecord, ResultStore } from './store';

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
  byCategory: Record<'complexity' | 'size' | 'duplication' | 'style', number>;
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
}

export interface UiFinding {
  ruleId: string; ruleName: string; severity: Severity; message: string; line: number;
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

export function toUiFile(r: FileRecord): UiFile {
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
  };
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
      return { ruleId: f.ruleId, ruleName: rule.name, severity: f.severity, message: f.message, line: f.line,
        debtText: formatDebt(f.debtMinutes), why: rule.why, fix: rule.fix };
    }),
    note: r.analysis.skipReason ? `Skipped: ${r.analysis.skipReason}.`
      : r.analysis.tier === 2 ? `Partial analysis: no parser for ${displayName(r.analysis.languageKey)}. ${r.analysis.fallbackNote ?? ''}`.trim()
        : r.analysis.fallbackNote,
  };
}
