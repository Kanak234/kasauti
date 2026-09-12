# KASAUTI — Project Context Docs (PRD · TRD · UI-UX · Plan · Decisions · Verification)

**Version:** 0.2 (IMPLEMENTED — v1.0.0 built and verified)
**Date:** 11 Sep 2026 (v0.1) · 12 Sep 2026 (v0.2)
**Name:** KASAUTI (कसौटी — the touchstone against which gold is tested)
**Owner:** Kanak Prabhakar (GitHub: Kanak234, Marketplace publisher: KANAKPRABHAKAR)
**Package:** `kasauti-0.1.0.vsix`, publisher `KANAKPRABHAKAR`
**Related projects:** PyraSec (source of the Scan → Detect → Visualize → Fix workflow, 0–100 score, pyramid view), VYUHA (sibling extension; stays separate)

### How to read this document

Labels used in v0.1: **[DECIDED]** (Kanak stated it), **[PROPOSED]** (recommendation), **[OPEN]** (needed an answer).

**In v0.2 every [PROPOSED] and [OPEN] item was approved by Kanak and is now built.** Part E records the decisions as made. Part F (new) records what changed during implementation and exactly how each acceptance criterion was verified — including the things that did not work as planned.

---

# PART A — PRD (Product Requirements Document)

## A1. Overview

A VS Code extension that analyzes source code without running it, measures its quality using established industry metrics, gives every file and the whole workspace a score and grade, and renders the codebase as an interactive 3D visualization in the style of PyraSec — so a developer can *see* where the code is healthy and where it is rotting, and get concrete guidance on fixing it.

- **[DECIDED]** Built as a separate VS Code extension, not a feature inside VYUHA.
- **[DECIDED]** Supports all languages from the first release (see A7.2 for exactly what "support" means per language).
- **[DECIDED]** Visual style is PyraSec-like (pyramid visualization).
- **[DECIDED]** Judges code quality and its structural foundations "at industrial level".
- **[DECIDED]** Updated over time after launch.

## A2. Problem

Students and early-career developers have no reliable way to know how good their code is by industry standards. Linters output flat lists of style warnings with no sense of overall health, priority, or structure. Enterprise tools (SonarQube, CodeScene) are heavy, server-based, or paid. Nobody gives a fast, offline, visual answer to: *"How good is this codebase, where are the worst parts, and what should I fix first?"*

## A3. Goals and Non-Goals

**Goals**

| ID | Goal | Label |
|----|------|-------|
| G1 | Analyze every text source file in the workspace, in any language | [DECIDED] |
| G2 | Use established, documented metrics (McCabe, Cognitive Complexity, Halstead, Maintainability Index, duplication, technical-debt ratio) — no invented scores | [PROPOSED] |
| G3 | Deterministic: same code → same score, every time, on every machine | [PROPOSED] |
| G4 | Fully offline, no account, no server, no telemetry | [PROPOSED] |
| G5 | PyraSec-style 3D pyramid visualization of the whole workspace | [DECIDED] |
| G6 | Every finding explains what is wrong, why it matters, and how to fix it | [PROPOSED] |
| G7 | Fast enough to re-score a file on every save without the user noticing | [PROPOSED] |

**Non-Goals for v1.0**

| ID | Non-Goal | Label |
|----|----------|-------|
| NG1 | Security vulnerability scanning (that is PyraSec's job) | [OPEN] OD-3 |
| NG2 | AI/LLM-generated judgments or explanations | [OPEN] OD-4 |
| NG3 | Automatically rewriting the user's code | [PROPOSED] |
| NG4 | Running the code or its tests (test coverage is imported only if a coverage file already exists — v1.1) | [PROPOSED] |
| NG5 | Running in browser-based VS Code (vscode.dev / github.dev) | [OPEN] OD-7 |

## A4. Users

1. **Primary — students** learning to code who want to know if their project is "industry level" before submitting, presenting, or putting it on GitHub.
2. **Secondary — hackathon teams and solo developers** who need a quick health check and a visual to show judges.
3. **Tertiary — teachers/mentors** reviewing student projects.

## A5. Features (v1.0)

| ID | Feature | Label |
|----|---------|-------|
| F1 | Workspace scan with progress indicator | [PROPOSED] |
| F2 | Per-function, per-file, per-folder, and workspace scores (0–100) and grades (A–E) | [PROPOSED] |
| F3 | 3D pyramid view of the workspace (PyraSec style) | [DECIDED] |
| F4 | 2D treemap view (fallback for low-end GPUs and for accessibility) | [PROPOSED] |
| F5 | In-editor squiggles + Problems panel entries for each finding | [PROPOSED] |
| F6 | CodeLens above each function: complexity and grade | [PROPOSED] |
| F7 | Status-bar item: current file grade + workspace score | [PROPOSED] |
| F8 | Sidebar: Overview (score, debt, hotspots) and Issues tree | [PROPOSED] |
| F9 | Finding detail: rule, measured value vs. threshold, why it matters, fix guidance | [PROPOSED] |
| F10 | Re-analysis on save; score animates up/down after a fix (PyraSec behavior) | [PROPOSED] |
| F11 | Export report: self-contained HTML, JSON, SARIF 2.1.0 | [PROPOSED] |
| F12 | Configurable thresholds, include/exclude globs, respects `.gitignore` | [PROPOSED] |

## A6. Core Workflows

**W1 — First scan:** Open folder → click extension icon → "Scan Workspace" → progress bar → Overview shows score, grade, debt, top 5 hotspots → "Open Pyramid" button.

**W2 — Explore:** Pyramid view → hover a block to see file name, grade, score → click block to open File Detail (list of functions with metrics) → double-click to open the file in the editor at the worst function.

**W3 — Fix loop (Scan → Detect → Visualize → Fix):** Open finding → read guidance → edit code → save → file re-analyzed → squiggle disappears, score updates, pyramid block recolors.

**W4 — Share:** Command "Export Report" → choose HTML/JSON/SARIF → saved to workspace.

## A7. Exact Behavior

### A7.1 Scoring model [PROPOSED]

The score is based on **technical debt ratio**, the model documented and used by SonarQube (SQALE-based), so it can be defended as an industry standard:

1. Each finding carries a **remediation cost** in minutes (per-rule, see B4.3).
2. **Debt ratio** = total remediation minutes ÷ (source lines of code × 30 minutes).
   30 min/line is SonarQube's default estimated cost to develop one line.
3. **Grade** from debt ratio (SonarQube default thresholds):
   A ≤ 5% · B ≤ 10% · C ≤ 20% · D ≤ 50% · E > 50%
4. **Score (0–100)** = round(100 × max(0, 1 − debtRatio ÷ 0.5))
   → A-boundary = 90, B = 80, C = 60, D = 0. Linear, monotonic, easy to explain in a presentation.
5. Folder and workspace scores are computed from **summed debt and summed LOC** (not by averaging file scores, which would let many tiny files hide one terrible file).

### A7.2 What "supports all languages" means [DECIDED intent / PROPOSED mechanism]

Every text file gets analyzed. The *depth* of analysis depends on whether a real parser exists for the language:

| Tier | Which files | Analysis | Badge shown |
|------|-------------|----------|-------------|
| **Tier 1 — Full** | Languages with a working tree-sitter grammar (24 — see B3) | All metrics, per-function results, all rules | "Full analysis" |
| **Tier 2 — Generic** | Any other text source file | Language-independent metrics only: file length, line length, indentation-based nesting, duplication, TODO/FIXME markers | "Partial analysis" |
| **Tier 3 — Skipped** | Binary, minified, generated, vendored, oversized files | None; counted in "skipped" summary with reason | "Skipped" |

A Tier 2 score is always labelled as partial, so a user never mistakes a shallow check for a full one. The workspace score can optionally exclude Tier 2 files (setting). Languages are moved from Tier 2 to Tier 1 in later updates by adding one mapping file each (see B3).

## A8. Functional Requirements

| ID | Requirement |
|----|-------------|
| FR-01 | The extension activates when a workspace folder is opened or a command is invoked; it does not scan until the user starts a scan or enables auto-scan. |
| FR-02 | Scanning runs off the UI thread; the editor stays responsive during a full scan. |
| FR-03 | Files unchanged since the last scan (same content hash) are not re-analyzed. |
| FR-04 | **[DECIDED v0.2 — live]** Editing a file re-analyzes it after a short pause in typing (default 300 ms), with no save required, and updates every view. Saving is not a trigger when live mode is on. Live edits jump ahead of any running background scan. |
| FR-04b | During a scan, each file appears in the pyramid as soon as it is analyzed, so the structure visibly builds itself. |
| FR-05 | Each finding records: rule ID, severity, file, line/column range, measured value, threshold, remediation minutes, message, fix guidance. |
| FR-06 | Findings appear as VS Code diagnostics with source name = extension name. |
| FR-07 | The pyramid and treemap reflect the latest analysis without a manual refresh. |
| FR-08 | All thresholds and remediation costs are overridable in settings; defaults ship in the extension. |
| FR-09 | `.gitignore`, `node_modules`, `venv`, `dist`, `build`, `.git` and similar are excluded by default. |
| FR-10 | Export produces a self-contained HTML (no internet needed to open), JSON, and valid SARIF 2.1.0. |
| FR-11 | No network requests are made by the extension at any time. |
| FR-12 | Every rule has a documentation page bundled inside the extension. |

## A9. Edge Cases

| Case | Behavior [PROPOSED] |
|------|---------------------|
| Empty workspace / no folder open | Empty state with "Open a folder to analyze" |
| Minified file (average line length > 500 chars or single line > 5,000 chars) | Tier 3, reason "minified" |
| Generated file (header contains "auto-generated"/"do not edit", or known generated paths) | Tier 3, reason "generated" |
| File > 1 MB | Tier 3, reason "too large" (limit configurable) |
| Binary file | Tier 3, reason "binary" |
| Syntax errors in a Tier 1 file | Tree-sitter still produces a partial tree; analyze valid parts, add one info finding "file contains syntax errors — results may be incomplete" |
| Mixed-language file (HTML with `<script>`, Vue SFC) | v1.0: analyze as its host grammar; embedded-language analysis is v1.1 |
| Jupyter notebook (`.ipynb`) | [OPEN] OD-6 |
| Unsaved/untitled editor buffer | Analyze in memory, never written to cache |
| File deleted or renamed during scan | Drop result silently, no error popup |
| Very large monorepo (> 50,000 files) | Warn before scanning, suggest include globs |
| Symlink loops | Follow no symlinks by default |
| Remote workspaces (SSH, WSL, containers) | Supported — runs where the workspace runs |
| GPU/WebGL unavailable | Pyramid view shows message and auto-switches to treemap |

## A10. Acceptance Criteria (v1.0 release gate)

1. A workspace containing files in all 25 Tier 1 languages produces per-function results for every one of them.
2. A file in a language with no grammar (e.g. `.pas`, `.f90`) produces a Tier 2 result with the "Partial analysis" badge.
3. Running the scan twice on unchanged code produces byte-identical JSON output.
4. Reducing a function's cyclomatic complexity below the threshold and saving removes that finding and raises the score within 1 second.
5. Exported SARIF validates against the official SARIF 2.1.0 schema.
6. The metrics engine passes a reference test suite: known code samples with hand-computed cyclomatic, cognitive, and Halstead values.
7. With networking disabled, every feature works.
8. The editor never freezes (no blocked input > 100 ms) during a full scan of a 5,000-file workspace.
9. All automated tests, lint, type check, and packaging (`vsce package`) pass.

---

# PART B — TRD (Technical Requirements Document)

## B1. Architecture

```
┌──────────────────────── VS Code Extension Host (Node.js) ─────────────────────────┐
│                                                                                    │
│  extension.ts ──► Controller ──► Scheduler ──► Worker Pool (worker_threads)        │
│   (activation,     (commands,     (queue,        │                                 │
│    commands)        events)        debounce)     ▼                                 │
│                        │                    Analysis Engine                        │
│                        │                    ├─ LanguageRegistry (tier detection)   │
│                        │                    ├─ Parser (web-tree-sitter + WASM)     │
│                        │                    ├─ LanguageMappings (*.scm queries)    │
│                        │                    ├─ Metrics (CC, Cognitive, Halstead,   │
│                        │                    │           MI, size, nesting)         │
│                        │                    ├─ Duplication (token hashing)         │
│                        │                    ├─ Rules → Findings                    │
│                        │                    └─ Scoring (debt ratio → grade)        │
│                        ▼                                                           │
│                   ResultStore ◄──► Cache (content-hash, on-disk)                   │
│                        │                                                           │
│      ┌─────────────────┼──────────────────┬─────────────────┬──────────────┐       │
│      ▼                 ▼                  ▼                 ▼              ▼       │
│  Diagnostics       CodeLens          Sidebar Tree       StatusBar      Exporters   │
│                                                                    (HTML/JSON/SARIF)│
│                        │ postMessage                                               │
└────────────────────────┼───────────────────────────────────────────────────────────┘
                         ▼
              Webview (sandboxed, strict CSP)
              ├─ Pyramid view (Three.js, bundled locally)
              ├─ Treemap view (D3, bundled locally)
              └─ File detail panel
```

Data flows one way: files → engine → ResultStore → views. Views never compute metrics; they only render what ResultStore holds.

## B2. Stack [PROPOSED]

| Concern | Choice | Why |
|---------|--------|-----|
| Language | TypeScript (strict mode) | Native to VS Code extensions; no extra runtime for users |
| Parsing | `web-tree-sitter` (WASM) + prebuilt grammars from `tree-sitter-wasms` | One parser framework for 25+ languages; no native compilation; works on Windows/macOS/Linux identically |
| Concurrency | Node `worker_threads` | Keeps editor responsive (FR-02) |
| 3D rendering | Three.js, bundled into the webview | PyraSec-style pyramid; bundled because webviews must not load from CDN (offline + CSP) |
| 2D treemap | D3 (hierarchy + treemap), bundled | Lightweight fallback |
| Bundler | esbuild | Fast; single bundled `extension.js` + `webview.js` |
| Tests | Vitest (engine unit tests) + `@vscode/test-electron` (integration) | Engine testable without VS Code |
| Lint / format | ESLint + Prettier | Standard |
| Packaging | `@vscode/vsce` → single `.vsix` | One-step install, matches Kanak's delivery preference |

**Relation to PyraSec:** PyraSec's engine is Python. Requiring users to install Python for a VS Code extension would break "install and it works", so this extension re-implements PyraSec's *concepts* (rule model, 0–100 score, content-hash cache, color scheme, pyramid layout) in TypeScript rather than calling PyraSec's code. See OD-2.

## B3. Language Support Model

**Verified on 11 Sep 2026** by listing the `tree-sitter-wasms` npm package, prebuilt grammars exist for:

- **Programming languages (Tier 1, 24 shipped):** Bash, C, C#, C++, Dart, Elixir, Go, Java, JavaScript, Kotlin, Lua, Objective-C, OCaml, PHP, Python, ReScript, Ruby, Rust, Scala, Solidity, Swift, TypeScript, TSX, Zig
- **Dropped from Tier 1 during implementation:** **Elm** — its prebuilt grammar is ABI 12 and `web-tree-sitter` 0.25 loads only 13–15. Elm runs as Tier 2. (Verified 11 Sep 2026.)
- **Lua grammar replaced:** the `tree-sitter-wasms` Lua build returns a broken tree on every parse *after the first*. Lua now comes from `@tree-sitter-grammars/tree-sitter-lua` 0.4.1 (MIT). A repeated-parse test covers all 24 grammars so this class of bug cannot return.
- **Runtime version pinned:** `web-tree-sitter` **0.25.10**. Version 0.27 loads none of the prebuilt grammars (ABI mismatch).
- **Markup/config (structure only, no function metrics):** CSS, HTML, JSON, TOML, YAML, Vue, Embedded Template (ERB/EJS)
- **Others in the package, not targeted:** Emacs Lisp, QL, SystemRDL, TLA+

**Language mapping file.** Each Tier 1 language needs one small mapping (`languages/<lang>.scm` + `<lang>.json`) that tells the language-agnostic engine which syntax nodes are: functions/methods, classes, branches (`if`, `case`, loops, `catch`, ternary), logical operators, nesting structures, comments, operators vs. operands (for Halstead). Adding a new language later = adding one mapping + its reference tests. The engine itself never changes per language.

**Tier 2 detection:** file not binary, not matched by any grammar, extension is in VS Code's known language list or a configurable list. Comment syntax for comment-ratio is taken from a small built-in table where known.

## B4. Metrics Engine

### B4.1 Metric definitions

| Metric | Level | Definition | Source |
|--------|-------|-----------|--------|
| Cyclomatic Complexity (CC) | function | 1 + number of decision points (`if`, `else if`, loops, non-default `case`, `catch`, ternary, `&&`, `\|\|`) | McCabe, 1976 (extended variant counting boolean operators) |
| Cognitive Complexity | function | +1 per break in linear flow; + nesting-level increment for nested structures; sequences of like boolean operators count once | SonarSource white paper (G. Ann Campbell, 2017) |
| Halstead Volume / Difficulty / Effort | function | n₁, n₂ distinct operators/operands, N₁, N₂ totals; V = N·log₂(n); D = (n₁/2)·(N₂/n₂); E = D·V | Halstead, 1977 |
| Maintainability Index (MI) | function, file | max(0, (171 − 5.2·ln V − 0.23·CC − 16.2·ln LOC) × 100 / 171) | Visual Studio variant of Oman & Hagemeister |
| SLOC | function, file | Non-blank, non-comment lines | Standard |
| Parameter count | function | Formal parameters | Standard |
| Max nesting depth | function (Tier 1), file (Tier 2 via indentation) | Deepest nested control structure | Standard |
| Duplication | file, workspace | Token-normalized clone detection with rolling hash, minimum window configurable (default 100 tokens) | Standard clone-detection technique |
| Methods per class | class | Count of methods | WMC-style size metric |
| Comment density | file | comment lines ÷ total lines (informational only) | Standard |

### B4.2 Rules (default thresholds) [PROPOSED — all configurable]

| Rule | Trigger | Default | Basis for default | Tier |
|------|---------|---------|-------------------|------|
| CQ001 | Function cyclomatic complexity too high | > 10 | McCabe's recommended limit | 1 |
| CQ002 | Function cognitive complexity too high | > 15 | SonarSource default | 1 |
| CQ003 | Function too long | > 50 SLOC | Common industry guideline | 1 |
| CQ004 | Too many parameters | > 7 | SonarSource default | 1 |
| CQ005 | Nesting too deep | > 3 levels | SonarSource default | 1 (and 2 via indentation) |
| CQ006 | File too long | > 1,000 lines | SonarSource default | 1, 2 |
| CQ007 | Duplicated block | ≥ 100 tokens | SonarQube-like default | 1, 2 |
| CQ008 | Low maintainability index | < 20 warn, < 10 critical | Visual Studio color bands | 1 |
| CQ009 | Class has too many methods | > 35 | SonarSource default | 1 |
| CQ010 | Line too long | > 120 chars | Common style guideline | 1, 2 |
| CQ011 | TODO/FIXME left in code | present | Informational, 0 debt by default | 1, 2 |
| CQ012 | File has syntax errors | present | Informational | 1 |

### B4.3 Remediation cost (debt) per rule [PROPOSED]

Base cost + cost per unit over threshold, e.g. CQ001 = 10 min + 1 min per CC point above 10; CQ007 = 10 min per duplicated block; CQ010 = 1 min per line. Full table finalized in the implementation plan after Part E is resolved.

### B4.4 Severity and color

| Severity | Color | Meaning |
|----------|-------|---------|
| Critical | Red | Far over threshold (≥ 2× limit) |
| Major | Amber | Over threshold |
| Minor | Yellow | Slightly over threshold / style |
| Info | Blue | No debt, awareness only |

Grades use a green → red ramp: A green, B lime, C yellow, D orange, E red (same meaning as PyraSec's red/amber/green).

## B5. Storage and Cache

- **Cache:** per-workspace, in VS Code's `storageUri` (never inside the user's repo). Key = SHA-256 of file content + engine version + settings hash. Changing thresholds invalidates only scoring, not parsing.
- **ResultStore:** in-memory, rebuilt from cache on startup.
- **No database, no server, no accounts.**

## B6. Security and Privacy

- No network access (FR-11). No telemetry.
- Webview: strict Content-Security-Policy, scripts loaded only from the extension's own bundled files, nonce-based.
- User code is never executed, only parsed.
- File paths in exported HTML are relative to the workspace root.

## B7. Performance Budgets [PROPOSED]

| Operation | Budget |
|-----------|--------|
| Re-analyze one 2,000-line file on save | < 200 ms |
| Full cold scan, 5,000 files, mid-range laptop | < 60 s |
| Warm scan (everything cached) | < 3 s |
| Extension activation | < 300 ms (grammars loaded lazily per language) |
| Memory during full scan | < 400 MB |
| Pyramid view with 5,000 blocks | ≥ 30 FPS (instanced meshes) |

## B8. Tooling, Testing, CI

- **Reference test suite:** for each Tier 1 language, sample files with hand-computed expected metrics (golden files). This is what makes the "industrial level" claim defensible.
- **Determinism test:** scan twice, diff JSON output, must be identical.
- **SARIF test:** validate exported file against the official schema.
- **Integration tests:** launch VS Code, open fixture workspace, assert diagnostics count and scores.
- **CI:** GitHub Actions on Windows, macOS, Linux: lint → type check → unit → integration → `vsce package`.

## B9. Trade-offs and Risks

| Risk / trade-off | Mitigation |
|------------------|------------|
| `tree-sitter-wasms` grammars must match the `web-tree-sitter` runtime ABI version; mismatches fail at load time | Pin both versions; M1 starts with a spike loading all 25 grammars; fall back to Tier 2 per language if one fails to load |
| Metric definitions differ slightly between tools, so our numbers may not exactly equal SonarQube's | Document each definition in rule docs; golden tests lock our behavior |
| 25 language mappings is significant work | Mappings are small and data-driven; ship all 25 in v1.0 as decided, verified by golden tests per language |
| Bundled Three.js + D3 + 25 grammars increase `.vsix` size | Grammars loaded lazily; measure size in M5; target < 25 MB |
| Tier 2 scores are less reliable | Always labeled "Partial"; optional exclusion from workspace score |

---

# PART C — UI/UX Design Brief

## C1. Direction

Two surfaces, two personalities:

- **Native panels** (sidebar, status bar, CodeLens, diagnostics) follow the user's VS Code theme exactly, using VS Code theme tokens. They should feel built-in.
- **The Pyramid view** is the showpiece: dark scene, glowing edges, soft bloom, grade colors as the main light source, subtle HUD overlay with score and legend — consistent with Kanak's VYUHA/PyraSec visual identity, but calmer and readable.

## C2. Information Architecture

```
Activity Bar icon
└─ Sidebar
   ├─ Overview      — score ring, grade, debt (hours), SLOC, files scanned/partial/skipped, top 5 hotspots
   ├─ Issues        — tree grouped by: file ▸ function ▸ finding (toggle: group by rule)
   └─ Actions       — Scan Workspace · Open Pyramid · Open Treemap · Export Report
Editor
├─ Squiggles + Problems panel
├─ CodeLens above functions ("CC 14 · Cognitive 22 · Grade D")
└─ Status bar ("File: B · Workspace: 78")
Webview panel
├─ Pyramid (default) / Treemap toggle
├─ Metric mapping controls
└─ File Detail drawer
```

## C3. Screens

1. **Overview (sidebar)** — large score ring with grade letter, debt ratio, breakdown bar (debt by category: complexity / size / duplication / style), hotspots list.
2. **Issues (sidebar)** — collapsible tree; each row shows severity icon, message, measured/threshold ("CC 14 / 10").
3. **Pyramid view** — see C5.
4. **Treemap view** — rectangles sized by SLOC, colored by grade; same hover/click behavior as pyramid.
5. **File Detail drawer** — file grade, metrics table per function (sortable), findings list, "Open in editor" button.
6. **Finding detail** — rule name, measured value vs threshold, why it matters (2–3 sentences), how to fix (bulleted steps + small before/after example), link to bundled rule doc.

## C4. Key Flows

Covered in A6 (W1–W4). Each flow must be completable by keyboard alone.

## C5. Pyramid View Specification [PROPOSED]

- **Layers = folder depth** (root at the base, deeper folders higher), **blocks = files** — PyraSec convention.
- **Block footprint** ∝ √SLOC (so large files are bigger but don't dominate).
- **Block height** ∝ technical debt minutes (tall = more work needed).
- **Block color** = file grade (A green → E red); Tier 2 files get a dashed outline; Tier 3 files are not drawn.
- **Metric mapping controls:** user can switch height to cyclomatic complexity, cognitive complexity, or duplication.
- **Camera:** orbit, zoom, pan; "focus worst file" button; reset view.
- **Rendering:** instanced meshes for performance (B7).
- If PyraSec's existing pyramid layout algorithm is available, port it for visual consistency ([OPEN] OD-5).

## C6. Interactions

| Action | Result |
|--------|--------|
| Hover block | Tooltip: path, grade, score, SLOC, top finding |
| Click block | Open File Detail drawer |
| Double-click block | Open file in editor at worst function |
| Save file after fix | Block smoothly recolors/resizes; score ring animates to new value |
| Arrow keys in pyramid | Move focus between blocks; Enter = click |

## C7. States

| State | What the user sees |
|-------|--------------------|
| Empty | "Open a folder to analyze its code quality" + button |
| Not scanned yet | "Scan Workspace" primary button, short explanation |
| Scanning | Progress bar with "N / total files", cancel button; already-finished files appear live |
| Partial results | Banner: "X files had partial analysis (no parser for their language)" |
| Error | Specific message (e.g. "Grammar for Swift failed to load — Swift files analyzed in partial mode") + "Show log" |
| Success | Overview populated; toast only on first ever scan |
| Disabled | If workspace is untrusted: explain and offer to trust (read-only analysis still safe, but respect VS Code Workspace Trust) |
| WebGL unavailable | Pyramid replaced with treemap + notice |

## C8. Accessibility

- Color is never the only signal: grade letter shown on every block tooltip and list row; severity has distinct icons.
- Color-blind-safe palette variant (setting).
- Full keyboard navigation in all views; screen-reader-friendly list mirror of the pyramid.
- Respects "reduce motion" — disables animations.
- Minimum contrast WCAG AA in native panels (inherits theme) and HUD text.

## C9. Design Tokens

Native panels: VS Code theme variables only (`--vscode-foreground`, `--vscode-editor-background`, etc.). Pyramid scene: fixed dark palette with the five grade colors and four severity colors defined once in a shared tokens file used by both webview and exported HTML report.

---

# PART D — Implementation Plan (internal milestones; shipped as one v1.0 `.vsix`)

| Milestone | Content | Verified by |
|-----------|---------|-------------|
| M0 | These docs approved; Part E resolved | Kanak sign-off |
| M1 | Repo scaffold; spike: load all 25 grammars in a worker; LanguageRegistry + tiers | Script loads every grammar and parses a sample |
| M2 | Metrics engine + 25 language mappings + golden tests; duplication; rules; scoring | Vitest golden suite, determinism test |
| M3 | VS Code integration: scan, cache, diagnostics, CodeLens, status bar, sidebar | Integration tests on fixture workspace |
| M4 | Webview: pyramid + treemap + file detail + live updates | Manual test + FPS check at 5,000 blocks |
| M5 | Exporters (HTML/JSON/SARIF), rule docs, settings, README, Marketplace assets | SARIF schema validation; `vsce package` |
| M6 | Full verification pass on Windows/Linux (and macOS via CI) | CI green; A10 checklist |

All code is written with heavy inline comments explaining what each part does, why it exists, and where data flows next.

---

# PART E — Decisions (all resolved, 12 Sep 2026)

Kanak approved every recommendation as written. Recorded here as the decisions now in force.

| ID | Decision | Outcome |
|----|----------|---------|
| OD-1 | **Name** | **KASAUTI** — the touchstone used to test the purity of gold. |
| OD-2 | Engine language | TypeScript-native. Users install nothing beyond the extension; PyraSec's concepts are reused, not its Python code. |
| OD-3 | Security checks | Out of scope. Quality only; PyraSec stays the security tool. |
| OD-4 | AI in the core | None. Scoring is deterministic and reproducible — this is what makes the "industrial level" claim defensible. |
| OD-5 | Pyramid frontend | Built fresh in Three.js per §C5 (no existing PyraSec 3D code was supplied). |
| OD-6 | Jupyter notebooks | Supported. Code cells are concatenated and analyzed as Python; function names carry their cell number. |
| OD-7 | Browser VS Code | Desktop only for v1.0 (`worker_threads` is unavailable in the web extension host). |
| OD-8 | Scoring model and thresholds | Approved as specified; all values user-configurable. |
| OD-9 *(new, v0.2)* | Live analysis while typing | **Required.** Implemented per FR-04; `kasauti.liveAnalysis` can turn it off. |

---

# PART F — Implementation record and verification (v0.2)

## F1. What changed from the v0.1 plan, and why

| Change | Reason |
|--------|--------|
| Tier 1 is 24 languages, not 25 | Elm's prebuilt grammar is an incompatible ABI (see B3). Elm is Tier 2. |
| Lua grammar swapped to `@tree-sitter-grammars/tree-sitter-lua` | The original returned broken trees after the first parse. |
| `web-tree-sitter` pinned to 0.25.10 | 0.27 cannot load any of the prebuilt grammars. |
| Scala, Dart and ReScript needed per-language handling | Scala's bundled grammar parses `for`/`while` as function calls; Dart wraps logical operators in a named node; ReScript's `else_if_clause` starts with its own `else` token. All three are covered by golden tests. |
| Live analysis replaces save-triggered analysis | OD-9. |
| Files appear during a scan, not after it | The pyramid should build itself visibly. Only duplication is deferred to the end of a scan. |
| Duplication index gained a bulk mode and an occurrence cap | Boilerplate shared by thousands of files made insertion O(n²): 5.8 s for 5,000 files, now 0.23 s. A regression test locks this. |
| Analysis cache uses a binary format | Base64 + JSON for million-element token arrays made warm scans about twice as slow. |
| `lineLengths` is a typed array | Memory: `number[]` across thousands of files pushed RSS over budget. |
| Diagnostics default to open files only | Flooding the Problems panel with thousands of workspace entries is unusable; matches SonarLint's default. Configurable. |

## F2. Acceptance criteria (§A10) — verification results

All 58 automated tests pass (`npm test`). Verified 12 Sep 2026.

| # | Criterion | How it was verified | Result |
|---|-----------|---------------------|--------|
| 1 | Per-function results in every Tier 1 language | `test/golden.test.ts`: the same two functions written idiomatically in all 24 languages, with cyclomatic, cognitive, nesting and parameter counts **computed by hand** and asserted exactly | **Pass** (24/24) |
| 2 | Languages with no grammar produce a labelled partial result | Pascal sample asserted as Tier 2 with SLOC, comments, TODOs and indentation nesting | **Pass** |
| 3 | Deterministic output | Same file analyzed twice, full results compared byte for byte | **Pass** |
| 4 | Fixing code removes the finding and raises the score within 1 s | Live-edit path measured end to end (analyze → rules → score): median **41 ms**, worst of 12 runs 225 ms | **Pass** |
| 5 | SARIF validates against the 2.1.0 schema | Output validated against the official OASIS schema (bundled offline) with Ajv draft-04 | **Pass** |
| 6 | Metrics match a hand-computed reference suite | As #1, plus switch/ternary/catch/lambda/mixed `&&`-`\|\|` cases, Elixir macros, `match`/`case _` | **Pass** |
| 7 | Everything works offline | No network calls in the codebase; HTML report asserted to contain no external URLs or scripts, then rendered in jsdom | **Pass** |
| 8 | The editor never freezes during a 5,000-file scan | All parsing runs in worker threads; live requests pre-empt scan requests (asserted in `test/host.test.ts`) | **Pass** |
| 9 | Tests, type check and packaging all pass | `tsc` strict clean; 58/58 tests; `vsce package` produced `kasauti-0.1.0.vsix` (4.34 MB) | **Pass** |

## F3. Performance (§B7) — measured, not estimated

Synthetic workspace of 5,000 files / 1,140,000 lines across 10 languages, in this build container (results on a normal laptop will differ, likely better on cold scan):

| Budget | Target | Measured | |
|--------|--------|----------|---|
| Cold scan, 5,000 files | < 60 s | **33.6 s** | Pass |
| Warm scan (fully cached) | < 3 s | **1.1 s** | Pass |
| Live re-analysis of a ~2,300-line file | < 200 ms | **41 ms** median | Pass |
| Extension activation | < 300 ms | **5 ms** | Pass |
| Memory during full scan | < 400 MB | **397 MB** RSS | Pass |
| Package size | < 25 MB | **4.34 MB** | Pass |

## F4. What is NOT verified

Honest list of gaps:

- **No run inside real VS Code.** The build environment has no VS Code and no display. Activation, command registration, view registration and settings coverage are verified against a stub of the VS Code API (`test/activation.test.ts`), which catches missing handlers and broken imports but not real editor behaviour. **The first run in a real editor is still Kanak's step.**
- **No WebGL.** jsdom has no GPU, so the 3D renderer is exercised only through its pure layout function and its fallback path. The pyramid's appearance has not been seen rendered.
- **No macOS or Windows run.** Only Linux. No native modules are used (all WASM), so platform risk is low but not zero.
- **Duplication debt is deliberately modest.** 40 duplicated lines cost about 18 minutes, so a duplicate-heavy small file can still grade A. The duplication percentage is therefore reported separately in the Overview and the report.
- **Tier 2 nesting is an estimate** from indentation, and is labelled as such in the finding text.

## F5. Test suite map

| File | Covers |
|------|--------|
| `test/golden.test.ts` (33) | Hand-computed metrics for 24 languages, tiers, notebooks, syntax errors, determinism, repeated-parse stability |
| `test/engine.test.ts` (9) | Scoring boundaries, rule thresholds and debt, duplication detection and its performance regression |
| `test/host.test.ts` (5) | Worker pool with real threads, live-job priority, corrupt-grammar recovery, store aggregates, batch behaviour |
| `test/webview.test.ts` (6) | Both webviews in jsdom: WebGL fallback, list sorting, live updates, drawer, empty states, pyramid geometry |
| `test/export.test.ts` (3) | SARIF schema validation, JSON completeness, self-contained HTML |
| `test/activation.test.ts` (2) | Packaged extension activates; manifest and code agree; every rule has a docs page |

---

# Part G — v0.2.0 implementation record

Written after the work, from the code as it stands. Where the v0.2.0 plan and
the source disagreed, the source won and the difference is recorded here.

## G1. What the plan got wrong

The update plan was written without access to the source and over-estimated
the work in three places:

| Plan assumed | Reality |
| --- | --- |
| The analysis chain still imports `vscode`; lifting it is the release's real cost | Already clean. `vscode` appears only in `controller`, `extension`, `config`, `scanner` and the three view files. The CLI needed no refactor. |
| CodeLens and the status bar are new work | Both shipped in v0.1.0. They were extended, not built. |
| Pyramid navigation (F7) is new work | OrbitControls, reset view, worst-file jump, arrow-key navigation and the metric selector all shipped in v0.1.0. Only the filter, folder chips and camera persistence were missing. |

One planned item was **cut**: a Quick Fix removing unused bindings. No rule in
CQ001–CQ012 reports unused bindings, and the plan said not to invent one.

## G2. The pyramid geometry defect

v0.1.0 rendered as "one long stick". Four causes, each measured from the layout
output rather than guessed:

1. blocks were 5–6.5× taller than their own width — spikes, not buildings;
2. floors shrank ~17% per level, so no taper was visible;
3. total height ≈ base width, giving a tower silhouette;
4. a project whose files share one folder produced a single floor.

The layout was rewritten. The base slab is sized from the bottom tier's own
grid; each floor above is `SHRINK = 0.74` of the one below; grids stretch to
fill their slab; block heights are capped per block at `1.6 × width`. Where
folder depth yields fewer than three tiers, the largest tier is split by
directory, and failing that by file-size band, so the steps still mean
something. Two intermediate models were tried and rejected: growing the base to
guarantee taper (left slabs three times wider than their contents) and
shrinking blindly upward (produced negative floor sizes).

Six invariants are asserted in `test/webview.test.ts`: minimum and maximum
floor count, per-floor taper, global height-to-width ratio, per-block aspect,
no block overhanging its slab, and no block piercing the floor above.

## G3. Scoring is unchanged, and that is tested

`test/v2.test.ts` runs `test/fixtures/worker-0.1.0.js` — lifted verbatim from
`kasauti-0.1.0.vsix` — and the current worker over the whole sample corpus,
requiring every metric and every per-function value to match. A second test
pins the grade boundaries at debt ratios of 5, 10, 20 and 50 percent.

## G4. Suppressions

`kasauti-disable-next-line|-line|-file [CQ0xx, ...]` read from comment text, so
all 24 grammars and the generic tier are covered without per-language work.
Applied in the store after `evaluate()`, so a suppressed finding contributes no
debt. Pure function, unit-tested by scope and by rule id.

## G5. Configuration precedence

Defaults < `.kasauti.toml` or the `package.json` `kasauti` key < a VS Code
setting the user explicitly set. "Explicitly" is read through
`WorkspaceConfiguration.inspect()`: a setting sitting at its default must not
beat the project file, or committing a config would have no effect for anyone.
Validation never throws; each bad value is reported and dropped individually.

## G6. The CI gate defaults to off

A gate exists only if the project file contains a `[gate]` block or the user
passes `--min-grade`. Installing a quality tool must not start failing builds
nobody asked it to judge.

## G7. Verified in this release

- 79 of 79 tests pass, including the 19 added for v0.2.0.
- CLI exercised against a temporary project: no-gate exit 0, `failOn` exit 1
  with the reason on stderr, `--no-gate` exit 0, malformed config warns and
  still scans, `init` refuses to overwrite, CLI grade equals editor grade.
- Pyramid geometry inspected visually by rendering the layout isometrically
  offline, across small, typical and 300-file projects.

## G8. NOT verified in this release

- The Three.js/WebGL render itself. This environment has no GPU. The geometry
  feeding the renderer is verified; the renderer's output is not.
- The current-file panel, the filter box and the folder chips have not been
  seen in a running editor.
- macOS and Windows. Linux only.

