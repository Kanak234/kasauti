/* =============================================================================
 * KASAUTI — views/parakh.ts   (v2.0 "Parakh" — परख, "testing / assaying")
 * -----------------------------------------------------------------------------
 * WHAT:  Everything v2 adds to the editor, in one host-side module:
 *          - dependency / slopsquatting check after each analysis (KP301–303)
 *          - "Prove Complexity" command + CodeLens
 *          - "Fix with AI (Verified)" command + CodeLens, any model:
 *              Ollama · LM Studio · OpenAI · Anthropic · NVIDIA (Nemotron) ·
 *              OpenRouter · Groq · custom OpenAI-compatible · VS Code models
 *          - provider / key setup (keys ONLY in SecretStorage)
 *          - MCP config for agent harnesses, AI scoreboard
 * WHY:   Kept out of controller.ts so the v0.2 orchestration stays readable;
 *        the controller only forwards two events here (analysis finished,
 *        settings changed). Every risky step asks first:
 *          code leaving the machine  -> consent per cloud provider
 *          running code              -> trusted workspace + consent per workspace
 *          changing the user's file  -> only on "Apply", one undoable edit
 * FLOW:  controller.analyzeText -> afterAnalyze() -> store.setExternal()
 *        command -> pick function -> extract -> (bench | runFixLoop) ->
 *        proof panel (proofHtml.ts) -> Apply -> WorkspaceEdit.
 * ========================================================================== */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ResultStore } from '../store';
import type { FileAnalysis, Finding, FunctionMetrics } from '../engine/types';
import { displayName } from '../engine/languages';
import { checkImports, checkRegistry, DepContext, ecosystemOf, Ecosystem, MANIFEST_GLOB, normalize, parseManifest } from '../audit/deps';
import { power } from '../audit/astAudit';
import { extractFunction, guessInputKind, INPUT_KINDS, INPUT_LABELS, InputKind, paramNames, proveLanguage } from '../prove/core';
import { bench, equivalent, findPython, RunnerOptions } from '../prove/runner';
import { chat, isLocalUrl, presetById, PRESETS, ResolvedProvider, ChatMessage } from '../ai/providers';
import { FixReport, runFixLoop } from '../ai/verify';
import { proofHtml, ProofData } from './proofHtml';

const EXEC_CONSENT = 'kasauti.execConsent';
const CLOUD_CONSENT = 'kasauti.cloudConsent.';
const SCOREBOARD = 'kasauti.aiScoreboard';
const KEY_PREFIX = 'kasauti.ai.key.';
const SNIPPET_EXT: Record<string, string> = { python: 'py', javascript: 'js', typescript: 'ts', tsx: 'tsx', java: 'java' };

export interface ParakhHost {
  store: ResultStore;
  /** Analyze a snippet with the real worker (same rules as the editor). */
  analyzeSnippet(languageKey: string, text: string): Promise<FileAnalysis>;
  log(line: string): void;
}

export class Parakh implements vscode.Disposable {
  private readonly subs: vscode.Disposable[] = [];
  /** Manifest names per workspace folder + ecosystem; dropped when a manifest changes. */
  private readonly manifestCache = new Map<string, Promise<DepContext>>();
  private panel: vscode.WebviewPanel | undefined;
  private pending: { uri: vscode.Uri; fn: FunctionMetrics; report: FixReport; original: string } | undefined;
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  private readonly logo: string;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly host: ParakhHost) {
    this.logo = fs.readFileSync(path.join(ctx.extensionUri.fsPath, 'media', 'logo-mark.svg'), 'utf8').replace(/<title>.*?<\/title>/, '');
    const reg = (id: string, fn: (...a: any[]) => unknown) => this.subs.push(vscode.commands.registerCommand(id, fn));
    reg('kasauti.proveComplexity', (uri?: vscode.Uri, line?: number) => this.prove(uri, line));
    reg('kasauti.fixWithAI', (uri?: vscode.Uri, line?: number) => this.fixWithAI(uri, line));
    reg('kasauti.chooseAIProvider', () => this.chooseProvider());
    reg('kasauti.setAIKey', () => this.setKey());
    reg('kasauti.copyMcpConfig', () => this.copyMcpConfig());
    reg('kasauti.showAIScoreboard', () => this.showScoreboard());
    reg('kasauti.forgetPermissions', async () => {
      await ctx.workspaceState.update(EXEC_CONSENT, undefined);
      for (const p of PRESETS) await ctx.globalState.update(CLOUD_CONSENT + p.id, undefined);
      void vscode.window.showInformationMessage('KASAUTI: code-execution and cloud-AI permissions forgotten. You will be asked again.');
    });
    // Manifests changed -> forget cached declarations and re-check open files.
    const w = vscode.workspace.createFileSystemWatcher(MANIFEST_GLOB);
    const reset = () => { this.manifestCache.clear(); for (const d of vscode.workspace.textDocuments) this.recheck(d); };
    w.onDidChange(reset); w.onDidCreate(reset); w.onDidDelete(reset);
    this.subs.push(w, this.lensEmitter,
      vscode.languages.registerCodeLensProvider([{ language: 'python' }, { language: 'javascript' }, { language: 'typescript' }, { language: 'typescriptreact' }, { language: 'java' }],
        { onDidChangeCodeLenses: this.lensEmitter.event, provideCodeLenses: (doc) => this.lenses(doc) }),
      host.store.onChange(() => this.lensEmitter.fire()));
    host.store.setAuditEnabled(this.cfg().get('audit.enabled', true));
    // Keep a stable copy of the MCP server in sync with this version (if the user set one up).
    void this.syncMcpCopy(false);
  }

  dispose(): void { this.panel?.dispose(); for (const s of this.subs) s.dispose(); }
  private cfg() { return vscode.workspace.getConfiguration('kasauti'); }
  onConfig(): void { this.host.store.setAuditEnabled(this.cfg().get('audit.enabled', true)); }

  /* ========================================================================
   * 1. Dependency check (runs after every analysis; cheap, offline by default)
   * ====================================================================== */
  async afterAnalyze(uri: vscode.Uri, languageKey: string, text: string, inWorkspace: boolean): Promise<void> {
    const eco = ecosystemOf(languageKey);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!eco || !inWorkspace || !folder || uri.scheme !== 'file') return;
    try {
      const dctx = await this.depContext(folder, eco, uri);
      const key = uri.toString();
      const offline = checkImports(languageKey, text, dctx);
      this.host.store.setExternal(key, offline);
      if (this.cfg().get('audit.checkRegistry', false)) {
        const online = await checkRegistry(languageKey, text, dctx);
        this.host.store.setExternal(key, [...offline, ...online]);
      }
    } catch (e) { this.host.log(`dependency check failed for ${uri.fsPath}: ${(e as Error).message}`); }
  }

  private recheck(doc: vscode.TextDocument): void {
    const rec = this.host.store.get(doc.uri.toString());
    if (rec) void this.afterAnalyze(doc.uri, rec.analysis.languageKey, doc.getText(), rec.inWorkspace);
  }

  private depContext(folder: vscode.WorkspaceFolder, eco: Ecosystem, file: vscode.Uri): Promise<DepContext> {
    const k = `${folder.uri.toString()}|${eco}`;
    let p = this.manifestCache.get(k);
    if (!p) {
      p = (async () => {
        const declared = new Set<string>();
        let hasManifest = false;
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, MANIFEST_GLOB), '**/{node_modules,.venv,venv,.git,dist,build}/**', 200);
        for (const f of files) {
          const m = parseManifest(f.fsPath, Buffer.from(await vscode.workspace.fs.readFile(f)).toString('utf8'));
          if (m && m.ecosystem === eco) { hasManifest = true; m.names.forEach((n) => declared.add(normalize(n))); }
        }
        return { declared, hasManifest, isLocal: () => false };
      })();
      this.manifestCache.set(k, p);
    }
    // isLocal depends on the importing file's folder, so it is added per call.
    return p.then((base) => ({ ...base, isLocal: (name: string) => {
      const roots = [folder.uri.fsPath, path.dirname(file.fsPath), path.join(folder.uri.fsPath, 'src')];
      return roots.some((r) => [`${name}.py`, name, `${name}.js`, `${name}.ts`, `${name}.pyi`].some((c) => fs.existsSync(path.join(r, c))));
    } }));
  }

  /* ========================================================================
   * 2. CodeLens: only above functions that have something to act on
   * ====================================================================== */
  private lenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const rec = this.host.store.get(doc.uri.toString());
    if (!rec || rec.analysis.tier !== 1 || !this.cfg().get('codeLens.enabled', true)) return [];
    const out: vscode.CodeLens[] = [];
    for (const fn of rec.analysis.functions) {
      const kp = rec.findings.filter((f) => f.ruleId.startsWith('KP') && f.line >= fn.startLine && f.line <= fn.endLine);
      if (!kp.length) continue;
      const range = new vscode.Range(fn.startLine, 0, fn.startLine, 0);
      out.push(new vscode.CodeLens(range, { title: `$(sparkle) Fix ${kp.length} issue${kp.length > 1 ? 's' : ''} with AI (verified)`, command: 'kasauti.fixWithAI', arguments: [doc.uri, fn.startLine] }));
      if (kp.some((f) => f.ruleId === 'KP101' || f.ruleId === 'KP105') && proveLanguage(rec.analysis.languageKey))
        out.push(new vscode.CodeLens(range, { title: '$(graph-line) Prove complexity', command: 'kasauti.proveComplexity', arguments: [doc.uri, fn.startLine] }));
    }
    return out;
  }

  /* ========================================================================
   * Shared: which function is the user pointing at?
   * ====================================================================== */
  private async target(uri?: vscode.Uri, line?: number): Promise<{ doc: vscode.TextDocument; fn: FunctionMetrics; analysis: FileAnalysis; findings: Finding[] } | undefined> {
    const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!doc) { void vscode.window.showWarningMessage('KASAUTI: open a file and put the cursor inside a function.'); return undefined; }
    const at = line ?? vscode.window.activeTextEditor?.selection.active.line ?? 0;
    const rec = this.host.store.get(doc.uri.toString());
    if (!rec || rec.analysis.tier !== 1) { void vscode.window.showWarningMessage('KASAUTI: this file has no full analysis yet (or its language has no parser).'); return undefined; }
    // Innermost function containing the line.
    const fn = rec.analysis.functions.filter((f) => f.startLine <= at && at <= f.endLine).sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
    if (!fn) { void vscode.window.showWarningMessage('KASAUTI: put the cursor inside a function first.'); return undefined; }
    return { doc, fn, analysis: rec.analysis, findings: rec.findings.filter((f) => f.line >= fn.startLine && f.line <= fn.endLine) };
  }

  /** Ask once per workspace before running any code. Untrusted workspaces never run code. */
  private async execAllowed(fnName: string): Promise<boolean> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('KASAUTI does not run code in an untrusted workspace. Trust the folder first (Manage Workspace Trust).');
      return false;
    }
    if (this.ctx.workspaceState.get<boolean>(EXEC_CONSENT)) return true;
    const ok = await vscode.window.showWarningMessage(
      `KASAUTI will RUN '${fnName}' (and, for AI fixes, the candidate code after it passes the security audit) on generated inputs, using your Python/Node in an empty temporary folder, with a time limit and without your environment variables. This is not a sandbox — allow it only for code you would run yourself.`,
      { modal: true }, 'Allow for this workspace');
    if (ok) await this.ctx.workspaceState.update(EXEC_CONSENT, true);
    return !!ok;
  }

  private async runnerOptions(): Promise<RunnerOptions | undefined> {
    const configured = this.cfg().get<string>('prove.pythonPath', '') || vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath') || undefined;
    const python = await findPython(configured && configured !== 'python' ? configured : undefined);
    return { harnessDir: path.join(this.ctx.extensionUri.fsPath, 'media', 'harness'), python, timeoutMs: this.cfg().get('prove.timeoutSeconds', 30) * 1000 };
  }

  private async pickKind(params: string[]): Promise<InputKind | undefined> {
    const guess = guessInputKind(params);
    const items = [guess, ...INPUT_KINDS.filter((k) => k !== guess)].map((k) => ({ label: INPUT_LABELS[k], description: k === guess ? 'guessed from the parameter names' : '', inputKind: k }));
    const pick = await vscode.window.showQuickPick(items, { title: `KASAUTI: what does the function take? (${params.join(', ') || 'no parameters'})`, placeHolder: 'KASAUTI generates inputs of this shape at growing sizes' });
    return pick?.inputKind;
  }

  /* ========================================================================
   * 3. Prove Complexity
   * ====================================================================== */
  private async prove(uri?: vscode.Uri, line?: number): Promise<void> {
    const t = await this.target(uri, line);
    if (!t) return;
    const lang = proveLanguage(t.analysis.languageKey);
    if (!lang) { void vscode.window.showWarningMessage(`KASAUTI: Prove supports Python and JavaScript functions (this is ${displayName(t.analysis.languageKey)}).`); return; }
    const ex = extractFunction(t.doc.getText(), lang, t.analysis.functions, t.fn);
    if (ex.error) { void vscode.window.showWarningMessage(`KASAUTI: ${ex.error}`); return; }
    const kind = await this.pickKind(ex.params);
    if (!kind || !(await this.execAllowed(ex.name))) return;
    const opt = await this.runnerOptions();
    if (lang === 'python' && !opt?.python) { void vscode.window.showErrorMessage('KASAUTI: Python 3.8+ was not found. Set "kasauti.prove.pythonPath".'); return; }
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `KASAUTI: measuring ${ex.name} at growing n…` },
      () => bench(lang, ex.code, ex.name, kind, opt!));
    const kp101 = t.findings.find((f) => f.ruleId === 'KP101');
    const staticEstimate = kp101 ? /O\([^)]*\)/.exec(kp101.message)?.[0] : t.findings.some((f) => f.ruleId === 'KP105') ? 'O(2ⁿ) (recursion)' : `O(${power(1)}) or better (no nested input loops found)`;
    this.host.log(`prove ${ex.name}: ${r.fit?.best ?? r.error} (${r.points.length} points)`);
    this.showPanel({ kind: 'prove', fnName: ex.name, file: vscode.workspace.asRelativePath(t.doc.uri), points: r.points, fit: r.fit, error: r.error, inputLabel: INPUT_LABELS[kind], staticEstimate });
  }

  /* ========================================================================
   * 4. Fix with AI (Verified)
   * ====================================================================== */
  private async fixWithAI(uri?: vscode.Uri, line?: number): Promise<void> {
    const t = await this.target(uri, line);
    if (!t) return;
    const provider = await this.resolveProvider();
    if (!provider) return;
    if (!(await this.cloudConsent(provider))) return;

    const lines = t.doc.getText().split(/\r?\n/);
    let start = t.fn.startLine;
    if (t.analysis.languageKey === 'python') while (start > 0 && /^\s*@/.test(lines[start - 1])) start--;   // include decorators
    const indent = /^\s*/.exec(lines[start])![0];
    const original = lines.slice(start, t.fn.endLine + 1).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart())).join('\n') + '\n';
    const lang = proveLanguage(t.analysis.languageKey);
    const ex = lang ? extractFunction(t.doc.getText(), lang, t.analysis.functions, t.fn) : undefined;
    const provable = lang && ex && !ex.error ? lang : undefined;
    let kind: InputKind | undefined;
    let runnerOpt: RunnerOptions | undefined;
    if (provable) {
      kind = await this.pickKind(ex!.params);
      if (!kind) return;
      if (await this.execAllowed(ex!.name)) runnerOpt = await this.runnerOptions();
      if (provable === 'python' && runnerOpt && !runnerOpt.python) { runnerOpt = undefined; void vscode.window.showWarningMessage('KASAUTI: Python not found — the fix will be checked statically only.'); }
    }
    const name = ex?.name ?? t.fn.name;
    const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `KASAUTI · ${provider.label}`, cancellable: true }, (progress, token) =>
      runFixLoop({
        languageKey: t.analysis.languageKey, language: displayName(t.analysis.languageKey), fnName: name, original,
        preamble: provable ? ex!.preamble : undefined, findings: t.findings, startLine: start, provable, kind,
        maxAttempts: Math.max(1, Math.min(6, this.cfg().get('ai.maxAttempts', 3))), provider: `${provider.label} · ${provider.model}`,
      }, {
        ask: (m) => this.ask(provider, m, token),
        audit: async (code) => { const a = await this.host.analyzeSnippet(t.analysis.languageKey, code); return { findings: a.audit ?? [], syntaxError: a.hasSyntaxErrors }; },
        runner: runnerOpt && provable && kind ? {
          equivalent: (a, b) => equivalent(provable, a, b, name, kind!, runnerOpt!),
          bench: (c) => bench(provable, c, name, kind!, runnerOpt!),
        } : undefined,
        isCancelled: () => token.isCancellationRequested,
        onProgress: (m) => progress.report({ message: m }),
      }));
    this.record(provider, report);
    this.host.log(`AI fix ${name} via ${provider.label}/${provider.model}: ${report.passed ? 'VERIFIED' : 'rejected'} after ${report.attempts.length} attempt(s)${report.error ? ' — ' + report.error : ''}`);
    this.pending = report.passed ? { uri: t.doc.uri, fn: t.fn, report, original } : undefined;
    this.showPanel({ kind: 'fix', fnName: name, file: vscode.workspace.asRelativePath(t.doc.uri), report });
    if (report.passed) void this.showDiff();
  }

  /** Send a chat to the chosen provider (HTTP) or to VS Code's own models. */
  private async ask(p: ResolvedProvider, messages: ChatMessage[], token: vscode.CancellationToken): Promise<string> {
    if (p.id === 'vscode-lm') {
      const lm = (vscode as any).lm;
      if (!lm?.selectChatModels) throw new Error('This VS Code version has no language-model API. Update VS Code or choose another provider.');
      const models = await lm.selectChatModels(p.model ? { id: p.model } : {});
      if (!models.length) throw new Error('No VS Code language model is available (is GitHub Copilot Chat installed and signed in?).');
      const Msg = (vscode as any).LanguageModelChatMessage;
      // The LM API has no system role: the rules go first in the user turn.
      const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      const rest = messages.filter((m) => m.role !== 'system').map((m, i) => (m.role === 'user' ? Msg.User(i === 0 ? `${sys}\n\n${m.content}` : m.content) : Msg.Assistant(m.content)));
      const res = await models[0].sendRequest(rest, {}, token);
      let out = '';
      for await (const chunk of res.text) out += chunk;
      return out;
    }
    const ac = new AbortController();
    const sub = token.onCancellationRequested(() => ac.abort());
    try { return await chat(p, messages, { signal: AbortSignal.any ? AbortSignal.any([ac.signal, AbortSignal.timeout(180_000)]) : ac.signal }); } finally { sub.dispose(); }
  }

  /* ========================================================================
   * Provider setup
   * ====================================================================== */
  private async resolveProvider(): Promise<ResolvedProvider | undefined> {
    const id = this.cfg().get<string>('ai.provider', 'ollama');
    let model = this.cfg().get<string>('ai.model', '');
    if (id === 'vscode-lm') return { id, format: 'openai', baseUrl: '', model, label: 'VS Code language model' };
    const preset = presetById(id);
    if (!preset) { void vscode.window.showErrorMessage(`KASAUTI: unknown AI provider "${id}".`); return undefined; }
    const baseUrl = this.cfg().get<string>('ai.baseUrl', '') || preset.baseUrl;
    if (!baseUrl) { await this.chooseProvider(); return undefined; }
    model ||= preset.defaultModel;
    if (!model) {
      model = (await vscode.window.showInputBox({ title: `KASAUTI · ${preset.label}: model id`, prompt: 'Exactly as your provider lists it', ignoreFocusOut: true })) ?? '';
      if (!model) return undefined;
      await this.cfg().update('ai.model', model, vscode.ConfigurationTarget.Global);
    }
    let apiKey = await this.ctx.secrets.get(KEY_PREFIX + id);
    if (!apiKey && preset.needsKey) { apiKey = await this.setKey(id); if (!apiKey) return undefined; }
    return { id, format: preset.format, baseUrl, model, apiKey, label: preset.label.replace(/ \(.*\)$/, '') };
  }

  /** First use of a cloud provider: say plainly that code leaves the machine. */
  private async cloudConsent(p: ResolvedProvider): Promise<boolean> {
    if (p.id === 'vscode-lm' || isLocalUrl(p.baseUrl) || this.ctx.globalState.get<boolean>(CLOUD_CONSENT + p.id)) return true;
    const ok = await vscode.window.showWarningMessage(`The function you fix and its findings will be sent to ${p.label} (${new URL(p.baseUrl).host}). Secrets in it are sent too. Continue?`, { modal: true }, 'Send', 'Always for this provider');
    if (ok === 'Always for this provider') await this.ctx.globalState.update(CLOUD_CONSENT + p.id, true);
    return !!ok;
  }

  private async chooseProvider(): Promise<void> {
    const items = [...PRESETS.map((p) => ({ label: p.label, description: p.local ? 'code stays on this computer' : p.needsKey ? 'needs an API key' : '', id: p.id })),
      { label: 'VS Code language models (Copilot …)', description: 'uses the models your editor already has', id: 'vscode-lm' }];
    const pick = await vscode.window.showQuickPick(items, { title: 'KASAUTI: which AI should propose fixes? (KASAUTI verifies whatever it proposes)' });
    if (!pick) return;
    const preset = presetById(pick.id);
    let baseUrl = '';
    if (pick.id === 'custom') {
      baseUrl = (await vscode.window.showInputBox({ title: 'Base URL of the OpenAI-compatible API', placeHolder: 'http://localhost:8000/v1', ignoreFocusOut: true })) ?? '';
      if (!baseUrl) return;
    }
    const model = pick.id === 'vscode-lm' ? '' : (await vscode.window.showInputBox({ title: `Model id for ${pick.label}`, value: preset?.defaultModel ?? '', prompt: 'Exactly as the provider lists it', ignoreFocusOut: true }));
    if (model === undefined) return;
    const c = this.cfg();
    await c.update('ai.provider', pick.id, vscode.ConfigurationTarget.Global);
    await c.update('ai.baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
    await c.update('ai.model', model, vscode.ConfigurationTarget.Global);
    if (preset?.needsKey && !(await this.ctx.secrets.get(KEY_PREFIX + pick.id))) await this.setKey(pick.id);
    void vscode.window.showInformationMessage(`KASAUTI: AI fixes will use ${pick.label}${model ? ` · ${model}` : ''}.`);
  }

  private async setKey(id = this.cfg().get<string>('ai.provider', 'ollama')): Promise<string | undefined> {
    const preset = presetById(id);
    const key = await vscode.window.showInputBox({ title: `API key for ${preset?.label ?? id}`, prompt: `Stored in your OS keychain via VS Code SecretStorage — never in settings.${preset?.keyHint ? ' Get one at ' + preset.keyHint + '.' : ''}`, password: true, ignoreFocusOut: true });
    if (!key) return undefined;
    await this.ctx.secrets.store(KEY_PREFIX + id, key.trim());
    return key.trim();
  }

  /* ========================================================================
   * Proof panel + apply
   * ====================================================================== */
  private showPanel(data: ProofData): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('kasauti.proof', 'KASAUTI Proof', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true });
      this.panel.onDidDispose(() => { this.panel = undefined; });
      this.panel.webview.onDidReceiveMessage((m: { type: string }) => {
        if (m.type === 'apply') void this.apply();
        else if (m.type === 'diff') void this.showDiff();
        else if (m.type === 'discard') { this.pending = undefined; this.panel?.dispose(); }
      });
    }
    this.lastData = data;
    const nonce = crypto.randomBytes(16).toString('base64');
    this.panel.webview.html = proofHtml(data, nonce, this.panel.webview.cspSource, this.logo);
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }
  private lastData: ProofData | undefined;

  private async showDiff(): Promise<void> {
    const p = this.pending;
    if (!p?.report.code) return;
    const lang = (await vscode.workspace.openTextDocument(p.uri)).languageId;
    const left = await vscode.workspace.openTextDocument({ content: p.original, language: lang });
    const right = await vscode.workspace.openTextDocument({ content: p.report.code, language: lang });
    await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, `KASAUTI: ${p.fn.name} — original ↔ verified fix`, { preview: true });
  }

  /** One WorkspaceEdit (so one Ctrl+Z undoes it): new stdlib imports at the
   *  top of the file, the function body replaced in place, indentation kept. */
  private async apply(): Promise<void> {
    const p = this.pending;
    if (!p?.report.code) return;
    const doc = await vscode.workspace.openTextDocument(p.uri);
    const lines = doc.getText().split(/\r?\n/);
    let start = p.fn.startLine;
    const isPy = /python/.test(doc.languageId);
    if (isPy) while (start > 0 && /^\s*@/.test(lines[start - 1])) start--;
    // Safety: the function must be unchanged since the fix was computed.
    const indent = /^\s*/.exec(lines[start])![0];
    const current = lines.slice(start, p.fn.endLine + 1).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart())).join('\n') + '\n';
    if (current !== p.original) { void vscode.window.showWarningMessage('KASAUTI: the function changed since the fix was verified. Run "Fix with AI" again.'); return; }
    const codeLines = p.report.code.replace(/\s+$/, '').split('\n');
    const isImport = (l: string) => (isPy ? /^(import|from)\s+\S+/.test(l) : /^(import\s.+from\s|const\s+\w+\s*=\s*require\()/.test(l));
    const imports = codeLines.filter(isImport).filter((l) => !lines.some((x) => x.trim() === l.trim()));
    const body = codeLines.filter((l) => !isImport(l)).join('\n').replace(/^\n+/, '');
    const edit = new vscode.WorkspaceEdit();
    const lastImport = lines.reduce((acc, l, i) => (isImport(l) ? i : acc), -1);
    if (imports.length) edit.insert(p.uri, new vscode.Position(lastImport + 1, 0), imports.join('\n') + '\n');
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const replacement = body.split('\n').map((l) => (l.trim() ? indent + l : l)).join(eol);
    edit.replace(p.uri, new vscode.Range(start, 0, p.fn.endLine, lines[p.fn.endLine].length), replacement);
    if (await vscode.workspace.applyEdit(edit)) {
      this.pending = undefined;
      if (this.lastData) this.showPanel({ ...this.lastData, applied: true });
      void vscode.window.showInformationMessage(`KASAUTI: verified fix applied to ${p.fn.name}. Ctrl+Z undoes it.`);
    }
  }

  /* ========================================================================
   * 5. Agents (MCP) + scoreboard
   * ====================================================================== */
  /** The extension folder's name changes with every update, which would break
   *  harness configs. So the server is copied to a stable folder in global
   *  storage and re-synced on every activation. */
  private async syncMcpCopy(create: boolean): Promise<string | undefined> {
    if (!this.ctx.globalStorageUri) return undefined;
    const dest = path.join(this.ctx.globalStorageUri.fsPath, 'mcp');
    const marker = path.join(dest, 'VERSION');
    const version = String(this.ctx.extension?.packageJSON?.version ?? 'dev');
    if (!create && !fs.existsSync(dest)) return undefined;
    try {
      if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === version) return path.join(dest, 'dist', 'mcp.js');
      const src = this.ctx.extensionUri.fsPath;
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(path.join(dest, 'dist'), { recursive: true });
      fs.copyFileSync(path.join(src, 'dist', 'mcp.js'), path.join(dest, 'dist', 'mcp.js'));
      fs.cpSync(path.join(src, 'dist', 'wasm'), path.join(dest, 'dist', 'wasm'), { recursive: true });
      fs.cpSync(path.join(src, 'media', 'harness'), path.join(dest, 'media', 'harness'), { recursive: true });
      fs.writeFileSync(marker, version);
      return path.join(dest, 'dist', 'mcp.js');
    } catch (e) { this.host.log(`MCP copy failed: ${(e as Error).message}`); return undefined; }
  }

  private async copyMcpConfig(): Promise<void> {
    const server = await this.syncMcpCopy(true);
    if (!server) { void vscode.window.showErrorMessage('KASAUTI: could not prepare the MCP server (see Output → KASAUTI).'); return; }
    const exec = await vscode.window.showQuickPick([{ label: 'Audit only (recommended)', v: '0' }, { label: 'Also allow running code (prove complexity, behaviour checks)', v: '1' }], { title: 'May agents make KASAUTI run code?' });
    if (!exec) return;
    const j = (o: unknown) => JSON.stringify(o, null, 2);
    const targets = [
      { label: 'Claude Code', text: `claude mcp add kasauti --scope user --env KASAUTI_ALLOW_EXEC=${exec.v} -- node "${server}"` },
      { label: 'OpenCode (opencode.json)', text: j({ mcp: { kasauti: { type: 'local', command: ['node', server], enabled: true, environment: { KASAUTI_ALLOW_EXEC: exec.v } } } }) },
      { label: 'Codex CLI (~/.codex/config.toml)', text: `[mcp_servers.kasauti]\ncommand = "node"\nargs = [${JSON.stringify(server)}]\nenv = { KASAUTI_ALLOW_EXEC = "${exec.v}" }` },
      { label: 'Cursor / Claude Desktop / Windsurf (mcpServers JSON)', text: j({ mcpServers: { kasauti: { command: 'node', args: [server], env: { KASAUTI_ALLOW_EXEC: exec.v } } } }) },
    ];
    const t = await vscode.window.showQuickPick(targets, { title: 'Which agent harness?' });
    if (!t) return;
    await vscode.env.clipboard.writeText(t.text);
    void vscode.window.showInformationMessage(`KASAUTI: ${t.label} config copied. The server path stays valid across KASAUTI updates. Requires Node.js on PATH.`);
  }

  private record(p: ResolvedProvider, r: FixReport): void {
    const board = this.ctx.globalState.get<Record<string, { runs: number; verified: number; attempts: number; best?: number }>>(SCOREBOARD, {});
    const k = `${p.label} · ${p.model || 'default'}`;
    const e = (board[k] ??= { runs: 0, verified: 0, attempts: 0 });
    e.runs++; e.attempts += r.attempts.length;
    if (r.passed) { e.verified++; if (r.perf?.speedup && r.perf.speedup > (e.best ?? 0)) e.best = r.perf.speedup; }
    void this.ctx.globalState.update(SCOREBOARD, board);
  }

  private async showScoreboard(): Promise<void> {
    const board = this.ctx.globalState.get<Record<string, { runs: number; verified: number; attempts: number; best?: number }>>(SCOREBOARD, {});
    const rows = Object.entries(board).sort((a, b) => b[1].verified / b[1].runs - a[1].verified / a[1].runs)
      .map(([k, v]) => `| ${k} | ${v.runs} | ${v.verified} | ${Math.round((100 * v.verified) / Math.max(1, v.runs))}% | ${(v.attempts / Math.max(1, v.runs)).toFixed(1)} | ${v.best ? v.best.toFixed(1) + '×' : '—'} |`);
    const md = `# KASAUTI — AI model scoreboard\n\nEvery "Fix with AI" run on this computer. *Verified* = passed every deterministic check.\n\n| Model | Runs | Verified | Pass rate | Avg attempts | Best speed-up |\n|---|---|---|---|---|---|\n${rows.join('\n') || '| (no runs yet) | | | | | |'}\n`;
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
  }
}

/** For the controller: language key -> a file name the worker can analyze. */
export const snippetPath = (languageKey: string) => `kasauti-snippet.${SNIPPET_EXT[languageKey] ?? 'txt'}`;
