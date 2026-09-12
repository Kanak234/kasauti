/* =============================================================================
 * KASAUTI — views/currentFile.ts   (v0.2.0, feature F3)
 * -----------------------------------------------------------------------------
 * WHAT:  A sidebar panel for the file you are looking at right now: its grade,
 *        where the debt is, every function ranked, and every finding.
 * WHY:   The pyramid answers "how is the project?". This answers "how is THIS
 *        file, while I edit it?" — which is the question you have far more
 *        often, and the pyramid is a heavy way to ask it.
 * HOW:   Plain DOM and CSS, no Three.js and no canvas. DELIBERATE: the 3D view
 *        needs a working GPU, and this must keep working where that fails
 *        (remote desktops, old integrated graphics, software rendering).
 * FLOW:  controller -> update(record) -> postMessage -> the webview re-renders
 *        webview -> 'reveal' message -> controller moves the cursor
 * ========================================================================== */

import * as vscode from 'vscode';
import { RULE_BY_ID } from '../engine/rules';
import { formatDebt } from '../engine/scoring';
import type { FileRecord, ResultStore } from '../store';

/** Shape sent to the webview. Kept flat and small: it is posted on every edit. */
interface Payload {
  path?: string;
  grade?: string;
  score?: number;
  debtMinutes?: number;
  debtRatio?: number;
  sloc?: number;
  partial?: boolean;
  reason?: string;                  // set when there is nothing to show, and why
  symbols: Array<{ name: string; line: number; grade: string; cc: number; cog: number; sloc: number; debt: number }>;
  findings: Array<{ ruleId: string; name: string; message: string; line: number; severity: string; debt: number }>;
}

export class CurrentFileView implements vscode.WebviewViewProvider {
  public static readonly viewType = 'kasauti.currentFile';
  private view: vscode.WebviewView | undefined;

  constructor(private readonly store: ResultStore, private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: { type: string; line?: number }) => {
      if (msg.type === 'reveal' && typeof msg.line === 'number') this.reveal(msg.line);
    });
    this.refresh();
  }

  /** Jump the active editor to a line the user clicked in the panel. */
  private reveal(line: number): void {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const pos = new vscode.Position(Math.min(line, ed.document.lineCount - 1), 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** Called by the controller whenever the store or the active editor changes. */
  refresh(): void {
    if (!this.view) return;                 // panel not open: nothing to do
    this.view.webview.postMessage({ type: 'update', payload: this.payload() });
  }

  private payload(): Payload {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return { reason: 'Open a file to see its quality.', symbols: [], findings: [] };
    const r: FileRecord | undefined = this.store.get(ed.document.uri.toString());
    if (!r) return { reason: 'KASAUTI has not analysed this file yet.', symbols: [], findings: [] };
    if (r.analysis.tier === 3) {
      return { reason: `Skipped: ${r.analysis.skipReason ?? 'not a source file'}.`, symbols: [], findings: [] };
    }
    const symbols = this.store.symbols(r)
      .map((s) => ({
        name: s.fn.name, line: s.fn.startLine, grade: s.score.grade,
        cc: s.fn.cyclomatic, cog: s.fn.cognitive, sloc: s.fn.sloc, debt: s.score.debtMinutes,
      }))
      .sort((a, b) => b.debt - a.debt || a.line - b.line)
      .slice(0, 200);
    return {
      path: r.relPath,
      grade: r.score.grade, score: r.score.score,
      debtMinutes: r.score.debtMinutes, debtRatio: r.score.debtRatio,
      sloc: r.analysis.sloc, partial: r.analysis.tier === 2,
      symbols,
      findings: r.findings.slice(0, 300).map((f) => ({
        ruleId: f.ruleId, name: RULE_BY_ID.get(f.ruleId)?.name ?? f.ruleId,
        message: f.message, line: f.line, severity: f.severity, debt: f.debtMinutes,
      })),
    };
  }

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    // No remote resources, no eval: the CSP allows exactly this one script.
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); padding: 10px 12px; }
  .hero { display: flex; align-items: baseline; gap: 10px; margin-bottom: 2px; }
  .grade { font-size: 30px; font-weight: 700; line-height: 1; }
  .A{color:#3fae7a}.B{color:#8fbf45}.C{color:#e3b53b}.D{color:#ea8a3c}.E{color:#df5151}
  .path { opacity: .75; word-break: break-all; font-size: 11px; margin-bottom: 10px; }
  .sub { opacity: .8; font-size: 12px; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; opacity: .7;
       margin: 16px 0 6px; font-weight: 600; }
  .row { display: flex; gap: 8px; align-items: baseline; padding: 3px 4px; border-radius: 3px; cursor: pointer; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .meta { opacity: .65; font-size: 11px; white-space: nowrap; }
  .tag { font-weight: 700; width: 1.1em; display: inline-block; }
  .id { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: .8; }
  .empty { opacity: .7; padding: 20px 0; }
  .warn { background: var(--vscode-inputValidation-warningBackground);
          border: 1px solid var(--vscode-inputValidation-warningBorder);
          padding: 5px 7px; border-radius: 3px; font-size: 11px; margin-bottom: 10px; }
</style></head><body><div id="root" class="empty">Loading…</div>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const mins = (m) => m >= 60 ? (m/60).toFixed(1).replace(/\\.0$/,'') + ' h' : Math.round(m) + ' min';

  window.addEventListener('message', (e) => {
    if (e.data?.type !== 'update') return;
    render(e.data.payload);
  });

  function render(p) {
    const root = document.getElementById('root');
    if (p.reason) { root.className = 'empty'; root.textContent = p.reason; return; }
    root.className = '';
    const parts = [];
    parts.push('<div class="hero"><span class="grade ' + p.grade + '">' + p.grade + '</span>'
      + '<span class="sub">' + p.score + '/100 · ' + mins(p.debtMinutes) + ' to fix · '
      + (p.debtRatio * 100).toFixed(1) + '% of build time · ' + p.sloc + ' lines</span></div>');
    parts.push('<div class="path">' + esc(p.path) + '</div>');
    if (p.partial) parts.push('<div class="warn">Partial analysis: KASAUTI has no parser for this language, '
      + 'so complexity is estimated from indentation and keywords. Treat these numbers as a hint.</div>');

    parts.push('<h3>Functions (' + p.symbols.length + ')</h3>');
    parts.push(p.symbols.length ? p.symbols.map((s) =>
      '<div class="row" data-line="' + s.line + '"><span class="tag ' + s.grade + '">' + s.grade + '</span>'
      + '<span class="name">' + esc(s.name) + '</span>'
      + '<span class="meta">cc ' + s.cc + ' · cog ' + s.cog + ' · ' + s.sloc + 'L'
      + (s.debt ? ' · ' + mins(s.debt) : '') + '</span></div>').join('')
      : '<div class="empty">No functions found.</div>');

    parts.push('<h3>Findings (' + p.findings.length + ')</h3>');
    parts.push(p.findings.length ? p.findings.map((f) =>
      '<div class="row" data-line="' + f.line + '"><span class="id">' + f.ruleId + '</span>'
      + '<span class="name">' + esc(f.message) + '</span>'
      + '<span class="meta">L' + (f.line + 1) + (f.debt ? ' · ' + mins(f.debt) : '') + '</span></div>').join('')
      : '<div class="empty">Nothing to fix here.</div>');

    root.innerHTML = parts.join('');
    for (const el of root.querySelectorAll('.row')) {
      el.addEventListener('click', () => vscodeApi.postMessage({ type: 'reveal', line: Number(el.dataset.line) }));
    }
  }
</script></body></html>`;
  }
}
