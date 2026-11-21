# Change Log

## 2.2.0 — 21 November 2026 — simpler, 3D, plain words

From Kanak's first real use of 2.1: too many options, risks not explained, 2D felt flat.

### Changed
- **Code Map is 3D** (VYUHA-style): glowing nodes, drag to rotate, scroll to fly in/out, right-drag to move, gentle auto-spin until you touch it. Falls back to the flat map without WebGL.
- **The pyramid and treemap are removed.** Two views remain: Code Map and List.
- **Problems in plain words everywhere:** five groups — Security risk, AI mistakes, Slow code, Can be simpler, Hard to maintain — each with a one-line explanation. The map's "Problems found" panel filters the map by group; the tooltip lists a file's actual problems; the detail drawer groups problems by kind and leads with the problem name (rule id is a small tag). The sidebar uses the same groups.
- Clearer messages for swallowed errors and loops that search a list.
- Toolbar cut to: view, search, grade, Rescan. Map controls cut to: Replay, Show functions, Reset view.
- New icon in the VYUHA family.

### Added (from VYUHA)
- **Double-click (tap) any dot to jump to the code:** files open at their most serious problem, functions at their line; the whole line is highlighted and centred.
- **Zoom and Size sliders** with − / + buttons (keys: + − zoom, ] [ size, 0 reset).

### Added
- **AI fixes and agents in the UI** (sidebar): current AI model shown, "Choose AI model", "Set API key", "Connect an agent (MCP)", "Which AI fixes best?". The detail drawer has **✨ Fix with AI** and **📈 Measure speed** buttons.

## 2.1.0 — 21 November 2026 — Code Map

### Added
- **Code Map**, the new default view (NeuralSchema-style): a force-directed graph of project → folders → files → functions with **import links** between files (Python, JS/TS, Java/Kotlin/Scala, C/C++, Go). Colour = grade, size = lines of code + how many files import it, coloured rings = performance / security / AI-risk findings.
- **Crawl animation** like NeuralSchema's Crawl Mode: BFS/DFS, speed, number of crawlers, follow camera, tags, progress scrubber, live stats panel (discovered, frontier, depth, links followed) and a discovery log.
- Double-click a file to show its functions; click a function to jump to it. Drag nodes, pan, zoom. Live edits flash the file's node gold. KP watermark.
- Works without WebGL (2D canvas).

### Changed
- The pyramid is still available as a view; users of 2.0 are moved to the Code Map once. "Open Pyramid" is now "Open Code Map".
- Engine cache version 2.1.0 (import specifiers are now recorded): the first scan after updating re-analyses every file once.

## 2.0.0 — 21 November 2026 — "Parakh"

A 360° audit for AI-written code, suggested by Mr. Udhay Ranjan (Dean, CS & IT, AISECT University), folded into KASAUTI instead of a new extension.

### Added
- **26 audit rules KP101–KP405** (performance, security, AI-risk, simplification) for Python, JavaScript, TypeScript/TSX and Java, computed on the existing parse tree; hard-coded secret detection in every language (values masked).
- **Slopsquatting guard:** imports checked against requirements/pyproject/Pipfile/package.json (KP301); optional PyPI/npm lookup for non-existent (KP302) and brand-new (KP303) packages.
- **Prove Complexity** (Python, JavaScript): measures running time at growing n in a separate process and fits O(1)…O(2ⁿ), with a growth chart.
- **Fix with AI (Verified):** bring your own model (Ollama, LM Studio, OpenAI, Anthropic, NVIDIA NIM/Nemotron, OpenRouter, Groq, custom, VS Code models). Five deterministic checks, retry with reasons, diff + proof panel, explicit Apply. AI model scoreboard.
- **MCP server** (`dist/mcp.js`) with five tools for agent harnesses; stable install path across updates.
- Overview: Performance, Security and AI-risk debt bars. Rule pages with before → after examples. `kasauti-disable` comments accept KP ids.
- KP watermark (Kanak Prabhakar) on the proof panel and README.

### Changed
- Untrusted workspaces: analysis still works; running code is disabled (`untrustedWorkspaces: limited`).
- Engine cache version 2.0.0: the first scan after updating re-analyses every file once.

## 0.2.1 — 12 September 2026

Both fixes came from the first run in a real editor.

### Fixed
- **The Current File panel went blank and the status bar dropped the file
  grade whenever you clicked into the pyramid.** VS Code reports no active
  text editor while focus is in a webview panel, the terminal or a settings
  tab, and both views read that as "no file open". They now describe the last
  editor you were actually in, until that file is closed.
- **A workspace with no technical debt rendered as a bare plate.** Block height
  came from a metric that was zero everywhere, so every block had no height —
  the pyramid looked broken precisely when the code was clean. An all-zero
  workspace now draws even, visible blocks.


## 0.2.0 — 12 September 2026

### Fixed
- **The pyramid rendered as one tall stick instead of a stepped pyramid.**
  Reported from a real editor, and the layout was rewritten around it. Four
  measured causes: blocks were 5 to 6.5 times taller than wide; each floor was
  only ~17% smaller than the one below; total height equalled the base width;
  and a project with one source folder produced a single floor, so there were
  no steps at all. Blocks are now tiles, floors shrink by a fixed ratio, and a
  flat project is banded by file size so it still forms a pyramid. Six geometry
  invariants are now asserted by tests so the shape cannot regress.
- The camera framed small projects from far too far away, leaving a seven-file
  pyramid as a speck in the middle of the panel.

### Added
- **Suppression comments.** `kasauti-disable-next-line CQ001`,
  `kasauti-disable-line`, `kasauti-disable-file`, with or without rule ids.
  Works in all 24 parsed languages and in partial-analysis files, because the
  directive is read from comment text rather than per-language syntax. A
  suppressed finding costs no technical debt.
- **Project configuration.** `.kasauti.toml` in the workspace root, or a
  `kasauti` key in `package.json`: thresholds, excludes and a CI gate. Commit
  it and everyone on the team gets the same grades. Precedence is defaults,
  then the project file, then any VS Code setting you explicitly changed. A
  malformed file reports each problem and falls back per value; it never stops
  the extension from starting.
- **Command-line interface.** `kasauti scan .` runs the same analysis outside
  VS Code and writes table, JSON, SARIF or HTML output. Exit code 1 when the
  gate fails, 0 otherwise. **The gate is off unless a `[gate]` block exists** —
  installing a quality tool must never start failing your build.
- **Quick Fixes** on KASAUTI diagnostics: remove a TODO marker, split an
  over-long line at a safe boundary, or insert a suppression comment. Offered
  only on fully parsed files.
- **Trend history.** One sample per completed scan, shown as a sparkline in the
  Overview with a plain-language caption. Old samples roll up into monthly
  averages instead of being discarded. `KASAUTI: Clear Trend History` removes it.
- **Current file panel** in the sidebar: this file's grade, every function
  ranked by cost, and every finding, all clickable. Plain DOM and no WebGL, so
  it keeps working where the 3D view cannot.
- **Filter box** in the pyramid toolbar: `grade:D`, `grade:>=C`, `rule:CQ001`,
  `partial:yes`, or plain text matched against the path. Applies to the
  pyramid, treemap and list alike.
- **Folder chips** to fold a top-level folder out of all three views.
- The camera position is remembered between sessions.
- CodeLens gained `kasauti.codeLens.mode` (grade, metrics or both) and
  `kasauti.codeLens.maxSymbols`, which suppresses lenses in generated files.
- The status bar now shows the debt ratio, a working indicator during analysis,
  a tilde for partial analysis, and hides itself on unsupported files.

### Unchanged, deliberately
No metric and no grade boundary moved in this release. A test runs the shipped
v0.1.0 worker and the current one over the whole sample corpus and requires
every metric to match; another pins the A/B/C/D/E boundaries at 5, 10, 20 and
50 percent.

# Changelog

## 0.1.0

First release.

- Grades every file and the whole workspace from A to E using SonarQube's technical-debt-ratio model.
- Full analysis for 24 languages (tree-sitter), partial analysis for every other source language, with partial results clearly labelled.
- Metrics: cyclomatic complexity, cognitive complexity, Halstead, maintainability index, nesting, parameters, class size, file and line length, duplicated code, TODO markers.
- 3D pyramid, 2D treemap and sortable list views; blocks rise as files are scanned and re-animate when a file changes.
- Live analysis while typing; no save required.
- Diagnostics, CodeLens per function, status bar, and an issues tree grouped by file or rule.
- Export to self-contained HTML, SARIF 2.1.0 and JSON.
- Content-hash analysis cache for fast warm scans. Fully offline; no telemetry.
