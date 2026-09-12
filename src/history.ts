/* =============================================================================
 * KASAUTI — history.ts   (v0.2.0, feature F6)
 * -----------------------------------------------------------------------------
 * WHAT:  Remembers one data point per completed workspace scan — grade, score,
 *        debt, SLOC — so the Overview can show whether the project is getting
 *        better or worse.
 * WHY:   A single grade says nothing about direction. "C, but down from E" is
 *        the sentence that actually changes behaviour.
 * HOW:   A ring buffer in workspaceState (per workspace, no files written).
 *        Old samples roll up into one entry per month rather than being thrown
 *        away, so a year-old trend is still visible at a fraction of the size.
 * FLOW:  controller finishes a scan -> record() -> Overview reads series()
 *
 * DELIBERATELY NOT recorded: live edits. A sample per keystroke would make the
 * trend a record of typing, not of the project.
 * ========================================================================== */

import type { Grade } from './engine/types';

export interface HistorySample {
  /** Unix ms. */
  t: number;
  grade: Grade;
  score: number;
  debtMinutes: number;
  sloc: number;
  files: number;
  /** Set on rolled-up entries: how many scans this row represents. */
  n?: number;
}

export const MAX_SAMPLES = 200;
/** Samples older than this are rolled up into monthly averages. */
const ROLLUP_AFTER_DAYS = 60;
const DAY = 86_400_000;

/** Storage the extension host gives us; kept as an interface so tests need no VS Code. */
export interface HistoryStorage {
  get(key: string): HistorySample[] | undefined;
  update(key: string, value: HistorySample[] | undefined): Thenable<void> | void;
}

const KEY = 'kasauti.history.v1';

export class History {
  constructor(private readonly storage: HistoryStorage, private readonly now: () => number = Date.now) {}

  /** Every sample, oldest first. */
  series(): HistorySample[] {
    const raw = this.storage.get(KEY);
    return Array.isArray(raw) ? raw.filter(isSample).sort((a, b) => a.t - b.t) : [];
  }

  /**
   * Append one sample. Called once per completed scan — never on a live edit.
   * Two scans within the same minute collapse into one, so mashing "Scan
   * workspace" does not drown the trend.
   */
  record(sample: Omit<HistorySample, 't'>, at = this.now()): HistorySample[] {
    const series = this.series();
    const last = series[series.length - 1];
    const next: HistorySample = { t: at, ...sample };
    if (last && at - last.t < 60_000) series[series.length - 1] = next;
    else series.push(next);
    const compacted = compact(series, at);
    void this.storage.update(KEY, compacted);
    return compacted;
  }

  clear(): void { void this.storage.update(KEY, undefined); }

  /** Change since the oldest sample and since the previous one. */
  delta(): { sinceStart?: number; sinceLast?: number; span?: number } {
    const s = this.series();
    if (s.length < 2) return {};
    const first = s[0], last = s[s.length - 1], prev = s[s.length - 2];
    return { sinceStart: last.score - first.score, sinceLast: last.score - prev.score, span: last.t - first.t };
  }
}

function isSample(x: unknown): x is HistorySample {
  const s = x as HistorySample;
  return !!s && typeof s.t === 'number' && typeof s.score === 'number' && typeof s.debtMinutes === 'number';
}

/**
 * Keep recent samples exact; average older ones per month; then hard-cap the
 * total. Exported for testing — the cap is the only thing standing between a
 * daily-scanning user and an ever-growing workspaceState entry.
 */
export function compact(series: HistorySample[], now: number): HistorySample[] {
  const cutoff = now - ROLLUP_AFTER_DAYS * DAY;
  const recent = series.filter((s) => s.t >= cutoff);
  const old = series.filter((s) => s.t < cutoff);

  const months = new Map<string, HistorySample[]>();
  for (const s of old) {
    const d = new Date(s.t);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    const list = months.get(key);
    if (list) list.push(s); else months.set(key, [s]);
  }
  const rolled = [...months.values()].map((group) => {
    const n = group.reduce((a, s) => a + (s.n ?? 1), 0);
    const w = (pick: (s: HistorySample) => number) =>
      Math.round(group.reduce((a, s) => a + pick(s) * (s.n ?? 1), 0) / n);
    return {
      t: group[group.length - 1].t,
      grade: group[group.length - 1].grade,
      score: w((s) => s.score),
      debtMinutes: w((s) => s.debtMinutes),
      sloc: w((s) => s.sloc),
      files: w((s) => s.files),
      n,
    } as HistorySample;
  });

  const all = [...rolled, ...recent].sort((a, b) => a.t - b.t);
  return all.length > MAX_SAMPLES ? all.slice(all.length - MAX_SAMPLES) : all;
}

/** SVG polyline points for the Overview sparkline. Pure, so it is testable. */
export function sparklinePath(series: HistorySample[], w: number, h: number): string {
  if (series.length < 2) return '';
  const t0 = series[0].t, t1 = series[series.length - 1].t;
  const span = Math.max(1, t1 - t0);
  return series.map((s) => {
    const x = ((s.t - t0) / span) * w;
    const y = h - (Math.max(0, Math.min(100, s.score)) / 100) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}
