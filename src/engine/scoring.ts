/* =============================================================================
 * KASAUTI — engine/scoring.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Converts technical debt into a debt ratio, a 0–100 score, and an
 *        A–E grade — for a function, a file, a folder, or the whole workspace.
 * WHY:   SPEC §A7.1 (decided): the model is SonarQube's publicly documented
 *        SQALE-based maintainability rating, so every grade is defensible:
 *          debt ratio = debt minutes / (SLOC x 30 min)
 *          A <= 5%  B <= 10%  C <= 20%  D <= 50%  E > 50%
 *          score = round(100 x max(0, 1 - ratio / 0.5))
 * FLOW:  store.ts sums debt + SLOC  ->  scoreOf()  ->  views display it.
 *        Aggregates ALWAYS sum debt and SLOC first (never average scores), so
 *        many tiny clean files cannot hide one terrible file.
 * ========================================================================== */

import type { Grade, ScoreResult } from './types';

/** SonarQube default: estimated cost to develop one line of code. */
export const MINUTES_PER_LINE = 30;

/** Upper bounds of each grade's debt ratio (SonarQube defaults). */
const GRADE_BOUNDS: Array<[Grade, number]> = [['A', 0.05], ['B', 0.1], ['C', 0.2], ['D', 0.5]];

export function gradeOf(ratio: number): Grade {
  for (const [g, max] of GRADE_BOUNDS) if (ratio <= max) return g;
  return 'E';
}

export function scoreOf(debtMinutes: number, sloc: number): ScoreResult {
  // A file with no code has no debt to repay: it is trivially clean.
  const ratio = sloc > 0 ? debtMinutes / (sloc * MINUTES_PER_LINE) : 0;
  return {
    debtMinutes, sloc,
    debtRatio: Math.round(ratio * 10000) / 10000,
    score: Math.round(100 * Math.max(0, 1 - ratio / 0.5)),
    grade: gradeOf(ratio),
  };
}

/** Human readable debt: "45 min", "3 h 20 min", "2 d 1 h" (8-hour days). */
export function formatDebt(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60), m = Math.round(minutes % 60);
  if (h < 8) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 8), rh = h % 8;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}
