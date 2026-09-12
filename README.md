# KASAUTI — Code Quality Visualizer

**कसौटी** is the touchstone a goldsmith rubs metal against to judge its purity. This extension does the same for code: it measures your codebase against published industry metrics, gives every file a grade from **A to E**, and shows the whole project as a **3D pyramid you can walk around** — updating live as you type.

Everything runs **offline** inside VS Code. No account, no server, no telemetry, no network calls.

---

## What it measures

Every number comes from a published, documented metric — nothing invented:

| Metric | Source |
|---|---|
| Cyclomatic complexity | McCabe, 1976 (extended: counts `&&` / `\|\|`) |
| Cognitive complexity | SonarSource specification, G. Ann Campbell, 2017 |
| Halstead volume, difficulty, effort | Halstead, 1977 |
| Maintainability Index | Visual Studio 0–100 normalization of Oman & Hagemeister |
| Duplicated code | Winnowing fingerprints (Schleimer, Wilkerson & Aiken, 2003) + exact token verification |
| Lines of code, nesting depth, parameters, class size | Standard definitions |

### How the grade is calculated

KASAUTI uses SonarQube's publicly documented **technical debt ratio** model, so any grade can be defended in a review or a presentation:

```
debt ratio = remediation minutes ÷ (lines of code × 30 min)
A ≤ 5%    B ≤ 10%    C ≤ 20%    D ≤ 50%    E > 50%
score     = 100 × max(0, 1 − ratio ÷ 0.5)
```

Folder and workspace grades sum debt and lines **before** dividing, so a hundred tiny clean files cannot hide one terrible one.

---

## Language support

Every source file in your workspace is analyzed. How deeply depends on whether a parser exists for its language:

**Full analysis — 24 languages**
Bash · C · C++ · C# · Dart · Elixir · Go · Java · JavaScript · Kotlin · Lua · Objective-C · OCaml · PHP · Python (and Jupyter notebooks) · ReScript · Ruby · Rust · Scala · Solidity · Swift · TypeScript · TSX · Zig

Per-function complexity, Halstead, maintainability, nesting, parameters, classes, duplication.

**Partial analysis — every other language**
Pascal, Fortran, Haskell, R, Julia, Perl, Clojure, Erlang, F#, Groovy, PowerShell, SQL, VHDL, Verilog, COBOL, Ada, MATLAB, GDScript, CUDA, GLSL and more.

File length, line length, indentation-based nesting, duplication and TODO markers. These files are clearly labelled **"partial analysis"** everywhere they appear, so a shallow check is never mistaken for a full one. You can exclude them from scores with one setting.

**Skipped**: generated, minified, binary, and oversized files — with the reason shown.

---

## Using it

1. Click the KASAUTI icon in the Activity Bar, then **Scan workspace**.
2. Watch the pyramid build itself, one block per file.
3. Click a block to see its functions and findings; double-click to open the file.
4. Fix something. The block recolours and the score moves **as you type** — no save needed.

**Views** — 3D pyramid (floors = folder depth, blocks = files, colour = grade, height = the metric you pick), 2D treemap, and a sortable list. The treemap and list are full replacements, not afterthoughts: they work without a GPU and are fully keyboard navigable.

**In the editor** — squiggles and Problems-panel entries, a CodeLens above every function showing its grade and complexity, and a status-bar item with the current file and workspace grade.

**Export** — a self-contained HTML report (opens offline in any browser, good for submissions), SARIF 2.1.0 (validated against the OASIS schema; works with GitHub code scanning), and JSON with every metric.

---

## Rules

| Rule | Checks | Default |
|---|---|---|
| CQ001 | Cyclomatic complexity per function | 10 |
| CQ002 | Cognitive complexity per function | 15 |
| CQ003 | Function length | 50 lines |
| CQ004 | Parameter count | 7 |
| CQ005 | Nesting depth | 3 |
| CQ006 | File length | 1000 lines |
| CQ007 | Duplicated block | 100 tokens |
| CQ008 | Maintainability index | warn 20 / critical 10 |
| CQ009 | Methods per class | 35 |
| CQ010 | Line length | 120 |
| CQ011 | TODO / FIXME marker | informational |
| CQ012 | Syntax errors | informational |

Every limit is configurable, and every finding explains why it matters and how to fix it. Full pages are bundled in `media/rules/`.

---

## Settings

The ones worth knowing:

| Setting | Default | What it does |
|---|---|---|
| `kasauti.liveAnalysis` | `true` | Re-analyze while typing instead of on save |
| `kasauti.liveDelayMs` | `300` | Pause after the last keystroke before re-analyzing |
| `kasauti.diagnostics.scope` | `openFiles` | Squiggles for open files, the whole workspace, or off |
| `kasauti.exclude` | `[]` | Extra glob patterns to skip |
| `kasauti.includePartialAnalysisInScore` | `true` | Count partially analyzed files in scores |
| `kasauti.colorBlindPalette` | `false` | Okabe–Ito palette for grades |

`.gitignore` and dependency folders (`node_modules`, `venv`, `dist`, `target`, …) are excluded automatically.

---

## Accessibility

Colour is never the only signal: every block, row and tooltip carries its grade letter, and severities have distinct icons. The list view mirrors the pyramid for screen readers, all views are keyboard navigable, an Okabe–Ito colour-blind palette is one setting away, and animations respect **reduce motion**.

---

## Privacy

KASAUTI makes no network requests, ever. Your code is parsed, never executed, and never leaves your machine. The analysis cache lives in VS Code's own storage folder, not in your repository.

---

## Built by

[Kanak Prabhakar](https://github.com/Kanak234) — BCA student, AISECT University, Hazaribagh.

Licensed MIT.
