/* =============================================================================
 * KASAUTI — views/proofHtml.ts   (v2.0 "Parakh")
 * -----------------------------------------------------------------------------
 * WHAT:  Builds the HTML of the "Proof" panel: the verdict, every check with
 *        its reason, a growth chart (time vs n, before and after), and every
 *        AI attempt — so the user can see WHY a fix was accepted or rejected.
 * WHY:   Gate #21 "Visualize": a speed-up is believed when it is seen. The
 *        chart is plain inline SVG (no chart library, works offline, follows
 *        the theme). Pure function — no vscode import — so it is unit-tested.
 *        Every piece of text that came from a model or from user code is
 *        HTML-escaped: model output is untrusted (prompt injection could try
 *        to inject markup into the panel).
 * FLOW:  views/parakh.ts -> proofHtml(data, nonce, cspSource, logoSvg) ->
 *        webview.html. The only script is the Apply/Discard button handler.
 * ========================================================================== */

import type { FixReport } from '../ai/verify';
import type { Fit, Point } from '../prove/core';

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export interface ProofData {
  kind: 'prove' | 'fix';
  fnName: string;
  file: string;
  /** prove mode */
  points?: Point[];
  fit?: Fit;
  inputLabel?: string;
  error?: string;
  /** fix mode */
  report?: FixReport;
  applied?: boolean;
  staticEstimate?: string;
}

/** Log–log chart of one or two measured series. Log scales make every growth
 *  order a straight line whose STEEPNESS is the exponent — easy to read. */
export function growthChart(series: Array<{ label: string; points: Point[]; cls: string }>): string {
  const all = series.flatMap((s) => s.points).filter((p) => p.t > 0 && p.n > 0);
  if (all.length < 2) return '';
  const W = 560, H = 260, L = 64, R = 16, T = 16, B = 40;
  const lx = (n: number) => Math.log10(n), ly = (t: number) => Math.log10(t);
  const [x0, x1] = [Math.min(...all.map((p) => lx(p.n))), Math.max(...all.map((p) => lx(p.n)))];
  const [y0, y1] = [Math.min(...all.map((p) => ly(p.t))), Math.max(...all.map((p) => ly(p.t)))];
  const sx = (n: number) => L + ((lx(n) - x0) / Math.max(1e-9, x1 - x0)) * (W - L - R);
  const sy = (t: number) => H - B - ((ly(t) - y0) / Math.max(1e-9, y1 - y0)) * (H - T - B);
  const fmtT = (t: number) => (t >= 1 ? `${t.toFixed(1)} s` : t >= 1e-3 ? `${(t * 1e3).toFixed(1)} ms` : `${(t * 1e6).toFixed(0)} µs`);
  const ticks = [y0, (y0 + y1) / 2, y1].map((v) => `<text x="${L - 6}" y="${sy(10 ** v) + 4}" text-anchor="end">${fmtT(10 ** v)}</text>`).join('');
  const xticks = [...new Set(all.map((p) => p.n))].filter((_, i, a) => i % Math.ceil(a.length / 6) === 0)
    .map((n) => `<text x="${sx(n)}" y="${H - B + 16}" text-anchor="middle">${n >= 1000 ? `${n / 1000}k` : n}</text>`).join('');
  const lines = series.map((s) => {
    const pts = s.points.filter((p) => p.t > 0).map((p) => `${sx(p.n).toFixed(1)},${sy(p.t).toFixed(1)}`);
    return `<polyline class="${s.cls}" points="${pts.join(' ')}"/>` + s.points.filter((p) => p.t > 0).map((p) => `<circle class="${s.cls}" cx="${sx(p.n).toFixed(1)}" cy="${sy(p.t).toFixed(1)}" r="3"><title>${esc(s.label)} — n=${p.n}: ${fmtT(p.t)}</title></circle>`).join('');
  }).join('');
  const legend = series.map((s, i) => `<g transform="translate(${L + 8 + i * 170},${T + 4})"><rect class="${s.cls}" width="12" height="4" y="4"/><text x="18" y="10">${esc(s.label)}</text></g>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Running time versus input size, log–log scale">
<line class="axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/><line class="axis" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"/>
${ticks}${xticks}<text x="${(W + L) / 2}" y="${H - 6}" text-anchor="middle">input size n (log scale)</text>${lines}${legend}</svg>`;
}

const ICON: Record<string, string> = { pass: '✔', fail: '✘', skip: '–', warn: '!' };

export function proofHtml(d: ProofData, nonce: string, cspSource: string, logoSvg: string): string {
  let body = '';
  if (d.kind === 'prove') {
    const f = d.fit;
    body = d.error ? `<p class="verdict fail">Could not measure: ${esc(d.error)}</p>` : `
<p class="verdict ${f?.confidence === 'low' ? 'warn' : 'pass'}">Measured growth: <b>${esc(f?.best ?? '?')}</b>
<span class="muted">(confidence ${esc(f?.confidence)}; log–log slope ${f ? f.slope.toFixed(2) : '?'})</span></p>
${d.staticEstimate ? `<p class="muted">Static estimate from the code shape: ${esc(d.staticEstimate)}.</p>` : ''}
${f?.note ? `<p class="note">${esc(f.note)}</p>` : ''}
${growthChart([{ label: `${d.fnName} (measured)`, points: d.points ?? [], cls: 's0' }])}
<p class="muted">Input: ${esc(d.inputLabel)}. Each point is the fastest of several runs. Fitted models (lower error is better):</p>
<table><tr><th>Model</th><th>Relative error</th></tr>${(f?.ranked ?? []).slice(0, 4).map((m, i) => `<tr class="${i === 0 ? 'best' : ''}"><td>${esc(m.label)}</td><td>${(m.error * 100).toFixed(1)}%</td></tr>`).join('')}</table>`;
  } else {
    const r = d.report!;
    const verdict = r.passed ? `<p class="verdict pass">Verified fix ready from <b>${esc(r.provider)}</b> after ${r.attempts.length} attempt${r.attempts.length > 1 ? 's' : ''}.</p>`
      : `<p class="verdict fail">No fix passed verification${r.error ? `: ${esc(r.error)}` : ` in ${r.attempts.length} attempt${r.attempts.length === 1 ? '' : 's'}`}. Nothing was changed.</p>`;
    const last = r.attempts[r.attempts.length - 1];
    const checks = (last?.checks ?? []).map((c) => `<tr class="${c.status}"><td>${ICON[c.status]}</td><td>${esc(c.title)}</td><td>${esc(c.detail).replace(/\n/g, '<br>')}</td></tr>`).join('');
    const perf = r.perf?.beforePoints && r.perf.afterPoints ? growthChart([
      { label: `before ${r.perf.before}`, points: r.perf.beforePoints, cls: 's1' }, { label: `after ${r.perf.after}`, points: r.perf.afterPoints, cls: 's0' }]) : '';
    const attempts = r.attempts.map((a) => `<details><summary>Attempt ${a.n}: ${a.checks.some((c) => c.status === 'fail') ? 'rejected' : 'accepted'}</summary>
<ul>${a.checks.map((c) => `<li class="${c.status}">${ICON[c.status]} ${esc(c.title)} — ${esc(c.detail)}</li>`).join('')}</ul>
${a.code ? `<pre><code>${esc(a.code)}</code></pre>` : `<pre>${esc(a.answerPreview)}</pre>`}</details>`).join('');
    const buttons = r.passed && !d.applied ? `<p class="actions"><button id="apply" class="primary">Apply verified fix</button> <button id="diff">Show diff</button> <button id="discard">Discard</button></p>`
      : d.applied ? '<p class="verdict pass">Applied. Undo with Ctrl+Z if you change your mind.</p>' : '';
    body = `${verdict}${buttons}<table class="checks"><tr><th></th><th>Check</th><th>Result</th></tr>${checks}</table>
${r.fixedRules.length ? `<p>Resolved: ${r.fixedRules.map(esc).join(', ')}</p>` : ''}${perf}<h3>Attempts</h3>${attempts}
<p class="muted">The model only proposes. Every check above is deterministic and ran on your machine. Code that added a security finding was never executed.</p>`;
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>KASAUTI proof</title>
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px 20px;max-width:860px;line-height:1.45}
header{display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:8px;margin-bottom:10px}
header svg{width:32px;height:32px;flex:none} header h2{margin:0;font-size:1.15em} header .muted{margin-left:auto}
.muted{opacity:.7;font-size:.92em} .note{border-left:3px solid #c9b14a;padding-left:8px}
.verdict{font-size:1.05em;padding:8px 10px;border-radius:4px;background:var(--vscode-editorWidget-background)}
.verdict.pass{border-left:4px solid #4f9d7a}.verdict.fail{border-left:4px solid #c0584f}.verdict.warn{border-left:4px solid #c9b14a}
table{border-collapse:collapse;margin:8px 0;width:100%} td,th{text-align:left;padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border);vertical-align:top}
tr.pass td:first-child,li.pass{color:#4f9d7a} tr.fail td:first-child,li.fail{color:#d16a61} tr.warn td:first-child{color:#c9b14a} tr.best{font-weight:600}
.chart{width:100%;max-width:600px;margin:8px 0} .chart text{fill:var(--vscode-foreground);font-size:11px;opacity:.8}
.chart .axis{stroke:var(--vscode-foreground);opacity:.35} .chart polyline{fill:none;stroke-width:2}
.s0{stroke:#4f9d7a;fill:#4f9d7a} polyline.s0{fill:none} .s1{stroke:#c0584f;fill:#c0584f} polyline.s1{fill:none}
pre{background:var(--vscode-textCodeBlock-background);padding:8px;overflow:auto;font-family:var(--vscode-editor-font-family)}
button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;padding:6px 12px;cursor:pointer;border-radius:2px}
button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)} button:focus-visible{outline:1px solid var(--vscode-focusBorder)}
footer{margin-top:18px;opacity:.55;font-size:.85em;display:flex;align-items:center;gap:6px} footer svg{width:16px;height:16px}
</style></head><body>
<header>${logoSvg}<h2>${d.kind === 'prove' ? 'Complexity proof' : 'Verified AI fix'} — <code>${esc(d.fnName)}</code></h2><span class="muted">${esc(d.file)}</span></header>
${body}
<footer>${logoSvg}<span>KASAUTI by Kanak Prabhakar</span></footer>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
for (const id of ['apply', 'diff', 'discard']) document.getElementById(id)?.addEventListener('click', () => vscode.postMessage({ type: id }));
</script></body></html>`;
}
