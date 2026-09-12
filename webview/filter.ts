/* =============================================================================
 * KASAUTI — webview/filter.ts   (v0.2.0, feature F7)
 * -----------------------------------------------------------------------------
 * WHAT:  The filter language behind the toolbar's filter box.
 * WHY:   Pure and DOM-free so it can be tested in Node. main.ts cannot be
 *        imported in a test — it builds the DOM and loads Three.js at import
 *        time — and an untested filter silently hides the wrong files.
 *
 * THE LANGUAGE, deliberately tiny so it needs no documentation:
 *     grade:D        files graded exactly D
 *     grade:>=C      files graded C or worse
 *     rule:CQ001     files where that rule fired
 *     partial:yes    files that were only estimated (tier 2)
 *     src/api        plain text, matched against the path
 * Terms combine with AND. An unrecognised term is treated as text, never an
 * error — a filter box that rejects what you type is worse than one that
 * finds nothing.
 * FLOW:  toolbar input -> state.filter -> visibleFiles() -> all three views
 * ========================================================================== */

import type { UiFile } from '../src/snapshot';

const GRADES = 'abcde';

export function matchesFilter(f: UiFile, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  return terms.every((t) => {
    const atLeast = /^grade:>=([a-e])$/.exec(t);
    if (atLeast) return GRADES.indexOf(f.grade.toLowerCase()) >= GRADES.indexOf(atLeast[1]);
    const grade = /^grade:([a-e])$/.exec(t);
    if (grade) return f.grade.toLowerCase() === grade[1];
    const rule = /^rule:(cq\d{3})$/.exec(t);
    if (rule) return (f.rules ?? []).some((r) => r.toLowerCase() === rule[1]);
    if (t === 'partial:yes') return f.tier === 2;
    if (t === 'partial:no') return f.tier === 1;
    return f.path.toLowerCase().includes(t);
  });
}
