# Developing KASAUTI

## Setup

```bash
npm install
npm run build        # dist/extension.js, worker.js, webview.js, overview.js, wasm/
```

Press **F5** in VS Code to launch an Extension Development Host with KASAUTI loaded.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Development build (source maps) |
| `npm run build:prod` | Minified build, as shipped |
| `npm run typecheck` | `tsc --strict`, no emit |
| `npm test` | Builds test bundles, runs all 58 tests with `node --test` |
| `npm run package` | Type check + production build + `.vsix` |

## How the pieces fit

```
src/engine/     pure analysis — no vscode import, runs in a worker and in tests
  languages.ts  which node types mean "function", "if", "loop" per language
  metrics.ts    cyclomatic, cognitive, Halstead, MI, SLOC, tokens
  generic.ts    Tier 2 (no parser) analysis
  rules.ts      thresholds + remediation cost -> findings
  scoring.ts    debt ratio -> 0-100 score and A-E grade
  duplication.ts winnowing index, incremental
  parser.ts     web-tree-sitter runtime, lazy grammar loading
  analyzer.ts   tier routing, notebooks, generated/minified detection
  worker.ts     worker thread entry

src/            VS Code host
  controller.ts orchestration: live typing, scan, watcher, commands, export
  store.ts      single source of truth; fans changes out to views
  workerPool.ts priority lanes, timeouts, crash recovery
  cache.ts      content-hash binary cache
  scanner.ts    file discovery, .gitignore, excludes
  snapshot.ts   store records -> compact UI data
  views/        diagnostics, CodeLens, status bar, tree, webview hosts
  export/       HTML, SARIF, JSON

webview/        sandboxed UI (no vscode import)
  main.ts       pyramid (Three.js), treemap, list, drawer
  overview.ts   sidebar
  layout.ts     pure pyramid geometry (unit-tested)
```

Data flows one way: **files → engine → store → views**. Views never compute metrics.

## Adding a language to Tier 1

1. Confirm a grammar exists in `tree-sitter-wasms` (or add another npm package, as Lua does).
2. Add its key to `GRAMMARS` in `esbuild.mjs`.
3. Add a `LangSpec` in `src/engine/languages.ts`: extensions and which node types are functions, classes, `if`, loops, `switch`, `case`, `catch`, ternary. Inspect real trees first — do not guess node names.
4. Add `test/samples/sample.<ext>` with the two standard functions and register it in `STANDARD` in `test/golden.test.ts`. The expected numbers are fixed: `classify` = CC 4 / cognitive 4, `loop` = CC 4 / cognitive 6 / nesting 3.
5. `npm test`. If the numbers differ, dump the parse tree and fix the mapping — never the expected value, unless the language genuinely has different semantics (Elixir is the one documented exception).

## Adding a rule

Add it to `RULES` in `src/engine/rules.ts` (id, name, summary, why, fix steps, tiers), emit it in `evaluate()`, add its threshold to `Thresholds`, `DEFAULT_THRESHOLDS`, `config.ts` and `package.json`, and map it to a debt category in `src/store.ts`. Rule pages are generated from the catalog, so documentation cannot drift.

## Gotchas learned the hard way

- `web-tree-sitter` must stay at **0.25.10**; 0.27 loads none of the prebuilt grammars.
- Bundle the **CJS** build of `web-tree-sitter` (`alias` in `esbuild.mjs`); the ESM build uses `import.meta.url`, which breaks in a CommonJS bundle.
- A grammar that fails can corrupt a worker's WASM runtime, so a failing grammar recycles the worker and its files fall back to Tier 2.
- Trees and cursors are manual memory: always `delete()` them.
- Never run `Array.shift()` or walk an occurrence list per token — both turned into O(n²) once.
