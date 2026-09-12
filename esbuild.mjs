/* =============================================================================
 * KASAUTI — esbuild.mjs  (build script)
 * -----------------------------------------------------------------------------
 * WHAT:  Produces everything the .vsix needs inside dist/:
 *          dist/extension.js   VS Code host code (CommonJS, `vscode` external)
 *          dist/worker.js      analysis worker thread
 *          dist/webview.js     pyramid/treemap UI (browser IIFE, Three.js inside)
 *          dist/wasm/*.wasm    tree-sitter runtime + the 24 Tier 1 grammars
 *        and, with --test, dist-test/*.test.js for `node --test`.
 * WHY:   Bundling makes the extension start fast and lets the webview run
 *        offline with no CDN (SPEC §B2, FR-11).
 * FLOW:  `npm run build` -> this file -> `vsce package` zips dist/ into .vsix
 * ========================================================================== */

import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const withTests = args.has('--test');

// The 24 grammars we ship (Elm/markup grammars intentionally excluded).
const GRAMMARS = ['bash', 'c', 'c_sharp', 'cpp', 'dart', 'elixir', 'go', 'java', 'javascript', 'kotlin', 'lua',
  'objc', 'ocaml', 'php', 'python', 'rescript', 'ruby', 'rust', 'scala', 'solidity', 'swift', 'typescript', 'tsx', 'zig'];

function copyWasm() {
  const out = 'dist/wasm';
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync('node_modules/web-tree-sitter/tree-sitter.wasm', path.join(out, 'tree-sitter.wasm'));
  for (const g of GRAMMARS) {
    // Lua: newer official build. The tree-sitter-wasms Lua build breaks after
    // its first parse with web-tree-sitter 0.25 (see engine/parser.ts).
    const src = g === 'lua'
      ? 'node_modules/@tree-sitter-grammars/tree-sitter-lua/tree-sitter-lua.wasm'
      : `node_modules/tree-sitter-wasms/out/tree-sitter-${g}.wasm`;
    fs.copyFileSync(src, path.join(out, `tree-sitter-${g}.wasm`));
  }
}

// WHY the alias: web-tree-sitter's ESM build relies on `import.meta.url`, which
// does not exist in a CommonJS bundle. Its official .cjs build works as-is.
const alias = { 'web-tree-sitter': './node_modules/web-tree-sitter/tree-sitter.cjs' };
const common = { bundle: true, minify: production, sourcemap: !production, logLevel: 'info', alias };

await Promise.all([
  esbuild.build({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js',
    platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] }),
  esbuild.build({ ...common, entryPoints: ['src/engine/worker.ts'], outfile: 'dist/worker.js',
    platform: 'node', format: 'cjs', target: 'node18' }),
  esbuild.build({ ...common, entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js',
    platform: 'browser', format: 'iife', target: 'es2020' }),
  // Sidebar gets its own tiny bundle: no Three.js, so it opens instantly.
  esbuild.build({ ...common, entryPoints: ['webview/overview.ts'], outfile: 'dist/overview.js',
    platform: 'browser', format: 'iife', target: 'es2020' }),
]);
copyWasm();
fs.copyFileSync('webview/style.css', 'dist/webview.css');

if (withTests) {
  const tests = fs.readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => path.join('test', f));
  await esbuild.build({ bundle: true, sourcemap: true, entryPoints: tests, outdir: 'dist-test',
    platform: 'node', format: 'cjs', target: 'node18', external: ['vscode', 'jsdom', 'ajv', 'ajv-draft-04', 'ajv-formats'], logLevel: 'warning', alias });
}
