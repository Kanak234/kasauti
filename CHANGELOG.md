# Change Log

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
