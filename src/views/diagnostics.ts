/* =============================================================================
 * KASAUTI — views/diagnostics.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Shows findings as squiggles + Problems-panel entries (SPEC F5, FR-06).
 * WHY:   The editor is where fixes happen. Squiggles appear/disappear live as
 *        the user types, which closes the Scan -> Detect -> Fix loop.
 *        Scope setting: 'openFiles' (default, like SonarLint) avoids flooding
 *        the Problems panel with thousands of workspace entries.
 * FLOW:  store.onChange -> refresh(keys) -> vscode.DiagnosticCollection
 * ========================================================================== */

import * as vscode from 'vscode';
import type { Finding, Severity } from '../engine/types';
import type { ResultStore } from '../store';

/** Quality findings are advice, never compile errors -> Warning at most. */
const SEVERITY: Record<Severity, vscode.DiagnosticSeverity> = {
  critical: vscode.DiagnosticSeverity.Warning,
  major: vscode.DiagnosticSeverity.Warning,
  minor: vscode.DiagnosticSeverity.Information,
  info: vscode.DiagnosticSeverity.Hint,
};

export class DiagnosticsView implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('kasauti');
  private scope: 'openFiles' | 'workspace' | 'off' = 'openFiles';
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly store: ResultStore, private readonly extensionUri: vscode.Uri) {
    // In 'openFiles' mode, clear a file's diagnostics when its tab closes.
    this.subs.push(vscode.workspace.onDidCloseTextDocument((d) => {
      if (this.scope === 'openFiles') this.collection.delete(d.uri);
    }));
    this.subs.push(vscode.workspace.onDidOpenTextDocument((d) => this.refresh([d.uri.toString()])));
  }

  setScope(scope: 'openFiles' | 'workspace' | 'off'): void {
    this.scope = scope;
    this.collection.clear();
    this.refresh(this.store.all().map((r) => r.key));
  }

  private isOpen(key: string): boolean {
    return vscode.workspace.textDocuments.some((d) => d.uri.toString() === key);
  }

  refresh(keys: string[]): void {
    for (const key of keys) {
      const uri = vscode.Uri.parse(key);
      const r = this.store.get(key);
      if (!r || this.scope === 'off' || (this.scope === 'openFiles' && !this.isOpen(key))) {
        this.collection.delete(uri);
        continue;
      }
      this.collection.set(uri, r.findings.map((f) => this.toDiagnostic(f)));
    }
  }

  remove(keys: string[]): void { for (const k of keys) this.collection.delete(vscode.Uri.parse(k)); }

  private toDiagnostic(f: Finding): vscode.Diagnostic {
    const range = new vscode.Range(f.line, f.col, f.endLine, Math.max(f.endCol, f.line === f.endLine ? f.col + 1 : f.endCol));
    const d = new vscode.Diagnostic(range, f.message, SEVERITY[f.severity]);
    d.source = 'KASAUTI';
    // Clicking the rule id opens the bundled rule documentation page.
    d.code = { value: f.ruleId, target: vscode.Uri.joinPath(this.extensionUri, 'media', 'rules', `${f.ruleId}.md`) };
    if (f.relatedPath !== undefined && f.relatedLine !== undefined) {
      d.relatedInformation = [new vscode.DiagnosticRelatedInformation(
        new vscode.Location(vscode.Uri.parse(f.relatedPath), new vscode.Position(f.relatedLine, 0)), 'Other copy of this code')];
    }
    return d;
  }

  dispose(): void { this.collection.dispose(); this.subs.forEach((s) => s.dispose()); }
}
