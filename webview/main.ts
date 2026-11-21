/* =============================================================================
 * KASAUTI — webview/main.ts  (the Code Map panel)
 * -----------------------------------------------------------------------------
 * WHAT:  Two ways to see the same data — kept to two on purpose (v2.2):
 *          Code Map — 3D map of folders, files, functions and imports
 *                     (schema3d.ts; the 2D schema.ts when WebGL is missing)
 *          List     — sortable table; the keyboard / screen-reader path
 *        plus a detail drawer that explains every problem in plain words, with
 *        "Open file", "Fix with AI" and "Prove speed" buttons, and a tooltip.
 * WHY:   Kanak's 2.2 feedback: too many options confused people; the pyramid
 *        is gone (removed, not hidden); VYUHA's strengths come in instead —
 *        3D, zoom/size sliders, double-click to jump to the exact line.
 * FLOW:  host posts 'init' / 'files' / 'detail' / 'focus' -> state -> active
 *        view re-renders; clicks post 'detail' / 'open' / 'command' back.
 * ========================================================================== */

import type { UiDetail, UiFile, UiSummary } from '../src/snapshot';
import { fill, formatDebt, gradeColor, gradeInk, h, loadState, onHost, saveState, send, setColorBlind } from './common';
import { matchesFilter } from './filter';
import { SchemaView } from './schema';
import { Schema3D } from './schema3d';
import { PLAIN, PLAIN_ORDER, plainCat, PlainCat } from '../src/audit/plain';

/* =============================================================================
 * State
 * ========================================================================== */
type View = 'schema' | 'list';
const saved = loadState<{ view?: string; filter?: string }>();
const state = {
  files: new Map<string, UiFile>(),
  summary: undefined as UiSummary | undefined,
  // Anything saved by older versions (pyramid, treemap) lands on the map.
  view: (saved?.view === 'list' ? 'list' : 'schema') as View,
  selected: undefined as string | undefined,
  detail: undefined as UiDetail | undefined,
  sort: { col: 'debt', dir: -1 } as { col: keyof UiFile; dir: 1 | -1 },
  /** One search box drives both views. */
  filter: (saved?.filter ?? '') as string,
};

const visibleFiles = () => [...state.files.values()].filter((f) => f.tier !== 3 && matchesFilter(f, state.filter));
const persist = () => saveState({ view: state.view, filter: state.filter });

/* =============================================================================
 * DOM skeleton
 * ========================================================================== */
const app = document.getElementById('app')!;
const toolbar = h('header', { class: 'toolbar' });
const stage = h('main', { class: 'stage', id: 'stage' });
const drawer = h('aside', { class: 'drawer', 'aria-label': 'File details', hidden: true });
const tooltip = h('div', { class: 'tip', role: 'tooltip', hidden: true });
const progress = h('div', { class: 'scanbar', hidden: true }, h('i'));
const notice = h('div', { class: 'notice', hidden: true });
app.append(toolbar, h('div', { class: 'body' }, stage, drawer));
stage.append(progress, tooltip, notice);

/* ---- toolbar: view · search · project grade · rescan ------------------------- */
const viewSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'View' });
for (const [v, label] of [['schema', 'Code Map'], ['list', 'List']] as Array<[View, string]>) {
  const b = h('button', { type: 'button', role: 'radio', 'data-v': v }, label);
  b.addEventListener('click', () => { state.view = v; persist(); renderAll(new Set()); });
  viewSeg.append(b);
}
const hallmark = h('div', { class: 'mini-mark', 'aria-live': 'polite' });
const scanBtn = h('button', { type: 'button', class: 'btn' }, 'Rescan');
scanBtn.addEventListener('click', () => send({ type: 'command', id: state.summary?.scanning ? 'cancel' : 'scan' }));
const filterBox = h('input', {
  type: 'search', class: 'filter', value: state.filter, spellcheck: 'false',
  placeholder: 'Search files…', 'aria-label': 'Search files (also understands grade:D and rule:KP203)',
}) as HTMLInputElement;
let filterTimer: number | undefined;
filterBox.addEventListener('input', () => {
  window.clearTimeout(filterTimer);
  filterTimer = window.setTimeout(() => {
    state.filter = filterBox.value;
    persist();
    renderAll(new Set());
    const n = visibleFiles().length;
    filterCount.textContent = state.filter.trim() ? `${n} of ${[...state.files.values()].filter((f) => f.tier !== 3).length}` : '';
  }, 160);
});
filterBox.addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Escape') { filterBox.value = ''; filterBox.dispatchEvent(new Event('input')); }
});
const filterCount = h('span', { class: 'filter-count', 'aria-live': 'polite' });
toolbar.append(viewSeg, filterBox, filterCount, h('span', { class: 'spacer' }), hallmark, scanBtn);

/* =============================================================================
 * CODE MAP — 3D when WebGL works, 2D otherwise (same graph, same callbacks)
 * ========================================================================== */
const mapHost = {
  select: (key: string) => select(key, false),
  // Double-click = jump to code (VYUHA's tap-to-jump). A file jumps to its worst problem.
  open: (key: string, line?: number) => send({ type: 'open', key, line: line ?? state.files.get(key)?.issues?.[0]?.line }),
  selected: () => state.selected,
  tip: (key: string | undefined, x: number, y: number, text?: string) => showTip(key, x, y, text),
};
let schema: Schema3D | SchemaView;
let mapNote: string | undefined;
try { schema = new Schema3D(mapHost); }
catch (e) { schema = new SchemaView(mapHost); mapNote = `3D needs WebGL (${String((e as Error)?.message ?? e)}). Showing the flat map instead.`; }
schema.el.addEventListener('keydown', (ev) => keyNav(ev as KeyboardEvent));

/* =============================================================================
 * LIST (accessible table)
 * ========================================================================== */
const listEl = h('div', { class: 'list' });
const COLS: Array<[keyof UiFile, string, boolean]> = [
  ['path', 'File', false], ['lang', 'Language', false], ['grade', 'Grade', false], ['score', 'Score', true],
  ['sloc', 'Lines', true], ['debt', 'Debt', true], ['maxCC', 'Max complexity', true], ['maxCog', 'Max cognitive', true],
];
function renderList(): void {
  const files = visibleFiles().sort((a, b) => {
    const x = a[state.sort.col] as string | number, y = b[state.sort.col] as string | number;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * state.sort.dir;
  });
  const thead = h('tr');
  for (const [col, label, num] of COLS) {
    const active = state.sort.col === col;
    const th = h('th', { scope: 'col', class: num ? 'num' : undefined, 'aria-sort': active ? (state.sort.dir === 1 ? 'ascending' : 'descending') : 'none' });
    const b = h('button', { type: 'button' }, label + (active ? (state.sort.dir === 1 ? ' ▲' : ' ▼') : ''));
    b.addEventListener('click', () => {
      state.sort = { col, dir: active ? (state.sort.dir === 1 ? -1 : 1) : num ? -1 : 1 };
      renderList();
    });
    th.append(b);
    thead.append(th);
  }
  const tbody = h('tbody');
  for (const f of files) {
    const tr = h('tr', { tabindex: 0, class: f.key === state.selected ? 'sel' : undefined, 'data-k': f.key });
    tr.append(
      h('td', { class: 'path' }, f.path),
      h('td', {}, f.lang + (f.tier === 2 ? ' (partial)' : '')),
      h('td', {}, h('span', { class: 'chip', style: `background:${gradeColor(f.grade)};color:${gradeInk(f.grade)}` }, f.grade)),
      h('td', { class: 'num' }, String(f.score)), h('td', { class: 'num' }, f.sloc.toLocaleString('en')),
      h('td', { class: 'num' }, formatDebt(f.debt)), h('td', { class: 'num' }, String(f.maxCC)), h('td', { class: 'num' }, String(f.maxCog)));
    tr.addEventListener('click', () => select(f.key, false));
    tr.addEventListener('dblclick', () => send({ type: 'open', key: f.key }));
    tr.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') select(f.key, false);
      if (ev.key.toLowerCase() === 'o') send({ type: 'open', key: f.key });
    });
    tbody.append(tr);
  }
  listEl.replaceChildren(h('table', {}, h('caption', { class: 'sr' }, 'Files with their grade and metrics'), h('thead', {}, thead), tbody));
}

/* =============================================================================
 * Tooltip, selection, keyboard
 * ========================================================================== */
function showTip(key: string | undefined, x: number, y: number, text?: string): void {
  const f = key ? state.files.get(key) : undefined;
  if (!f && !text) { tooltip.hidden = true; return; }
  if (!f) fill(tooltip, h('div', {}, text!));       // v2.1: Code Map folders / functions
  else fill(tooltip, 
    h('div', { class: 'tip-head' }, h('span', { class: 'chip', style: `background:${gradeColor(f.grade)};color:${gradeInk(f.grade)}` }, f.grade), h('b', {}, f.path.split('/').pop()!)),
    h('div', { class: 'tip-path' }, f.path),
    h('div', {}, `Score ${f.score}/100 · ${f.sloc.toLocaleString('en')} lines`),
    f.tier === 2 ? h('div', { class: 'muted' }, 'Partial analysis (no parser for this language)') : undefined,
    // v2.2: say WHAT is wrong in plain words, coloured by problem group.
    f.issues?.length
      ? h('ul', { class: 'tip-issues' }, ...f.issues.map((x) => h('li', {}, h('i', { style: `background:${PLAIN[x.cat].color}` }), h('b', {}, PLAIN[x.cat].label + ': '), `${x.title} (line ${x.line + 1})`)))
      : h('div', { class: 'muted' }, 'No problems found in this file.'),
    f.issues?.length ? h('div', { class: 'muted' }, 'Click to see why and how to fix.') : undefined);
  tooltip.hidden = false;
  const r = stage.getBoundingClientRect();
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  let left = x - r.left + 14, top = y - r.top + 14;
  if (left + tw > r.width - 8) left = x - r.left - tw - 14;
  if (top + th > r.height - 8) top = y - r.top - th - 14;
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}

function select(key: string, fly: boolean): void {
  state.selected = key;
  send({ type: 'detail', key });
  schema.selectionChanged();
  if (fly && state.view === 'schema') schema.focusKey(key);
  if (state.view === 'list') renderList();
}

/** Keyboard navigation in the map (order = most debt first). */
function keyNav(ev: KeyboardEvent): void {
  const order = visibleFiles().sort((a, b) => b.debt - a.debt || a.path.localeCompare(b.path));
  if (!order.length) return;
  const idx = state.selected ? order.findIndex((f) => f.key === state.selected) : -1;
  const go = (i: number) => { ev.preventDefault(); select(order[(i + order.length) % order.length].key, true); };
  if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') go(idx + 1);
  else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') go(idx - 1);
  else if (ev.key === 'Home') go(0);
  else if (ev.key === 'Enter' && state.selected) select(state.selected, true);
  else if (ev.key.toLowerCase() === 'o' && state.selected) send({ type: 'open', key: state.selected });
}
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !drawer.hidden) closeDrawer(); });

/* =============================================================================
 * Detail drawer
 * ========================================================================== */
function closeDrawer(): void {
  drawer.hidden = true;
  state.selected = undefined;
  state.detail = undefined;
  schema.selectionChanged();
  if (state.view === 'list') renderList();
}

function renderDrawer(d: UiDetail): void {
  const f = d.file;
  const close = h('button', { type: 'button', class: 'icon', 'aria-label': 'Close details' }, '×');
  close.addEventListener('click', closeDrawer);
  const open = h('button', { type: 'button', class: 'btn primary' }, 'Open file');
  open.addEventListener('click', () => send({ type: 'open', key: f.key }));
  // v2.2: the AI and proof features as buttons. Target = the function with the
  // most serious problem (the host opens the file there and runs the command).
  const target = f.issues?.[0]?.line ?? (d.functions[0]?.startLine);
  const fix = h('button', { type: 'button', class: 'btn', title: 'Ask your chosen AI for a fix; KASAUTI checks it before you can apply it' }, '✨ Fix with AI');
  fix.addEventListener('click', () => send({ type: 'command', id: 'fix', key: f.key, line: target }));
  const slow = f.issues?.find((x) => x.cat === 'slow');
  const prove = slow ? h('button', { type: 'button', class: 'btn', title: 'Run the function on growing inputs and measure how its time grows' }, '📈 Measure speed') : undefined;
  prove?.addEventListener('click', () => send({ type: 'command', id: 'prove', key: f.key, line: slow!.line }));
  const actions = h('div', { class: 'd-actions' }, open, f.issues?.length ? fix : undefined, prove);

  const fnRows = [...d.functions].sort((a, b) => b.cognitive - a.cognitive || b.cyclomatic - a.cyclomatic).map((fn) => {
    const tr = h('tr', { tabindex: 0, title: `Open ${fn.name} at line ${fn.startLine + 1}` },
      h('td', { class: 'fn' }, fn.name), h('td', {}, h('span', { class: 'chip', style: `background:${gradeColor(fn.grade)};color:${gradeInk(fn.grade)}` }, fn.grade)),
      h('td', { class: 'num' }, String(fn.cyclomatic)), h('td', { class: 'num' }, String(fn.cognitive)),
      h('td', { class: 'num' }, String(fn.maxNesting)), h('td', { class: 'num' }, String(fn.sloc)));
    const go = () => send({ type: 'open', key: f.key, line: fn.startLine });
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    return tr;
  });

  // v2.2: findings grouped by plain-language problem, most dangerous first.
  // The rule name leads; the rule id is a small tag for people who want it.
  const shown = d.findings.filter((x) => x.severity !== 'info' || x.ruleId === 'CQ011');
  const groups = PLAIN_ORDER.map((cat) => [cat, shown.filter((x) => (x.cat ?? plainCat(x.ruleId)) === cat)] as [PlainCat, typeof shown]).filter(([, xs]) => xs.length);
  const findings = groups.map(([cat, xs]) => h('section', { class: 'fgroup' },
    h('h4', { style: `border-color:${PLAIN[cat].color}` }, h('i', { style: `background:${PLAIN[cat].color}` }), `${PLAIN[cat].label} (${xs.length})`),
    h('p', { class: 'muted' }, PLAIN[cat].explain),
    h('ul', { class: 'findings' }, ...xs.map((x) => {
      const line = h('button', { type: 'button', class: 'link' }, `line ${x.line + 1}`);
      line.addEventListener('click', () => send({ type: 'open', key: f.key, line: x.line }));
      return h('li', { class: `finding ${x.severity}` },
        h('div', { class: 'f-head' }, h('b', {}, x.ruleName), line, h('code', { class: 'muted' }, x.ruleId)),
        h('p', {}, x.message),
        h('details', {}, h('summary', {}, 'Why it matters and how to fix'), h('p', {}, x.why), h('ul', {}, ...x.fix.map((s2) => h('li', {}, s2)))));
    }))));
  const findingCount = shown.length;

  fill(drawer, 
    h('div', { class: 'd-head' },
      h('span', { class: 'chip big', style: `background:${gradeColor(f.grade)};color:${gradeInk(f.grade)}` }, f.grade),
      h('div', { class: 'd-title' }, h('b', {}, f.path.split('/').pop()!), h('small', {}, f.path)), close),
    h('p', { class: 'd-stats' }, `Score ${f.score}/100 · about ${formatDebt(f.debt)} of work to fix · ${f.sloc.toLocaleString('en')} lines of ${f.lang}.`),
    d.note ? h('p', { class: 'note' }, d.note) : undefined,
    actions,
    h('section', {}, h('h3', {}, findingCount ? `Problems (${findingCount})` : 'No problems found'), ...findings),
    // v2.2: problems first; the technical per-function numbers fold away.
    d.functions.length ? h('details', { class: 'fn-details' }, h('summary', {}, `Functions (${d.functions.length}) — complexity numbers`),
      h('table', { class: 'fns' }, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Grade'), h('th', { class: 'num', title: 'Cyclomatic complexity' }, 'CC'),
        h('th', { class: 'num', title: 'Cognitive complexity' }, 'Cog'), h('th', { class: 'num', title: 'Max nesting' }, 'Nest'), h('th', { class: 'num' }, 'Lines'))), h('tbody', {}, ...fnRows))) : undefined);
  drawer.hidden = false;
}

/* =============================================================================
 * Render orchestration
 * ========================================================================== */
function renderChrome(): void {
  viewSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === state.view)));
  const s = state.summary;
  if (s && (s.scanned || state.files.size)) {
    hallmark.replaceChildren(
      h('span', { class: 'chip', style: `background:${gradeColor(s.grade)};color:${gradeInk(s.grade)}` }, s.grade),
      h('span', {}, h('b', {}, String(s.score)), ' / 100'));
  } else hallmark.replaceChildren();
  scanBtn.textContent = s?.scanning ? 'Cancel scan' : 'Rescan';
  progress.hidden = !s?.scanning;
  if (s?.scanning) (progress.firstChild as HTMLElement).style.width = `${s.scanning.total ? (100 * s.scanning.done) / s.scanning.total : 3}%`;
}

function renderAll(changed: Set<string>): void {
  renderChrome();
  const files = visibleFiles();
  // Empty states are directions, not moods: the scan button is never hidden.
  const msgs: Node[] = [];
  if (state.view === 'schema' && mapNote) msgs.push(h('p', {}, mapNote));
  if (!files.length) {
    if (state.summary?.scanning) msgs.push(h('p', {}, 'Finding files…'));
    else {
      const b = h('button', { type: 'button', class: 'btn primary' }, 'Scan workspace');
      b.addEventListener('click', () => send({ type: 'command', id: 'scan' }));
      msgs.push(h('p', {}, 'No files analyzed yet.'), b);
    }
  }
  notice.hidden = msgs.length === 0;
  notice.classList.toggle('corner', files.length > 0);
  notice.replaceChildren(...(msgs.length ? [h('div', {}, ...msgs)] : []));
  for (const el of [listEl, schema.el]) el.remove();
  if (state.view === 'schema') { stage.prepend(schema.el); schema.setData(files, changed); }
  else { stage.prepend(listEl); renderList(); }
}

/** The map updates on every batch (cheap). The list rebuilds DOM, so during a
 *  scan it redraws at most every 300 ms. */
let pendingChanged = new Set<string>();
let renderTimer: number | undefined;
function scheduleRender(changed: Set<string>): void {
  if (state.view === 'schema') { renderAll(changed); return; }
  changed.forEach((k) => pendingChanged.add(k));
  if (renderTimer !== undefined) return;
  renderTimer = window.setTimeout(() => { renderTimer = undefined; const c = pendingChanged; pendingChanged = new Set(); renderAll(c); }, 300);
}

/* =============================================================================
 * Messages from the host
 * ========================================================================== */
onHost((m) => {
  switch (m.type) {
    case 'init':
      setColorBlind(m.colorBlind);
      state.files = new Map(m.files.map((f) => [f.key, f]));
      state.summary = m.summary;
      renderAll(new Set());
      break;
    case 'files': {
      for (const k of m.remove) state.files.delete(k);
      for (const f of m.upsert) state.files.set(f.key, f);
      state.summary = m.summary;
      scheduleRender(new Set(m.upsert.map((f) => f.key)));
      // Keep an open drawer in sync with live edits of that file.
      if (state.selected && m.upsert.some((f) => f.key === state.selected)) send({ type: 'detail', key: state.selected });
      if (state.selected && m.remove.includes(state.selected)) closeDrawer();
      break;
    }
    case 'summary': state.summary = m.summary; renderChrome(); break;
    case 'detail': state.detail = m.detail; if (m.detail.file.key === state.selected || !state.selected) { state.selected = m.detail.file.key; renderDrawer(m.detail); } break;
    case 'focus': select(m.key, true); break;
    case 'palette': setColorBlind(m.colorBlind); renderAll(new Set()); break;
  }
});
send({ type: 'ready' });
