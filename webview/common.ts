/* =============================================================================
 * KASAUTI — webview/common.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Small helpers shared by both webviews (overview.ts, main.ts):
 *        the VS Code messaging bridge, grade color palettes, formatting.
 * WHY:   One palette definition = the pyramid, treemap, list and sidebar can
 *        never disagree about what "grade C" looks like (UI brief §C9).
 * FLOW:  imported by webview/main.ts and webview/overview.ts (bundled by esbuild).
 * ========================================================================== */

import type { HostMessage, WebviewMessage } from '../src/protocol';
import type { Grade } from '../src/engine/types';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscodeApi = acquireVsCodeApi();

export function send(msg: WebviewMessage): void { vscodeApi.postMessage(msg); }
export function onHost(fn: (m: HostMessage) => void): void {
  window.addEventListener('message', (e: MessageEvent) => fn(e.data as HostMessage));
}
export const saveState = (s: unknown) => vscodeApi.setState(s);
export const loadState = <T>(): T | undefined => vscodeApi.getState() as T | undefined;

/** Default grade colors: green -> red ramp, tuned for both light and dark. */
const STANDARD: Record<Grade, string> = { A: '#3fae7a', B: '#8fbf45', C: '#e3b53b', D: '#ea8a3c', E: '#df5151' };
/** Okabe–Ito color-blind-safe set (distinct for protan/deutan/tritan). */
const COLOR_BLIND: Record<Grade, string> = { A: '#0072b2', B: '#56b4e9', C: '#f0e442', D: '#e69f00', E: '#d55e00' };
let colorBlind = false;
export function setColorBlind(on: boolean): void {
  colorBlind = on;
  document.body.classList.toggle('cb', on);
}
export function gradeColor(g: Grade): string { return (colorBlind ? COLOR_BLIND : STANDARD)[g]; }
/** Readable text color on top of a grade swatch. */
export function gradeInk(g: Grade): string { return colorBlind && (g === 'C' || g === 'B') ? '#1b1b1b' : g === 'C' ? '#2a2206' : '#fff'; }

export const GOLD = '#d4a94a';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function formatDebt(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (h < 8) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 8), rh = h % 8;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}

export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Tiny DOM builder: h('div', {class: 'x'}, 'text', child) */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | number | boolean | undefined> = {}, ...children: Array<Node | string | undefined | false>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== undefined && c !== false) el.append(c);
  return el;
}

/** replaceChildren that skips undefined/false (for optional sections). */
export function fill(el: Element, ...children: Array<Node | string | undefined | false>): void {
  el.replaceChildren(...children.filter((c): c is Node | string => c !== undefined && c !== false));
}
