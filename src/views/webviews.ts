/* =============================================================================
 * KASAUTI — views/webviews.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Hosts the two HTML views:
 *          OverviewView  — sidebar: score, grade, debt, breakdown, hotspots
 *          PyramidPanel  — editor tab: 3D pyramid / treemap / list + detail
 * WHY:   Webviews are sandboxed pages. This file builds their HTML with a
 *        strict Content-Security-Policy (only our own bundled scripts, with a
 *        nonce; no network — SPEC §B6) and relays store changes to them.
 *        Live updates are BATCHED: many file changes within one animation
 *        frame (~50 ms) become one message, so a full scan does not flood.
 * FLOW:  controller -> pushFiles(keys) -> postMessage -> webview/*.ts renders;
 *        webview -> onDidReceiveMessage -> controller handles commands.
 * ========================================================================== */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { detail, summary, toUiFile } from '../snapshot';
import type { HostMessage, WebviewMessage } from '../protocol';
import type { ResultStore } from '../store';

export interface WebviewHost {
  /** v0.2.0 F6/F5: trend samples and threshold provenance for the Overview. */
  historySeries(): Array<{ t: number; score: number; grade: import('../engine/types').Grade }>;
  thresholdProvenance(): { sources: Record<string, string>; file: string; problems: string[] };
  store: ResultStore;
  isScanned(): boolean;
  scanProgress(): { done: number; total: number } | undefined;
  colorBlind(): boolean;
  onMessage(msg: WebviewMessage): void;
}

/** Build the HTML shell for a webview. */
function shell(webview: vscode.Webview, extUri: vscode.Uri, script: string, title: string, bodyClass: string): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'dist', script));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'dist', 'webview.css'));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>${title}</title>
</head><body class="${bodyClass}">
<div id="app" role="application" aria-label="${title}"></div>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
}

/** Collects changed keys and flushes them once per ~50 ms. */
class Batcher {
  private keys = new Set<string>();
  private removed = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly flush: (upsert: string[], removed: string[]) => void) {}
  add(changed: string[], removed: string[]) {
    changed.forEach((k) => { this.keys.add(k); this.removed.delete(k); });
    removed.forEach((k) => { this.removed.add(k); this.keys.delete(k); });
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      const k = [...this.keys], r = [...this.removed];
      this.keys.clear(); this.removed.clear();
      this.flush(k, r);
    }, 50);
  }
  dispose() { if (this.timer) clearTimeout(this.timer); }
}

/* =============================================================================
 * Sidebar Overview
 * ========================================================================== */
export class OverviewView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly id = 'kasauti.overview';
  private view: vscode.WebviewView | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly extUri: vscode.Uri, private readonly host: WebviewHost) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'dist')] };
    view.webview.html = shell(view.webview, this.extUri, 'overview.js', 'KASAUTI overview', 'overview');
    view.webview.onDidReceiveMessage((m: WebviewMessage) => {
      if (m.type === 'ready') this.post(true);
      else this.host.onMessage(m);
    });
    view.onDidDispose(() => { this.view = undefined; });
  }

  /** Throttled: the sidebar only needs the summary. */
  refresh(): void {
    this.timer ??= setTimeout(() => { this.timer = undefined; this.post(false); }, 120);
  }

  private post(initial: boolean): void {
    if (!this.view) return;
    const s = summary(this.host.store, this.host.isScanned(), this.host.scanProgress());
    // v0.2.0: the sidebar is the only place that shows direction over time and
    // which config won, so both are attached here rather than in summary(),
    // which stays a pure function of the store.
    const trend = this.host.historySeries();
    if (trend.length > 1) s.trend = trend.map((x) => ({ t: x.t, score: x.score, grade: x.grade }));
    const prov = this.host.thresholdProvenance();
    const fromFile = Object.entries(prov.sources).filter(([, v]) => v === 'project file').length;
    const fromSetting = Object.entries(prov.sources).filter(([, v]) => v === 'VS Code setting').length;
    if (fromFile || fromSetting) {
      s.thresholdNote = [
        fromFile ? `${fromFile} threshold${fromFile > 1 ? 's' : ''} from ${prov.file}` : '',
        fromSetting ? `${fromSetting} from your VS Code settings` : '',
      ].filter(Boolean).join(', ') + '.';
    }
    if (prov.problems.length) s.configProblems = prov.problems;
    const msg: HostMessage = initial
      ? { type: 'init', files: [], summary: s, colorBlind: this.host.colorBlind() }
      : { type: 'summary', summary: s };
    void this.view.webview.postMessage(msg);
  }

  dispose(): void { if (this.timer) clearTimeout(this.timer); }
}

/* =============================================================================
 * Pyramid panel (singleton editor tab)
 * ========================================================================== */
export class PyramidPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private pendingFocus: string | undefined;
  private readonly batcher = new Batcher((up, rm) => this.flush(up, rm));

  constructor(private readonly extUri: vscode.Uri, private readonly host: WebviewHost) {}

  get isOpen(): boolean { return !!this.panel; }

  /** Open (or reveal) the panel; optionally focus one file's detail. */
  show(focusKey?: string): void {
    this.pendingFocus = focusKey;
    if (this.panel) {
      this.panel.reveal(undefined, false);
      if (focusKey && this.ready) this.focus(focusKey);
      return;
    }
    this.panel = vscode.window.createWebviewPanel('kasauti.pyramid', 'KASAUTI Pyramid', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,   // keep the 3D scene alive when tab hidden
      localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'dist')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(this.extUri, 'media', 'icon.png');
    this.panel.webview.html = shell(this.panel.webview, this.extUri, 'webview.js', 'KASAUTI pyramid', 'pyramid');
    this.panel.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m));
    this.panel.onDidDispose(() => { this.panel = undefined; this.ready = false; });
  }

  private onMessage(m: WebviewMessage): void {
    if (m.type === 'ready') {
      this.ready = true;
      const files = this.host.store.workspaceFiles().map(toUiFile);
      this.post({ type: 'init', files, summary: summary(this.host.store, this.host.isScanned(), this.host.scanProgress()), colorBlind: this.host.colorBlind() });
      if (this.pendingFocus) this.focus(this.pendingFocus);
      return;
    }
    if (m.type === 'detail') {
      const d = detail(this.host.store, m.key);
      if (d) this.post({ type: 'detail', detail: d });
      return;
    }
    this.host.onMessage(m);
  }

  focus(key: string): void {
    this.pendingFocus = undefined;
    this.post({ type: 'focus', key });
    const d = detail(this.host.store, key);
    if (d) this.post({ type: 'detail', detail: d });
  }

  /** Store changed: queue the keys; they are flushed together. */
  update(changed: string[], removed: string[]): void {
    if (this.panel && this.ready) this.batcher.add(changed, removed);
  }

  private flush(keys: string[], removed: string[]): void {
    const upsert = keys.map((k) => this.host.store.get(k)).filter((r) => r && r.inWorkspace).map((r) => toUiFile(r!));
    this.post({ type: 'files', upsert, remove: removed, summary: summary(this.host.store, this.host.isScanned(), this.host.scanProgress()) });
  }

  palette(colorBlind: boolean): void { this.post({ type: 'palette', colorBlind }); }

  private post(msg: HostMessage): void { void this.panel?.webview.postMessage(msg); }

  dispose(): void { this.batcher.dispose(); this.panel?.dispose(); }
}
