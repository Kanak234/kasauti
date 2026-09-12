// Minimal stand-in for the VS Code API: enough to activate the packaged
// extension.js and assert that it registers what package.json promises.
const rec = { commands: [], trees: [], webviewViews: [], codeLens: 0, disposables: 0, diagnostics: 0, statusBars: 0, subscriptions: [] };
const D = (extra = {}) => ({ dispose() { rec.disposables++; }, ...extra });
const EV = () => { const ls = []; const f = (cb) => { ls.push(cb); return D(); }; f.fire = (x) => ls.forEach((l) => l(x)); return f; };
class EventEmitter { constructor() { this.event = EV(); } fire(x) { this.event.fire(x); } dispose() {} }
class Uri {
  constructor(scheme, p) { this.scheme = scheme; this.path = p; this.fsPath = p; }
  static file(p) { return new Uri('file', p); }
  static parse(s) { const i = s.indexOf('://'); return new Uri(s.slice(0, i < 0 ? 0 : i), i < 0 ? s : s.slice(i + 3)); }
  static joinPath(u, ...p) { return new Uri(u.scheme, require('path').join(u.path, ...p)); }
  toString() { return `${this.scheme}://${this.path}`; }
}
class Position { constructor(l, c) { this.line = l; this.character = c; } }
class Range { constructor(a, b, c, d) { this.start = a instanceof Position ? a : new Position(a, b); this.end = b instanceof Position ? b : new Position(c, d); } }
class ThemeIcon { constructor(id, color) { this.id = id; } static File = new ThemeIcon('file'); }
class MarkdownString { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } }
class Diagnostic { constructor(r, m, s) { Object.assign(this, { range: r, message: m, severity: s }); } }
module.exports = {
  Uri, Position, Range, ThemeIcon, MarkdownString, Diagnostic, EventEmitter,
  ThemeColor: class { constructor(id) { this.id = id; } },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  DiagnosticRelatedInformation: class {}, Location: class {},
  TreeItem: class { constructor(l, c) { this.label = l; this.collapsibleState = c; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 }, ViewColumn: { One: 1, Beside: -2 },
  ProgressLocation: { Notification: 15, Window: 10 }, FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
  CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false, onCancellationRequested: EV() }; } cancel() { this.token.isCancellationRequested = true; } dispose() {} },
  commands: { registerCommand: (id) => { rec.commands.push(id); return D(); }, executeCommand: async () => {} },
  languages: {
    createDiagnosticCollection: () => { rec.diagnostics++; return { set() {}, delete() {}, clear() {}, dispose() {} }; },
    registerCodeLensProvider: (_s, p) => { rec.codeLens++; rec.codeLensProvider = p; return D(); },
  },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => { rec.statusBars++; return { show() {}, hide() {}, dispose() {} }; },
    registerTreeDataProvider: (id, p) => { rec.trees.push(id); rec.treeProvider = p; return D(); },
    registerWebviewViewProvider: (id) => { rec.webviewViews.push(id); return D(); },
    createWebviewPanel: () => ({ webview: { html: '', asWebviewUri: (u) => u, cspSource: 'vscode-resource:', onDidReceiveMessage: EV(), postMessage: async () => true }, onDidDispose: EV(), reveal() {}, dispose() {} }),
    showInformationMessage: async () => undefined, showWarningMessage: async () => undefined,
    showTextDocument: async () => ({}), showQuickPick: async () => undefined, showSaveDialog: async () => undefined,
    withProgress: async (_o, fn) => fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: EV() }),
    visibleTextEditors: [], activeTextEditor: undefined,
    onDidChangeActiveTextEditor: EV(),
  },
  workspace: {
    workspaceFolders: undefined, name: undefined, textDocuments: [],
    getConfiguration: () => ({ get: (_k, d) => d }),
    asRelativePath: (u) => String(u.path || u).replace(/^\/+/, ''),
    getWorkspaceFolder: () => undefined,
    findFiles: async () => [],
    createFileSystemWatcher: () => ({ onDidCreate: EV(), onDidChange: EV(), onDidDelete: EV(), dispose() {} }),
    fs: { stat: async () => ({ type: 1, size: 1 }), readFile: async () => new Uint8Array(), writeFile: async () => {} },
    onDidChangeTextDocument: EV(), onDidOpenTextDocument: EV(), onDidSaveTextDocument: EV(),
    onDidCloseTextDocument: EV(), onDidChangeConfiguration: EV(),
  },
  env: { openExternal: async () => true },
  __rec: rec,
};
