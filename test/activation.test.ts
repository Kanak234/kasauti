/* =============================================================================
 * KASAUTI — test/activation.test.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Activates the REAL bundled dist/extension.js against a stub of the
 *        VS Code API (test/fixtures/vscode-stub.js) and checks that what the
 *        extension registers matches exactly what package.json promises.
 * WHY:   Catches the failures that only appear at runtime in a real editor:
 *        a command in the manifest with no handler (VS Code shows
 *        "command not found"), a view id typo, or an import that throws on
 *        activation. Also measures activation time against SPEC §B7 (<300 ms).
 *        A real end-to-end test needs @vscode/test-electron and a display;
 *        this covers the wiring without one.
 * FLOW:  `npm test`
 * ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Module from 'module';
import * as ruleCatalog from '../src/engine/rules';

const ROOT = path.resolve(__dirname, '..');
const STUB = path.join(ROOT, 'test/fixtures/vscode-stub.js');

/** Make `require('vscode')` resolve to the stub, then load the real bundle. */
function loadExtension() {
  const anyModule = Module as unknown as { _resolveFilename(req: string, ...a: unknown[]): string };
  const original = anyModule._resolveFilename;
  anyModule._resolveFilename = function (req: string, ...a: unknown[]) {
    return req === 'vscode' ? STUB : original.call(this, req, ...a);
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require(STUB);
  const ext = require(path.join(ROOT, 'dist/extension.js'));
  return { vscode, ext, restore: () => { anyModule._resolveFilename = original; } };
}

test('the packaged extension activates and registers exactly what package.json declares', () => {
  const { vscode, ext, restore } = loadExtension();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const ctx = {
      subscriptions: [] as Array<{ dispose?(): void }>,
      extensionUri: vscode.Uri.file(ROOT),
      storageUri: vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'kasauti-test-'))),
      workspaceState: { get: () => false, update: async () => {} },
      extension: { packageJSON: pkg },
    };
    const t0 = Date.now();
    ext.activate(ctx);
    const activateMs = Date.now() - t0;
    const rec = vscode.__rec;

    const declared = pkg.contributes.commands.map((c: { command: string }) => c.command).sort();
    assert.deepEqual([...rec.commands].sort(), declared, 'every declared command must have a handler, and no extras');
    const viewIds = pkg.contributes.views.kasauti.map((v: { id: string }) => v.id);
    for (const id of viewIds) assert.ok([...rec.trees, ...rec.webviewViews].includes(id), `view ${id} not registered`);
    assert.equal(rec.codeLens, 1, 'CodeLens provider registered');
    assert.equal(rec.diagnostics, 1, 'diagnostic collection created');
    assert.equal(rec.statusBars, 1, 'status bar item created');
    assert.ok(activateMs < 300, `activation took ${activateMs} ms (budget 300 ms)`);

    // Settings declared in package.json must all be read by config.ts.
    const settings = Object.keys(pkg.contributes.configuration.properties);
    const configSrc = fs.readFileSync(path.join(ROOT, 'src/config.ts'), 'utf8');
    for (const s of settings) {
      const key = s.replace(/^kasauti\./, '');
      assert.ok(configSrc.includes(`'${key}'`), `setting ${s} is declared but never read`);
    }

    ctx.subscriptions.forEach((d) => d.dispose?.());
  } finally { restore(); }
});

test('every rule has a bundled documentation page', () => {
  // diagnostics.ts links each finding to media/rules/<id>.md — a missing file
  // would be a dead link in the Problems panel.
  const { RULES } = ruleCatalog;
  for (const r of RULES) {
    const p = path.join(ROOT, 'media/rules', `${r.id}.md`);
    assert.ok(fs.existsSync(p), `missing rule page ${r.id}.md`);
    assert.match(fs.readFileSync(p, 'utf8'), /## How to fix/);
  }
});
