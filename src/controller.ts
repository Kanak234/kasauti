/* =============================================================================
 * KASAUTI — controller.ts
 * -----------------------------------------------------------------------------
 * WHAT:  The conductor. Wires VS Code events to the engine and the engine's
 *        results to every view:
 *          - LIVE MODE: while you type, the file is re-analyzed ~300 ms after
 *            the last keystroke (like HTML Live Preview) — no save needed.
 *          - SCAN: whole workspace, cancellable, files appear one by one.
 *          - WATCHER: files changed outside the editor (git pull, codegen).
 *          - COMMANDS, SETTINGS, and routing messages from the webviews.
 * WHY:   Keeping all orchestration here leaves every other module single-
 *        purpose and testable (engine, store, views know nothing of each other).
 * FLOW:  extension.ts creates Controller -> VS Code events -> analyzeText() ->
 *        cache / worker pool -> store.set() -> store.onChange -> views.
 * ========================================================================== */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AnalysisCache } from './cache';
import { KasautiConfig, readConfig } from './config';
import { skipped } from './engine/analyzer';
import { detectLanguage } from './engine/languages';
import type { FileAnalysis } from './engine/types';
import { toHTML, toJSON, toSARIF } from './export/report';
import type { WebviewMessage } from './protocol';
import { ExcludeFilter, findSourceFiles, readSource, relPathOf } from './scanner';
import { ResultStore } from './store';
import { DiagnosticsView } from './views/diagnostics';
import { CodeLensView, IssuesTree, StatusBarView } from './views/editorViews';
import { CurrentFileView } from './views/currentFile';
import { KasautiFixProvider } from './fixes';
import { History } from './history';
import { EMPTY_CONFIG, mergeThresholds, ProjectConfig, thresholdSources } from './config/projectConfig';
import { parsePackageJsonConfig, parseProjectConfig, SAMPLE_CONFIG } from './config/projectConfig';
import { OverviewView, PyramidPanel, WebviewHost } from './views/webviews';
import { CancelledError, WorkerPool } from './workerPool';

const SCANNED_KEY = 'kasauti.scannedOnce';
/** URI schemes we analyze. 'untitled' = unsaved new files. */
const SCHEMES = new Set(['file', 'untitled', 'vscode-remote', 'vscode-vfs']);

export class Controller implements vscode.Disposable, WebviewHost {
  readonly store: ResultStore;
  private cfg: KasautiConfig;
  private readonly pool: WorkerPool;
  private readonly cache: AnalysisCache;
  private readonly log = vscode.window.createOutputChannel('KASAUTI');
  private readonly subs: vscode.Disposable[] = [];

  // views
  private readonly diagnostics: DiagnosticsView;
  private readonly codeLens: CodeLensView;
  private readonly statusBar: StatusBarView;
  private readonly issues: IssuesTree;
  private readonly overview: OverviewView;
  private readonly pyramid: PyramidPanel;
  /** v0.2.0 F3 */
  private readonly currentFile: CurrentFileView;
  /** v0.2.0 F6 */
  private readonly history: History;
  /** v0.2.0 F5: thresholds the repo asked for, merged under explicit settings. */
  private project: ProjectConfig = EMPTY_CONFIG;
  /** The last real text editor. See onDidChangeActiveTextEditor for why. */
  private lastDoc: vscode.TextDocument | undefined = vscode.window.activeTextEditor?.document;

  /** The document the views should describe: the focused one, or the last one
   *  focused if the user is currently in a panel. */
  activeDocument(): vscode.TextDocument | undefined {
    const ed = vscode.window.activeTextEditor;
    if (ed) { this.lastDoc = ed.document; return ed.document; }
    // Only keep it while it is still open somewhere.
    if (this.lastDoc && vscode.workspace.textDocuments.includes(this.lastDoc)) return this.lastDoc;
    return undefined;
  }

  // state
  private scanned = false;
  private scanning: { done: number; total: number; cts: vscode.CancellationTokenSource } | undefined;
  private filter = ExcludeFilter.empty();
  private watcher: vscode.FileSystemWatcher | undefined;
  private readonly debounce = new Map<string, NodeJS.Timeout>();
  /** Latest request number per file: older results arriving late are dropped. */
  private readonly latest = new Map<string, number>();
  private generation = 0;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.cfg = readConfig();
    // v0.2.0 F5: the project file is read before the store exists, so the very
    // first analysis already uses the repo's thresholds. Explicit VS Code
    // settings still win — see applyThresholds().
    this.project = this.readProjectConfig();
    this.history = new History({
      get: (k) => ctx.workspaceState.get(k),
      update: (k, v) => ctx.workspaceState.update(k, v),
    });
    this.store = new ResultStore(this.effectiveThresholds(), this.cfg.includeTier2InScore);
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist').fsPath;
    this.pool = new WorkerPool(path.join(dist, 'worker.js'), path.join(dist, 'wasm'), undefined, (m) => this.log.appendLine(m));
    this.cache = new AnalysisCache(ctx.storageUri ? path.join(ctx.storageUri.fsPath, 'cache') : undefined);

    this.diagnostics = new DiagnosticsView(this.store, ctx.extensionUri);
    this.diagnostics.setScope(this.cfg.diagnosticsScope);
    this.codeLens = new CodeLensView(this.store);
    this.codeLens.enabled = this.cfg.codeLens;
    this.codeLens.mode = this.cfg.codeLensMode;
    this.codeLens.maxSymbols = this.cfg.codeLensMaxSymbols;
    this.statusBar = new StatusBarView(this.store, () => this.activeDocument());
    this.issues = new IssuesTree(this.store);
    this.overview = new OverviewView(ctx.extensionUri, this);
    this.pyramid = new PyramidPanel(ctx.extensionUri, this);
    this.currentFile = new CurrentFileView(this.store, ctx.extensionUri, () => this.activeDocument());

    this.subs.push(
      this.log, this.diagnostics, this.statusBar, this.overview, this.pyramid,
      vscode.languages.registerCodeLensProvider({ scheme: '*' }, this.codeLens),
      vscode.window.registerTreeDataProvider('kasauti.issues', this.issues),
      vscode.window.registerWebviewViewProvider(OverviewView.id, this.overview),
      vscode.window.registerWebviewViewProvider(CurrentFileView.viewType, this.currentFile),
      // v0.2.0 F4: Quick Fixes. Tier 2 files are refused inside the provider.
      vscode.languages.registerCodeActionsProvider({ scheme: '*' }, new KasautiFixProvider({
        languageKey: (doc) => this.store.get(doc.uri.toString())?.analysis.languageKey,
        isPartial: (doc) => (this.store.get(doc.uri.toString())?.analysis.tier ?? 3) !== 1,
      }), { providedCodeActionKinds: KasautiFixProvider.kinds }),
      // v0.2.0 F5: re-read .kasauti.toml when it is edited, created or deleted.
      this.watchProjectConfig(),
    );

    // Every store change fans out to every view.
    this.subs.push(this.store.onChange((c) => {
      this.diagnostics.refresh(c.changed);
      this.diagnostics.remove(c.removed);
      this.codeLens.refresh();
      this.issues.refresh();
      this.overview.refresh();
      this.pyramid.update(c.changed, c.removed);
      this.statusBar.refresh(this.scanned);
      this.currentFile.refresh();
    }));

    this.registerCommands();
    this.registerEditorEvents();
    this.subs.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('kasauti')) this.onConfig(); }));

    // Analyze what is already open, then re-scan if this workspace was scanned
    // before (warm cache -> seconds). The first scan is always the user's choice.
    for (const ed of vscode.window.visibleTextEditors) this.analyzeDocument(ed.document, 'high');
    if (ctx.workspaceState.get<boolean>(SCANNED_KEY)) void this.scanWorkspace(true);
  }

  /* ======================================================================
   * WebviewHost interface (used by OverviewView / PyramidPanel)
   * ==================================================================== */
  isScanned(): boolean { return this.scanned; }
  scanProgress() { return this.scanning ? { done: this.scanning.done, total: this.scanning.total } : undefined; }
  colorBlind(): boolean { return this.cfg.colorBlindPalette; }
  onMessage(m: WebviewMessage): void {
    if (m.type === 'open') void this.openAt(m.key, m.line);
    else if (m.type === 'command') {
      if (m.id === 'scan') void this.scanWorkspace();
      else if (m.id === 'pyramid') this.openPyramid();
      else if (m.id === 'export') void this.exportReport();
      else if (m.id === 'cancel') this.scanning?.cts.cancel();
    }
  }

  /* ======================================================================
   * Commands
   * ==================================================================== */
  private registerCommands(): void {
    const reg = (id: string, fn: (...a: any[]) => unknown) => this.subs.push(vscode.commands.registerCommand(id, fn));
    reg('kasauti.scanWorkspace', () => this.scanWorkspace());
    reg('kasauti.cancelScan', () => this.scanning?.cts.cancel());
    reg('kasauti.openPyramid', () => this.openPyramid());
    reg('kasauti.showFileDetail', (key?: string) => {
      const k = key ?? vscode.window.activeTextEditor?.document.uri.toString();
      this.openPyramid(k);
    });
    reg('kasauti.exportReport', () => this.exportReport());
    reg('kasauti.toggleIssueGrouping', () => { this.issues.groupByRule = !this.issues.groupByRule; this.issues.refresh(); });
    reg('kasauti.clearCache', async () => {
      await this.cache.clear();
      void vscode.window.showInformationMessage('KASAUTI: analysis cache cleared. The next scan re-analyzes every file.');
    });
    reg('kasauti.showLog', () => this.log.show());
    // ---- v0.2.0 commands -------------------------------------------------
    reg('kasauti.clearHistory', async () => {
      this.history.clear();
      this.overview.refresh();
      void vscode.window.showInformationMessage('KASAUTI: trend history cleared.');
    });
    reg('kasauti.createProjectConfig', () => this.createProjectConfig());
    reg('kasauti.cycleCodeLens', () => {
      const order = ['grade', 'metrics', 'both'] as const;
      this.codeLens.mode = order[(order.indexOf(this.codeLens.mode) + 1) % order.length];
      this.codeLens.refresh();
      void vscode.window.showInformationMessage(`KASAUTI CodeLens: ${this.codeLens.mode}.`);
    });
  }

  private openPyramid(focusKey?: string): void {
    this.pyramid.show(focusKey);
    // Opening the pyramid on an unscanned workspace starts the scan, so the
    // user immediately watches the structure build up block by block.
    if (!this.scanned && !this.scanning && vscode.workspace.workspaceFolders?.length) void this.scanWorkspace();
  }

  private async openAt(key: string, line?: number): Promise<void> {
    const uri = vscode.Uri.parse(key);
    const r = this.store.get(key);
    // Default: jump to the function with the most debt in that file.
    let target = line;
    if (target === undefined && r) {
      const worst = [...r.findings].sort((a, b) => b.debtMinutes - a.debtMinutes)[0];
      target = worst?.line ?? 0;
    }
    const pos = new vscode.Position(target ?? 0, 0);
    await vscode.window.showTextDocument(uri, { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.One, preserveFocus: false });
  }

  /* ======================================================================
   * LIVE MODE — analyze while typing
   * ==================================================================== */
  private registerEditorEvents(): void {
    this.subs.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!this.cfg.liveAnalysis || e.contentChanges.length === 0) return;
        this.scheduleLive(e.document);
      }),
      vscode.workspace.onDidOpenTextDocument((d) => this.analyzeDocument(d, 'high')),
      vscode.workspace.onDidSaveTextDocument((d) => { if (!this.cfg.liveAnalysis) this.analyzeDocument(d, 'high'); }),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        // VS Code reports `undefined` whenever focus moves to a webview panel,
        // the terminal or a settings tab. Treating that as "no file" made the
        // status bar drop the file grade and blanked the Current File panel
        // the moment you clicked the pyramid. Remember the last real editor
        // instead: the file you were last looking at is still the file you
        // mean. Cleared by onDidCloseTextDocument below when it really goes.
        if (!ed) return;
        this.lastDoc = ed.document;
        if (!this.store.get(ed.document.uri.toString())) this.analyzeDocument(ed.document, 'high');
        this.statusBar.refresh(this.scanned);
        this.currentFile.refresh();
      }),
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (this.lastDoc === d) this.lastDoc = undefined;
        // Unsaved scratch buffers have no file on disk: forget them on close.
        if (d.uri.scheme === 'untitled') this.store.remove(d.uri.toString());
      }),
    );
  }

  /** Debounce per document: wait for a pause in typing, then analyze. */
  private scheduleLive(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const t = this.debounce.get(key);
    if (t) clearTimeout(t);
    this.debounce.set(key, setTimeout(() => { this.debounce.delete(key); this.analyzeDocument(doc, 'high'); }, this.cfg.liveDelayMs));
  }

  private analyzeDocument(doc: vscode.TextDocument, lane: 'high' | 'normal'): void {
    if (!SCHEMES.has(doc.uri.scheme)) return;
    // Files may be named anything in 'untitled:'; use the language id then.
    const languageKey = detectLanguage(doc.uri.path, this.cfg.extraTier2Extensions)
      ?? (doc.uri.scheme === 'untitled' ? detectLanguage('x.' + LANG_ID_EXT[doc.languageId]) : undefined);
    if (!languageKey) return;
    const rel = relPathOf(doc.uri);
    const inWorkspace = !!rel && doc.uri.scheme !== 'untitled' && !this.filter.excludes(doc.uri);
    const text = doc.getText();
    if (text.length > this.cfg.maxFileSizeKB * 1024) return;
    // Only cache content that exists on disk (not every keystroke state).
    void this.analyzeText(doc.uri, rel ?? path.basename(doc.uri.path), languageKey, text, inWorkspace, lane, !doc.isDirty);
  }

  /** The single analysis path used by live mode, scan and watcher. */
  private async analyzeText(uri: vscode.Uri, relPath: string, languageKey: string, text: string,
    inWorkspace: boolean, lane: 'high' | 'normal', cacheable: boolean): Promise<void> {
    const key = uri.toString();
    const gen = ++this.generation;
    this.latest.set(key, gen);
    const hash = this.cache.key(languageKey, text);
    try {
      let a: FileAnalysis | undefined = cacheable ? await this.cache.get(hash) : undefined;
      if (!a) {
        a = await this.pool.analyze({ languageKey, path: uri.path, text }, lane);
        if (cacheable) void this.cache.put(hash, a);
      }
      if (this.latest.get(key) !== gen) return;      // a newer edit superseded this
      this.store.set(key, relPath, a, inWorkspace, hash);
    } catch (e) {
      if (e instanceof CancelledError) return;
      this.log.appendLine(`Failed to analyze ${relPath}: ${(e as Error).message}`);
      if (this.latest.get(key) === gen) this.store.set(key, relPath, skipped(languageKey, (e as Error).message), inWorkspace, hash);
    }
  }

  /* ======================================================================
   * WORKSPACE SCAN
   * ==================================================================== */
  async scanWorkspace(silent = false): Promise<void> {
    if (this.scanning) { this.pyramid.show(); return; }
    if (!vscode.workspace.workspaceFolders?.length) {
      if (!silent) void vscode.window.showInformationMessage('KASAUTI: open a folder to analyze its code quality.');
      return;
    }
    const cts = new vscode.CancellationTokenSource();
    this.scanning = { done: 0, total: 0, cts };
    this.overview.refresh();
    const started = Date.now();

    await vscode.window.withProgress({
      location: silent ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
      title: 'KASAUTI: analyzing workspace', cancellable: true,
    }, async (progress, token) => {
      token.onCancellationRequested(() => cts.cancel());
      const { files, filter } = await findSourceFiles(this.cfg, cts.token);
      this.filter = filter;
      if (cts.token.isCancellationRequested) return;
      if (files.length > this.cfg.largeWorkspaceWarning) {
        const go = await vscode.window.showWarningMessage(
          `KASAUTI found ${files.length.toLocaleString()} files. Scanning may take a few minutes. Add "kasauti.exclude" patterns to narrow it.`,
          'Scan anyway', 'Cancel');
        if (go !== 'Scan anyway') return;
      }
      this.scanning!.total = files.length;

      // Forget files that disappeared since the last scan.
      const wanted = new Set(files.map((f) => f.uri.toString()));
      for (const r of this.store.workspaceFiles()) if (!wanted.has(r.key) && !this.isOpen(r.key)) this.store.remove(r.key);

      this.store.beginBatch();
      try {
        // Bounded concurrency: at most 64 files read into memory at once.
        let next = 0;
        const worker = async () => {
          while (next < files.length && !cts.token.isCancellationRequested) {
            const f = files[next++];
            const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === f.uri.toString());
            if (openDoc?.isDirty) {
              // The editor has newer, unsaved text: analyze that, not the disk.
              await this.analyzeText(f.uri, f.relPath, f.languageKey, openDoc.getText(), true, 'normal', false);
            } else {
              const res = await readSource(f.uri, this.cfg.maxFileSizeKB);
              if ('skip' in res) this.store.set(f.uri.toString(), f.relPath, skipped(f.languageKey, res.skip), true);
              else await this.analyzeText(f.uri, f.relPath, f.languageKey, res.text, true, 'normal', true);
            }
            this.scanning!.done++;
            progress.report({ increment: 100 / files.length, message: `${this.scanning!.done} / ${files.length}` });
          }
        };
        await Promise.all(Array.from({ length: 64 }, worker));
      } finally {
        this.store.endBatch();
      }
      if (cts.token.isCancellationRequested) { this.pool.cancelBackground(); return; }
      this.scanned = true;
      void this.ctx.workspaceState.update(SCANNED_KEY, true);
      this.startWatcher();
      const ws = this.store.workspaceScore();
      // v0.2.0 F6: one sample per COMPLETED scan. Live edits are deliberately
      // not recorded — a trend of keystrokes is a trend of typing, not quality.
      this.history.record({
        grade: ws.grade, score: ws.score, debtMinutes: ws.debtMinutes,
        sloc: ws.sloc, files: this.store.workspaceFiles().length,
      });
      this.log.appendLine(`Scanned ${files.length} files in ${((Date.now() - started) / 1000).toFixed(1)} s — workspace grade ${ws.grade} (${ws.score}).`);
    });
    this.scanning = undefined;
    cts.dispose();
    this.overview.refresh();
    this.statusBar.refresh(this.scanned);
    this.currentFile.refresh();
    this.pyramid.update([], []);
  }

  private isOpen(key: string): boolean { return vscode.workspace.textDocuments.some((d) => d.uri.toString() === key); }

  /* ======================================================================
   * v0.2.0 F5 — project configuration
   * ==================================================================== */

  /** Read .kasauti.toml, or the `kasauti` key of package.json, from the first
   *  workspace folder. Never throws: a broken config must not stop activation. */
  private readProjectConfig(): ProjectConfig {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return EMPTY_CONFIG;
    try {
      const toml = path.join(folder.uri.fsPath, '.kasauti.toml');
      if (fs.existsSync(toml)) return parseProjectConfig(fs.readFileSync(toml, 'utf8'));
      const pkg = path.join(folder.uri.fsPath, 'package.json');
      if (fs.existsSync(pkg)) {
        const parsed = parsePackageJsonConfig(JSON.parse(fs.readFileSync(pkg, 'utf8')));
        if (parsed) return parsed;
      }
    } catch (e) {
      this.log.appendLine(`Could not read the project config: ${(e as Error).message}. Using settings and defaults.`);
    }
    return EMPTY_CONFIG;
  }

  /** Defaults < project file < explicit VS Code settings (SPEC R5.1). */
  private effectiveThresholds() {
    return mergeThresholds(this.project.thresholds, this.cfg.explicitThresholds);
  }

  /** For the Overview: which source each threshold came from. */
  thresholdProvenance(): { sources: Record<string, string>; file: string; problems: string[] } {
    return {
      sources: thresholdSources(this.project.thresholds, this.cfg.explicitThresholds),
      file: this.project.source,
      problems: this.project.problems.map((p) => `${p.line ? `line ${p.line}: ` : ''}${p.key} — ${p.message}`),
    };
  }

  /** Trend data for the Overview sparkline (F6). */
  historySeries() { return this.history.series(); }

  private watchProjectConfig(): vscode.Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher('**/{.kasauti.toml,package.json}');
    const reload = () => {
      const before = JSON.stringify(this.project.thresholds);
      this.project = this.readProjectConfig();
      for (const p of this.project.problems) {
        this.log.appendLine(`${this.project.source}${p.line ? `:${p.line}` : ''} — ${p.key}: ${p.message}`);
      }
      if (JSON.stringify(this.project.thresholds) === before) return;   // nothing that affects grades
      this.store.updateSettings(this.effectiveThresholds(), this.cfg.includeTier2InScore);
      this.log.appendLine('Project configuration changed: re-scored every file.');
    };
    watcher.onDidChange(reload); watcher.onDidCreate(reload); watcher.onDidDelete(reload);
    return watcher;
  }

  private async createProjectConfig(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { void vscode.window.showWarningMessage('KASAUTI: open a folder first.'); return; }
    const target = vscode.Uri.joinPath(folder.uri, '.kasauti.toml');
    if (fs.existsSync(target.fsPath)) {
      void vscode.window.showInformationMessage('KASAUTI: .kasauti.toml already exists.');
      await vscode.window.showTextDocument(target);
      return;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(SAMPLE_CONFIG, 'utf8'));
    await vscode.window.showTextDocument(target);
    void vscode.window.showInformationMessage('KASAUTI: created .kasauti.toml. The CI gate stays off until you uncomment the [gate] block.');
  }

  /** Keep results current when files change outside the editor. */
  private startWatcher(): void {
    if (this.watcher) return;
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onChange = async (uri: vscode.Uri) => {
      const languageKey = detectLanguage(uri.path, this.cfg.extraTier2Extensions);
      if (!languageKey || this.filter.excludes(uri)) return;
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (doc) return;                          // open files are handled by live mode
      const res = await readSource(uri, this.cfg.maxFileSizeKB);
      const rel = relPathOf(uri) ?? uri.path;
      if ('skip' in res) this.store.set(uri.toString(), rel, skipped(languageKey, res.skip), true);
      else await this.analyzeText(uri, rel, languageKey, res.text, true, 'normal', true);
    };
    this.subs.push(this.watcher,
      this.watcher.onDidCreate(onChange),
      this.watcher.onDidChange(onChange),
      this.watcher.onDidDelete((uri) => {
        // A deleted folder removes every file under it.
        const prefix = uri.toString();
        for (const r of this.store.all()) if (r.key === prefix || r.key.startsWith(prefix + '/')) this.store.remove(r.key);
      }));
  }

  /* ======================================================================
   * EXPORT
   * ==================================================================== */
  private async exportReport(): Promise<void> {
    if (!this.scanned) {
      const go = await vscode.window.showInformationMessage('KASAUTI: scan the workspace before exporting a report.', 'Scan now');
      if (go) await this.scanWorkspace();
      if (!this.scanned) return;
    }
    const pick = await vscode.window.showQuickPick([
      { label: 'HTML report', description: 'One self-contained file; opens in any browser, offline', ext: 'html' },
      { label: 'SARIF 2.1.0', description: 'For GitHub code scanning and CI tools', ext: 'sarif' },
      { label: 'JSON', description: 'Every metric and finding, machine-readable', ext: 'json' },
    ], { title: 'Export KASAUTI report' });
    if (!pick) return;
    const folder = vscode.workspace.workspaceFolders![0];
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(folder.uri, `kasauti-report.${pick.ext}`),
      filters: { [pick.label]: [pick.ext] },
    });
    if (!target) return;
    const version = String(this.ctx.extension.packageJSON.version ?? '0.0.0');
    const content = pick.ext === 'html' ? toHTML(this.store, version, vscode.workspace.name ?? folder.name)
      : pick.ext === 'sarif' ? toSARIF(this.store, version) : toJSON(this.store, version);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
    const open = await vscode.window.showInformationMessage(`KASAUTI: report saved to ${path.basename(target.fsPath)}.`, 'Open');
    if (open) {
      if (pick.ext === 'html') void vscode.env.openExternal(target);
      else void vscode.window.showTextDocument(target);
    }
  }

  /* ======================================================================
   * SETTINGS
   * ==================================================================== */
  private onConfig(): void {
    const old = this.cfg;
    this.cfg = readConfig();
    this.store.updateSettings(this.effectiveThresholds(), this.cfg.includeTier2InScore);
    this.diagnostics.setScope(this.cfg.diagnosticsScope);
    this.codeLens.enabled = this.cfg.codeLens;
    this.codeLens.mode = this.cfg.codeLensMode;
    this.codeLens.maxSymbols = this.cfg.codeLensMaxSymbols;
    this.codeLens.refresh();
    if (old.colorBlindPalette !== this.cfg.colorBlindPalette) this.pyramid.palette(this.cfg.colorBlindPalette);
    const rescan = JSON.stringify([old.exclude, old.maxFileSizeKB, old.extraTier2Extensions])
      !== JSON.stringify([this.cfg.exclude, this.cfg.maxFileSizeKB, this.cfg.extraTier2Extensions]);
    if (rescan && this.scanned) void this.scanWorkspace(true);
  }

  dispose(): void {
    for (const t of this.debounce.values()) clearTimeout(t);
    this.scanning?.cts.cancel();
    this.pool.dispose();
    this.subs.forEach((s) => s.dispose());
  }
}

/** VS Code language id -> an extension we recognize (for untitled buffers). */
const LANG_ID_EXT: Record<string, string> = {
  python: 'py', javascript: 'js', typescript: 'ts', typescriptreact: 'tsx', javascriptreact: 'jsx', java: 'java',
  c: 'c', cpp: 'cpp', csharp: 'cs', go: 'go', rust: 'rs', ruby: 'rb', php: 'php', kotlin: 'kt', swift: 'swift',
  dart: 'dart', lua: 'lua', scala: 'scala', shellscript: 'sh', 'objective-c': 'm', ocaml: 'ml', elixir: 'ex',
  solidity: 'sol', zig: 'zig', r: 'r', julia: 'jl', perl: 'pl', haskell: 'hs', sql: 'sql', vb: 'vb', fsharp: 'fs',
  powershell: 'ps1', bat: 'bat', html: 'html', css: 'css', scss: 'scss', vue: 'vue', svelte: 'svelte', groovy: 'groovy',
};
