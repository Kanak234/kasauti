/* =============================================================================
 * KASAUTI — views/editorViews.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Three small native views:
 *        1. CodeLensView  — "Grade D · complexity 14 · cognitive 22" above
 *                           every function (SPEC F6)
 *        2. StatusBarView — current file grade + workspace score (SPEC F7)
 *        3. IssuesTree    — sidebar tree: file -> findings, or rule -> findings
 * WHY:   They follow the user's VS Code theme exactly (UI brief §C1) and put
 *        the grade where the eyes already are. All three update live.
 * FLOW:  store.onChange -> controller -> refresh() on each view.
 * ========================================================================== */

import * as vscode from 'vscode';
import { RULE_BY_ID } from '../engine/rules';
import { formatDebt } from '../engine/scoring';
import type { Finding, Severity } from '../engine/types';
import type { FileRecord, ResultStore } from '../store';

/* =============================================================================
 * 1. CodeLens
 * ========================================================================== */
export class CodeLensView implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  enabled = true;
  /** v0.2.0 F1: what the lens shows. 'grade' is the least noisy. */
  mode: 'grade' | 'metrics' | 'both' = 'both';
  /** v0.2.0 F1: a 4000-function generated file must not get 4000 lenses. */
  maxSymbols = 300;

  constructor(private readonly store: ResultStore) {}

  refresh(): void { this.emitter.fire(); }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.enabled) return [];
    const r = this.store.get(doc.uri.toString());
    // Tier 3 is skipped entirely; tier 2 positions are heuristics, so no lens.
    if (!r || r.analysis.tier !== 1) return [];
    const symbols = this.store.symbols(r);
    if (symbols.length > this.maxSymbols) return [];   // generated file: stay quiet
    return symbols.map(({ fn: f, score, findings }) => {
      if (f.startLine >= doc.lineCount) return undefined;
      const range = new vscode.Range(f.startLine, 0, f.startLine, 0);
      const metrics = `complexity ${f.cyclomatic}  ·  cognitive ${f.cognitive}  ·  ${f.sloc} lines`;
      const title = this.mode === 'grade' ? `$(pulse) Grade ${score.grade}`
        : this.mode === 'metrics' ? `$(pulse) ${metrics}`
          : `$(pulse) Grade ${score.grade}  ·  ${metrics}`;
      const worst = findings.slice().sort((a, b) => b.debtMinutes - a.debtMinutes)[0];
      return new vscode.CodeLens(range, {
        title: findings.length ? `${title}  ·  ${findings.length} finding${findings.length > 1 ? 's' : ''}` : title,
        tooltip: `KASAUTI: ${f.name}\nGrade ${score.grade}, ${formatDebt(score.debtMinutes)} to fix.\n`
          + `Cyclomatic ${f.cyclomatic}, cognitive ${f.cognitive}, nesting ${f.maxNesting}, ${f.params} parameters, maintainability ${f.mi.toFixed(0)}/100.`
          + (worst ? `\nLargest finding: ${worst.ruleId} ${worst.message}` : '')
          + '\nClick to open this function in the detail drawer.',
        command: 'kasauti.showFileDetail',
        arguments: [r.key, f.startLine],
      });
    }).filter((x): x is vscode.CodeLens => !!x);
  }
}

/* =============================================================================
 * 2. Status bar
 * ========================================================================== */
export class StatusBarView implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

  constructor(private readonly store: ResultStore) {
    this.item.command = 'kasauti.openPyramid';
    this.item.name = 'KASAUTI code quality';
  }

  /** v0.2.0 F2: shown while a scan or a re-analysis is running. */
  setBusy(busy: boolean): void { this.busy = busy; }
  private busy = false;

  refresh(scanned: boolean): void {
    const ed = vscode.window.activeTextEditor;
    const r = ed ? this.store.get(ed.document.uri.toString()) : undefined;
    if (this.busy) {
      this.item.text = '$(sync~spin) KASAUTI …';
      this.item.tooltip = 'KASAUTI is analysing.';
      this.item.show();
      return;
    }
    const parts: string[] = [];
    const tip: string[] = [];
    if (r && r.analysis.tier !== 3) {
      // The tilde is the same "partial" marker the pyramid and the CLI use.
      const mark = r.analysis.tier === 2 ? '~' : '';
      parts.push(`File ${r.score.grade}${mark} ${(r.score.debtRatio * 100).toFixed(1)}%`);
      tip.push(`This file: grade ${r.score.grade}, score ${r.score.score}/100, debt ${formatDebt(r.score.debtMinutes)} `
        + `(${(r.score.debtRatio * 100).toFixed(1)}% of the time it would take to write it)`
        + `${r.analysis.tier === 2 ? '. Partial analysis: no parser for this language, so the numbers are estimates' : ''}.`);
    }
    if (scanned) {
      const ws = this.store.workspaceScore();
      parts.push(`Workspace ${ws.grade} ${ws.score}`);
      tip.push(`Workspace: grade ${ws.grade}, score ${ws.score}/100, debt ${formatDebt(ws.debtMinutes)}.`);
    }
    // Nothing to say about this file and no scan yet: get out of the way.
    if (!parts.length) { this.item.hide(); return; }
    this.item.text = `$(pulse) ${parts.join('  ')}`;
    this.item.tooltip = tip.join('\n') + '\nClick to open the pyramid.';
    this.item.show();
  }

  dispose(): void { this.item.dispose(); }
}

/* =============================================================================
 * 3. Issues tree
 * ========================================================================== */
type Node =
  | { kind: 'file'; rec: FileRecord }
  | { kind: 'rule'; ruleId: string; items: Array<{ rec: FileRecord; f: Finding }> }
  | { kind: 'finding'; rec: FileRecord; f: Finding };

const SEV_ORDER: Record<Severity, number> = { critical: 0, major: 1, minor: 2, info: 3 };
const SEV_ICON: Record<Severity, vscode.ThemeIcon> = {
  critical: new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground')),
  major: new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground')),
  minor: new vscode.ThemeIcon('info'),
  info: new vscode.ThemeIcon('lightbulb'),
};

export class IssuesTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  groupByRule = false;

  constructor(private readonly store: ResultStore) {}

  refresh(): void { this.emitter.fire(undefined); }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const recs = this.store.all().filter((r) => r.findings.length > 0 && (r.inWorkspace || this.isOpen(r.key)));
      if (this.groupByRule) {
        const by = new Map<string, Array<{ rec: FileRecord; f: Finding }>>();
        for (const rec of recs) for (const f of rec.findings) {
          const list = by.get(f.ruleId) ?? [];
          list.push({ rec, f });
          by.set(f.ruleId, list);
        }
        return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))
          .map(([ruleId, items]) => ({ kind: 'rule', ruleId, items }));
      }
      return recs.sort((a, b) => b.score.debtMinutes - a.score.debtMinutes).map((rec) => ({ kind: 'file', rec }));
    }
    if (node.kind === 'file') {
      return [...node.rec.findings].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.line - b.line)
        .map((f) => ({ kind: 'finding', rec: node.rec, f }));
    }
    if (node.kind === 'rule') return node.items.map(({ rec, f }) => ({ kind: 'finding', rec, f }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'file') {
      const it = new vscode.TreeItem(node.rec.relPath.split('/').pop()!, vscode.TreeItemCollapsibleState.Collapsed);
      it.description = `${node.rec.score.grade}  ${formatDebt(node.rec.score.debtMinutes)}  ${node.rec.relPath}`;
      it.resourceUri = vscode.Uri.parse(node.rec.key);
      it.iconPath = vscode.ThemeIcon.File;
      it.tooltip = `${node.rec.relPath}\nGrade ${node.rec.score.grade}, score ${node.rec.score.score}/100, ${node.rec.findings.length} findings`;
      return it;
    }
    if (node.kind === 'rule') {
      const rule = RULE_BY_ID.get(node.ruleId)!;
      const it = new vscode.TreeItem(`${node.ruleId} ${rule.name}`, vscode.TreeItemCollapsibleState.Collapsed);
      it.description = `${node.items.length}`;
      it.tooltip = rule.summary;
      return it;
    }
    const { f, rec } = node;
    const rule = RULE_BY_ID.get(f.ruleId)!;
    const it = new vscode.TreeItem(f.message, vscode.TreeItemCollapsibleState.None);
    it.description = this.groupByRule ? `${rec.relPath}:${f.line + 1}` : `${f.ruleId}  line ${f.line + 1}`;
    it.iconPath = SEV_ICON[f.severity];
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${f.ruleId} — ${rule.name}**\n\n${f.message}\n\n${rule.why}\n\n**How to fix**\n`);
    for (const step of rule.fix) md.appendMarkdown(`\n- ${step}`);
    md.appendMarkdown(`\n\nRemediation estimate: ${formatDebt(f.debtMinutes)}`);
    it.tooltip = md;
    it.command = {
      command: 'vscode.open', title: 'Open',
      arguments: [vscode.Uri.parse(rec.key), { selection: new vscode.Range(f.line, f.col, f.line, f.col) }],
    };
    return it;
  }

  private isOpen(key: string): boolean { return vscode.workspace.textDocuments.some((d) => d.uri.toString() === key); }
}
