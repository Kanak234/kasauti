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
