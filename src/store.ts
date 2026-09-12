/* =============================================================================
 * KASAUTI — store.ts
 * -----------------------------------------------------------------------------
 * WHAT:  The ONE place that holds every analyzed file: its measurements, its
 *        findings (rules + duplication), and its score. Computes folder and
 *        workspace aggregates and emits a change event whenever anything moves.
 * WHY:   SPEC §B1 — data flows one way: files -> engine -> ResultStore -> views.
 *        Views never compute metrics; they only render what the store holds.
 *        No `vscode` import here, so the store is unit-testable in plain Node.
 * FLOW:  controller.ts calls set()/remove()  ->  store re-evaluates rules and
 *        duplication for affected files  ->  fires onChange(keys)  ->
 *        diagnostics / CodeLens / status bar / tree / pyramid refresh.
 * ========================================================================== */

import { DuplicationIndex } from './engine/duplication';
import { duplicationDebt, evaluate } from './engine/rules';
import { applySuppressions } from './engine/suppress';
import { scoreOf } from './engine/scoring';
import type { FileAnalysis, Finding, FunctionMetrics, ScoreResult, Thresholds } from './engine/types';

export interface FileRecord {
  key: string;             // uri.toString() — unique id of the file
  relPath: string;         // workspace-relative, '/'-separated (for display)
  analysis: FileAnalysis;
  findings: Finding[];
  score: ScoreResult;
  inWorkspace: boolean;    // false for untitled buffers / files outside folders
  contentHash?: string;
}

export interface StoreChange { changed: string[]; removed: string[]; all?: boolean }

/** One analysed function with everything a view needs about it (v0.2.0 F1/F3). */
export interface SymbolRecord {
  fn: FunctionMetrics;
  findings: Finding[];
  score: ScoreResult;
  /** True when the numbers come from Tier 2 estimation, not a real parse. */
  estimated: boolean;
}

/** Rule -> debt category for the Overview breakdown bar. */
export const CATEGORY: Record<string, 'complexity' | 'size' | 'duplication' | 'style'> = {
  CQ001: 'complexity', CQ002: 'complexity', CQ005: 'complexity', CQ008: 'complexity',
  CQ003: 'size', CQ004: 'size', CQ006: 'size', CQ009: 'size',
  CQ007: 'duplication', CQ010: 'style', CQ011: 'style', CQ012: 'style',
};

export class ResultStore {
  private readonly files = new Map<string, FileRecord>();
  private dup: DuplicationIndex;
  private listeners: Array<(c: StoreChange) => void> = [];
  private batchDepth = 0;

  constructor(private thresholds: Thresholds, private includeTier2 = true) {
    this.dup = new DuplicationIndex(thresholds.duplicationTokens);
  }

  /* ---------------- events ---------------------------------------------- */
  onChange(fn: (c: StoreChange) => void): { dispose(): void } {
    this.listeners.push(fn);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== fn); } };
  }
  private emit(c: StoreChange) { for (const l of this.listeners) l(c); }

  /** Bulk mode for a full scan. Files are still emitted one by one, so the
   *  pyramid visibly BUILDS UP while scanning (Kanak's live requirement);
   *  only duplication — which needs every file — is resolved once at the end
   *  instead of after every file (avoids O(n^2) re-evaluation). */
  beginBatch() { this.batchDepth++; }
  endBatch() {
    if (--this.batchDepth > 0) return;
    for (const r of this.files.values()) this.reevaluate(r);
    this.emit({ changed: [...this.files.keys()], removed: [], all: true });
  }

  /* ---------------- mutations ------------------------------------------- */
  set(key: string, relPath: string, analysis: FileAnalysis, inWorkspace: boolean, contentHash?: string): void {
    const rec: FileRecord = { key, relPath, analysis, inWorkspace, contentHash, findings: [], score: scoreOf(0, 0) };
    this.files.set(key, rec);
    let affected = new Set<string>([key]);
    // Only workspace files take part in duplication (not scratch buffers).
    if (inWorkspace && analysis.tier !== 3) affected = this.dup.setFile(key, analysis.tokenIds, analysis.tokenLines, this.batchDepth > 0);
    else affected = new Set([key, ...this.dup.removeFile(key)]);
    if (this.batchDepth > 0) { this.reevaluate(rec); this.emit({ changed: [key], removed: [] }); return; }
    for (const k of affected) { const r = this.files.get(k); if (r) this.reevaluate(r); }
    this.emit({ changed: [...affected].filter((k) => this.files.has(k)), removed: [] });
  }

  remove(key: string): void {
    if (!this.files.delete(key)) return;
    const affected = this.dup.removeFile(key);
    for (const k of affected) { const r = this.files.get(k); if (r) this.reevaluate(r); }
    this.emit({ changed: [...affected].filter((k) => this.files.has(k)), removed: [key] });
  }

  /** Settings changed: re-run rules/scoring (and duplication if its size
   *  threshold changed) WITHOUT re-parsing anything (SPEC §B5). */
  updateSettings(t: Thresholds, includeTier2: boolean): void {
    const dupChanged = t.duplicationTokens !== this.thresholds.duplicationTokens;
    this.thresholds = t;
    this.includeTier2 = includeTier2;
    if (dupChanged) {
      this.dup = new DuplicationIndex(t.duplicationTokens);
      for (const r of this.files.values()) {
        if (r.inWorkspace && r.analysis.tier !== 3) this.dup.setFile(r.key, r.analysis.tokenIds, r.analysis.tokenLines);
      }
    }
    for (const r of this.files.values()) this.reevaluate(r);
    this.emit({ changed: [...this.files.keys()], removed: [], all: true });
  }

  clear(): void {
    const removed = [...this.files.keys()];
    this.files.clear();
    this.dup = new DuplicationIndex(this.thresholds.duplicationTokens);
    this.emit({ changed: [], removed, all: true });
  }

  /** Rules + duplication -> findings -> score, for one file. */
  private reevaluate(r: FileRecord): void {
    let findings = evaluate(r.analysis, this.thresholds);
    if (r.inWorkspace && this.batchDepth === 0) {
      for (const b of this.dup.duplicatesFor(r.key)) {
        const lines = b.endLine - b.startLine + 1;
        const partner = this.files.get(b.partnerPath);
        findings.push({
          ruleId: 'CQ007', severity: lines >= 50 ? 'critical' : 'major',
          message: `${lines} duplicated lines (${b.tokens} tokens) — also in ${partner?.relPath ?? b.partnerPath}:${b.partnerLine + 1}.`,
          line: b.startLine, col: 0, endLine: b.endLine, endCol: r.analysis.lineLengths[b.endLine] ?? 0,
          value: b.tokens, threshold: this.thresholds.duplicationTokens, debtMinutes: duplicationDebt(lines),
          relatedPath: b.partnerPath, relatedLine: b.partnerLine,
        });
      }
    }
    findings.sort((a, b) => a.line - b.line || a.ruleId.localeCompare(b.ruleId));
    // v0.2.0 F4: honour `kasauti-disable-*` comments. Applied last, so a
    // suppressed finding costs no debt and never reaches a view.
    findings = applySuppressions(findings, r.analysis.suppressions ?? []);
    r.findings = findings;
    r.score = scoreOf(findings.reduce((s, f) => s + f.debtMinutes, 0), r.analysis.sloc);
  }

  /* ---------------- queries --------------------------------------------- */
  get(key: string): FileRecord | undefined { return this.files.get(key); }
  all(): FileRecord[] { return [...this.files.values()]; }
  workspaceFiles(): FileRecord[] { return this.all().filter((r) => r.inWorkspace); }
  get size(): number { return this.files.size; }

  /** Does this file count toward folder/workspace scores? */
  counts(r: FileRecord): boolean {
    return r.inWorkspace && r.analysis.tier !== 3 && (this.includeTier2 || r.analysis.tier === 1);
  }

  /** Workspace score: summed debt over summed SLOC (never averaged). */
  workspaceScore(): ScoreResult {
    let debt = 0, sloc = 0;
    for (const r of this.files.values()) if (this.counts(r)) { debt += r.score.debtMinutes; sloc += r.analysis.sloc; }
    return scoreOf(debt, sloc);
  }

  /** Score of every folder prefix, e.g. 'src', 'src/engine'. */
  folderScores(): Map<string, ScoreResult> {
    const acc = new Map<string, { debt: number; sloc: number }>();
    for (const r of this.files.values()) {
      if (!this.counts(r)) continue;
      const parts = r.relPath.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        const a = acc.get(dir) ?? { debt: 0, sloc: 0 };
        a.debt += r.score.debtMinutes; a.sloc += r.analysis.sloc;
        acc.set(dir, a);
      }
    }
    return new Map([...acc].map(([k, v]) => [k, scoreOf(v.debt, v.sloc)]));
  }

  /** Debt minutes per category across the workspace. */
  debtByCategory(): Record<'complexity' | 'size' | 'duplication' | 'style', number> {
    const out = { complexity: 0, size: 0, duplication: 0, style: 0 };
    for (const r of this.files.values()) {
      if (!this.counts(r)) continue;
      for (const f of r.findings) out[CATEGORY[f.ruleId] ?? 'style'] += f.debtMinutes;
    }
    return out;
  }

  /** Files that cost the most to fix. */
  hotspots(n = 5): FileRecord[] {
    return this.workspaceFiles().filter((r) => r.score.debtMinutes > 0)
      .sort((a, b) => b.score.debtMinutes - a.score.debtMinutes).slice(0, n);
  }

  /**
   * v0.2.0: symbol-level read path. CodeLens (F1), the current-file panel (F3)
   * and the detail drawer all read this one method, so they can never disagree
   * about a function's grade. Built once per call in O(findings + functions).
   */
  symbols(r: FileRecord): SymbolRecord[] {
    const byLine = new Map<number, Finding[]>();
    for (const f of r.findings) {
      if (f.symbol === undefined) continue;
      const list = byLine.get(f.line);
      if (list) list.push(f); else byLine.set(f.line, [f]);
    }
    return r.analysis.functions.map((fn) => {
      const findings = (byLine.get(fn.startLine) ?? []).filter((f) => f.symbol === fn.name);
      const debt = findings.reduce((s, f) => s + f.debtMinutes, 0);
      return { fn, findings, score: scoreOf(debt, fn.sloc), estimated: r.analysis.tier === 2 };
    });
  }

  /** Per-function debt & grade, in the order of analysis.functions. */
  functionScores(r: FileRecord): ScoreResult[] { return this.symbols(r).map((s) => s.score); }
}
