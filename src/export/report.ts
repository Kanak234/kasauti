/* =============================================================================
 * KASAUTI — export/report.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Three export formats (SPEC F11, FR-10):
 *          toJSON()  — full machine-readable results
 *          toSARIF() — SARIF 2.1.0, the OASIS standard read by GitHub code
 *                      scanning, Azure DevOps and many CI tools
 *          toHTML()  — one self-contained file: no internet needed to open,
 *                      ideal to attach to a hackathon submission or send to
 *                      a teacher
 * WHY:   Results must leave VS Code to be useful for reviews and CI.
 *        No vscode import: pure functions of the store -> unit-testable.
 * FLOW:  controller.exportReport() -> one of these -> file written to disk.
 * ========================================================================== */

import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import { displayName } from '../engine/languages';
import { RULES } from '../engine/rules';
import { formatDebt } from '../engine/scoring';
import type { Grade, Severity } from '../engine/types';
import { summary } from '../snapshot';
import type { ResultStore } from '../store';

export const GRADE_COLORS: Record<Grade, string> = { A: '#2e9d6a', B: '#7cb342', C: '#d9a92e', D: '#e07b35', E: '#d14545' };
const SARIF_LEVEL: Record<Severity, 'warning' | 'note'> = { critical: 'warning', major: 'warning', minor: 'note', info: 'note' };

/* ---------------------------------------------------------------- JSON ---- */
export function toJSON(store: ResultStore, version: string): string {
  const s = summary(store, true);
  return JSON.stringify({
    tool: 'KASAUTI', version,
    workspace: { score: s.score, grade: s.grade, debtMinutes: s.debt, sloc: s.sloc, files: s.files,
      fullAnalysis: s.tier1, partialAnalysis: s.tier2, skipped: s.skipped, duplicatedPercent: s.duplicatedPct, debtByCategory: s.byCategory },
    files: store.workspaceFiles().sort((a, b) => a.relPath.localeCompare(b.relPath)).map((r) => ({
      path: r.relPath, language: displayName(r.analysis.languageKey), tier: r.analysis.tier, skipReason: r.analysis.skipReason,
      grade: r.score.grade, score: r.score.score, sloc: r.analysis.sloc, debtMinutes: r.score.debtMinutes,
      functions: r.analysis.functions.map((f) => ({ name: f.name, line: f.startLine + 1, params: f.params,
        cyclomatic: f.cyclomatic, cognitive: f.cognitive, maxNesting: f.maxNesting, sloc: f.sloc,
        maintainabilityIndex: f.mi, halstead: f.halstead })),
      findings: r.findings.map((f) => ({ rule: f.ruleId, severity: f.severity, line: f.line + 1, message: f.message,
        value: f.value, threshold: f.threshold, debtMinutes: f.debtMinutes })),
    })),
  }, null, 2);
}

/* --------------------------------------------------------------- SARIF ---- */
export function toSARIF(store: ResultStore, version: string): string {
  const ruleIndex = new Map(RULES.map((r, i) => [r.id, i]));
  const results = [];
  for (const r of store.workspaceFiles().sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    for (const f of r.findings) {
      results.push({
        ruleId: f.ruleId, ruleIndex: ruleIndex.get(f.ruleId)!, level: SARIF_LEVEL[f.severity],
        message: { text: f.message },
        locations: [{ physicalLocation: {
          artifactLocation: { uri: encodeURI(r.relPath), uriBaseId: 'SRCROOT' },
          region: { startLine: f.line + 1, startColumn: f.col + 1, endLine: f.endLine + 1, endColumn: Math.max(f.endCol, f.col) + 1 },
        } }],
        properties: { severity: f.severity, debtMinutes: f.debtMinutes },
      });
    }
  }
  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'KASAUTI', version, semanticVersion: version,
        rules: RULES.map((r) => ({
          id: r.id, name: r.name.replace(/[^A-Za-z]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : '')),
          shortDescription: { text: r.summary }, fullDescription: { text: r.why },
          help: { text: r.fix.join(' '), markdown: r.fix.map((s) => `- ${s}`).join('\n') },
          defaultConfiguration: { level: r.id === 'CQ011' || r.id === 'CQ012' || r.id === 'CQ010' ? 'note' : 'warning' },
        })),
      } },
      originalUriBaseIds: { SRCROOT: { description: { text: 'Workspace root' } } },
      results,
    }],
  }, null, 2);
}

/* ---------------------------------------------------------------- HTML ---- */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Squarified treemap of files (area = SLOC, color = grade) as inline SVG. */
function treemapSvg(store: ResultStore, width = 960, height = 420): string {
  const files = store.workspaceFiles().filter((r) => r.analysis.tier !== 3 && r.analysis.sloc > 0);
  if (!files.length) return '';
  interface N { name: string; children?: N[]; sloc?: number; grade?: Grade }
  const root: N = { name: '', children: [] };
  for (const r of files) {
    const parts = r.relPath.split('/');
    let node = root;
    for (const p of parts.slice(0, -1)) {
      let c = node.children!.find((x) => x.name === p && x.children);
      if (!c) { c = { name: p, children: [] }; node.children!.push(c); }
      node = c;
    }
    node.children!.push({ name: r.relPath, sloc: r.analysis.sloc, grade: r.score.grade });
  }
  const h = hierarchy<N>(root).sum((d) => d.sloc ?? 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  treemap<N>().size([width, height]).paddingInner(1).paddingOuter(2).tile(treemapSquarify)(h);
  const rects = h.leaves().map((l) => {
    const n = l as unknown as { x0: number; x1: number; y0: number; y1: number; data: N };
    const w = n.x1 - n.x0, ht = n.y1 - n.y0;
    const label = w > 60 && ht > 16 ? `<text x="${(n.x0 + 4).toFixed(1)}" y="${(n.y0 + 13).toFixed(1)}">${esc(n.data.name.split('/').pop()!)}</text>` : '';
    return `<g><title>${esc(n.data.name)} — grade ${n.data.grade}, ${n.data.sloc} lines</title><rect x="${n.x0.toFixed(1)}" y="${n.y0.toFixed(1)}" width="${w.toFixed(1)}" height="${ht.toFixed(1)}" fill="${GRADE_COLORS[n.data.grade!]}"/>${label}</g>`;
  }).join('');
  return `<svg class="treemap" viewBox="0 0 ${width} ${height}" role="img" aria-label="Treemap of files sized by lines of code and colored by grade">${rects}</svg>`;
}

export function toHTML(store: ResultStore, version: string, workspaceName: string): string {
  const s = summary(store, true);
  const files = store.workspaceFiles().filter((r) => r.analysis.tier !== 3).sort((a, b) => b.score.debtMinutes - a.score.debtMinutes);
  const totalCat = Math.max(1, Object.values(s.byCategory).reduce((a, b) => a + b, 0));
  const catRow = (Object.entries(s.byCategory) as Array<[string, number]>).map(([k, v]) =>
    `<div class="cat"><span class="cat-name">${k}</span><span class="bar"><i style="width:${(100 * v / totalCat).toFixed(1)}%"></i></span><span class="cat-val">${formatDebt(v)}</span></div>`).join('');
  const rows = files.map((r) => `<tr><td class="path">${esc(r.relPath)}</td><td>${esc(displayName(r.analysis.languageKey))}${r.analysis.tier === 2 ? ' <em>(partial)</em>' : ''}</td>
<td><b class="g" style="background:${GRADE_COLORS[r.score.grade]}">${r.score.grade}</b></td><td class="num">${r.score.score}</td><td class="num">${r.analysis.sloc}</td>
<td class="num" data-v="${r.score.debtMinutes}">${formatDebt(r.score.debtMinutes)}</td><td class="num">${r.findings.length}</td></tr>`).join('\n');
  const details = files.filter((r) => r.findings.some((f) => f.debtMinutes > 0)).slice(0, 50).map((r) => `<details><summary>${esc(r.relPath)} <b class="g" style="background:${GRADE_COLORS[r.score.grade]}">${r.score.grade}</b> ${formatDebt(r.score.debtMinutes)}</summary><ul>${
    r.findings.filter((f) => f.debtMinutes > 0).map((f) => `<li><span class="sev ${f.severity}">${f.severity}</span> <code>${f.ruleId}</code> line ${f.line + 1}: ${esc(f.message)}</li>`).join('')}</ul></details>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KASAUTI report — ${esc(workspaceName)}</title>
<style>
:root{--ink:#1f232b;--muted:#5d6472;--line:#dcdfe5;--paper:#fbfbfd;--gold:#a8791f}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:40px 28px 80px}
header{display:grid;grid-template-columns:auto 1fr;gap:28px;align-items:center;border-bottom:2px solid var(--ink);padding-bottom:24px}
.mark{width:132px;height:132px;border-radius:50%;display:grid;place-items:center;background:${GRADE_COLORS[s.grade]};color:#fff;font:700 64px/1 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif}
h1{font:600 30px/1.2 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;margin:0 0 6px}
.lede{color:var(--muted);margin:0}.facts{display:flex;flex-wrap:wrap;gap:8px 28px;margin-top:14px}
.facts div{min-width:110px}.facts b{display:block;font-size:22px}.facts span{color:var(--muted);font-size:13px}
h2{font:600 20px/1.3 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;margin:40px 0 12px}
.cat{display:grid;grid-template-columns:120px 1fr 90px;gap:12px;align-items:center;margin:6px 0}
.cat-name{text-transform:capitalize}.bar{height:10px;background:#eceef2;border-radius:5px;overflow:hidden}.bar i{display:block;height:100%;background:var(--gold)}
.cat-val{text-align:right;color:var(--muted)}
.treemap{width:100%;height:auto;background:#eceef2;border-radius:4px}.treemap text{font:11px system-ui;fill:#fff;pointer-events:none}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}
th{cursor:pointer;user-select:none;color:var(--muted);font-weight:600}th:focus{outline:2px solid var(--gold)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}td.path{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;word-break:break-all}
.g{display:inline-block;width:24px;text-align:center;border-radius:4px;color:#fff;font-weight:700}
details{border-bottom:1px solid var(--line);padding:8px 0}summary{cursor:pointer;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
.sev{display:inline-block;min-width:62px;font-size:12px;color:#fff;border-radius:3px;padding:0 6px;text-align:center}
.sev.critical{background:#d14545}.sev.major{background:#e07b35}.sev.minor{background:#9a8a2e}.sev.info{background:#4a7bd0}
footer{margin-top:48px;color:var(--muted);font-size:13px;border-top:1px solid var(--line);padding-top:16px}
@media print{th{cursor:default}details{break-inside:avoid}}
</style></head><body><main>
<header><div class="mark" aria-label="Workspace grade ${s.grade}">${s.grade}</div>
<div><h1>${esc(workspaceName)}</h1><p class="lede">Code quality report. Score ${s.score} out of 100, grade ${s.grade}.</p>
<div class="facts"><div><b>${s.debtText}</b><span>technical debt</span></div><div><b>${s.sloc.toLocaleString('en')}</b><span>lines of code</span></div>
<div><b>${s.files}</b><span>files (${s.tier1} full, ${s.tier2} partial, ${s.skipped} skipped)</span></div><div><b>${s.duplicatedPct}%</b><span>duplicated lines</span></div></div></div></header>
<h2>Where the debt comes from</h2>${catRow}
<h2>Map of the codebase</h2><p class="lede">Each rectangle is a file: size is lines of code, color is grade.</p>${treemapSvg(store)}
<h2>Files</h2><table id="files"><thead><tr><th tabindex="0">File</th><th tabindex="0">Language</th><th tabindex="0">Grade</th><th class="num" tabindex="0">Score</th><th class="num" tabindex="0">Lines</th><th class="num" tabindex="0">Debt</th><th class="num" tabindex="0">Findings</th></tr></thead><tbody>
${rows}</tbody></table>
<h2>Findings in the files with the most debt</h2>${details || '<p class="lede">No findings with remediation cost.</p>'}
<footer>Generated by KASAUTI ${esc(version)}. Grades use the technical-debt-ratio model (SonarQube defaults): debt ÷ (lines × 30 min); A ≤ 5%, B ≤ 10%, C ≤ 20%, D ≤ 50%, E above.
Metrics: McCabe cyclomatic complexity, SonarSource cognitive complexity, Halstead, Maintainability Index (Visual Studio variant).</footer>
</main>
<script>
// Sortable table: click (or Enter on) a header to sort by that column.
document.querySelectorAll('#files th').forEach(function(th, col){
  function sort(){ var tb=document.querySelector('#files tbody'); var rows=[].slice.call(tb.rows);
    var dir = th.dataset.dir === 'asc' ? -1 : 1; th.dataset.dir = dir === 1 ? 'asc' : 'desc';
    rows.sort(function(a,b){ var x=a.cells[col], y=b.cells[col]; var vx=x.dataset.v||x.textContent, vy=y.dataset.v||y.textContent;
      var nx=parseFloat(vx), ny=parseFloat(vy); return (isNaN(nx)||isNaN(ny) ? vx.localeCompare(vy) : nx-ny) * dir; });
    rows.forEach(function(r){ tb.appendChild(r); }); }
  th.addEventListener('click', sort); th.addEventListener('keydown', function(e){ if(e.key==='Enter') sort(); });
});
</script></body></html>`;
}
