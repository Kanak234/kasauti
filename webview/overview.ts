/* =============================================================================
 * KASAUTI — webview/overview.ts  (sidebar "Overview")
 * -----------------------------------------------------------------------------
 * WHAT:  Renders the workspace summary in the Activity Bar sidebar: the score
 *        and grade, technical debt, where the debt comes from, the files that
 *        cost the most, and scan progress. Uses VS Code theme colors only.
 * WHY:   UI brief §C3.1 — the first thing a user sees after a scan, answering
 *        "how good is this codebase and what should I fix first?".
 * FLOW:  host views/webviews.ts OverviewView posts 'init' / 'summary' ->
 *        render(); buttons post 'command' / 'open' back to the host.
 * ========================================================================== */

import type { UiSummary } from '../src/snapshot';
import { formatDebt, gradeColor, gradeInk, h, onHost, send, setColorBlind } from './common';

const app = document.getElementById('app')!;
const CATS: Array<[keyof UiSummary['byCategory'], string]> = [
  ['complexity', 'Complexity'], ['size', 'Size'], ['duplication', 'Duplication'], ['style', 'Style'],
];

function button(label: string, id: 'scan' | 'pyramid' | 'export' | 'cancel', primary = false) {
  const b = h('button', { class: primary ? 'btn primary' : 'btn', type: 'button' }, label);
  b.addEventListener('click', () => send({ type: 'command', id }));
  return b;
}

function render(s: UiSummary): void {
  app.replaceChildren();

  // ---- scanning: progress first ----------------------------------------
  if (s.scanning) {
    const pct = s.scanning.total ? Math.round((100 * s.scanning.done) / s.scanning.total) : 0;
    app.append(h('section', { class: 'scan' },
      h('p', {}, s.scanning.total ? `Analyzing ${s.scanning.done} of ${s.scanning.total} files` : 'Finding files…'),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct },
        h('i', { style: `width:${pct}%` })),
      button('Cancel scan', 'cancel')));
  }

  // ---- never scanned: an invitation, not an empty screen -----------------
  if (!s.scanned && !s.scanning) {
    app.append(h('section', { class: 'empty' },
      h('h2', {}, 'Test your code on the touchstone'),
      h('p', {}, 'Scan the workspace to grade every file from A to E using industry metrics: complexity, size, duplication and maintainability.'),
      h('p', { class: 'muted' }, 'Open files are already graded as you type.'),
      button('Scan workspace', 'scan', true)));
    return;
  }

  // ---- the hallmark: score + grade ---------------------------------------
  const mark = h('div', { class: 'hallmark', style: `--g:${gradeColor(s.grade)};--gi:${gradeInk(s.grade)}` },
    h('span', { class: 'grade', 'aria-label': `Grade ${s.grade}` }, s.grade),
    h('span', { class: 'score' }, String(s.score), h('small', {}, '/100')));
  const facts = h('dl', { class: 'facts' },
    h('dt', {}, 'Technical debt'), h('dd', {}, s.debtText),
    h('dt', {}, 'Lines of code'), h('dd', {}, s.sloc.toLocaleString('en')),
    h('dt', {}, 'Duplicated lines'), h('dd', {}, `${s.duplicatedPct}%`),
    h('dt', {}, 'Files'), h('dd', {}, `${s.files}`));
  app.append(h('section', { class: 'top' }, mark, facts));
  if (s.tier2 || s.skipped) {
    app.append(h('p', { class: 'note' },
      [s.tier2 ? `${s.tier2} file${s.tier2 > 1 ? 's' : ''} had partial analysis (no parser for the language).` : '',
        s.skipped ? `${s.skipped} skipped (generated, minified, binary or too large).` : ''].filter(Boolean).join(' ')));
  }

  // ---- where the debt comes from -------------------------------------------
  const total = Math.max(1, CATS.reduce((a, [k]) => a + s.byCategory[k], 0));
  const bar = h('div', { class: 'stack', role: 'img', 'aria-label': 'Technical debt by category' });
  const legend = h('ul', { class: 'legend' });
  CATS.forEach(([k, label], i) => {
    const v = s.byCategory[k];
    if (v > 0) bar.append(h('i', { class: `c${i}`, style: `flex:${v}`, title: `${label}: ${formatDebt(v)}` }));
    legend.append(h('li', {}, h('b', { class: `c${i}` }), `${label} `, h('span', { class: 'muted' }, `${Math.round((100 * v) / total)}%`)));
  });
  app.append(h('section', {}, h('h3', {}, 'Where the debt comes from'), bar, legend));

  // ---- hotspots --------------------------------------------------------------
  if (s.hotspots.length) {
    const list = h('ol', { class: 'hot' });
    for (const hs of s.hotspots) {
      const b = h('button', { type: 'button', class: 'hot-item', title: `Open ${hs.path}` },
        h('span', { class: 'chip', style: `background:${gradeColor(hs.grade)};color:${gradeInk(hs.grade)}` }, hs.grade),
        h('span', { class: 'path' }, hs.path.split('/').pop()!, h('small', {}, hs.path)),
        h('span', { class: 'debt' }, hs.debtText));
      b.addEventListener('click', () => send({ type: 'open', key: hs.key }));
      list.append(h('li', {}, b));
    }
    app.append(h('section', {}, h('h3', {}, 'Fix these first'), list));
  } else if (s.scanned) {
    app.append(h('p', { class: 'muted' }, 'No file has remediation cost. Clean work.'));
  }

  app.append(h('div', { class: 'actions' }, button('Open pyramid', 'pyramid', true), button('Export report', 'export'), button('Rescan', 'scan')));
}

onHost((m) => {
  if (m.type === 'init') { setColorBlind(m.colorBlind); render(m.summary); }
  else if (m.type === 'summary') render(m.summary);
  else if (m.type === 'palette') setColorBlind(m.colorBlind);
});
send({ type: 'ready' });
