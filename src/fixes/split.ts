/* =============================================================================
 * KASAUTI — fixes/split.ts   (v0.2.0, feature F4)
 * -----------------------------------------------------------------------------
 * WHAT:  Decide where an over-long line may safely be broken.
 * WHY:   Separated from index.ts, which imports `vscode`. This is the part
 *        most likely to be wrong and the part most worth testing, so it must
 *        be importable in a plain Node test with no editor around it.
 * FLOW:  fixes/index.ts -> safeSplitPoint(lineText) -> WorkspaceEdit
 * ========================================================================== */

/**
 * Find a break point after a comma at bracket depth 1, outside every string
 * and comment. Returns undefined when there is no safe point — no fix is
 * better than a fix that wraps a string literal or breaks a comment.
 */
export function safeSplitPoint(text: string): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  let best: number | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i++; continue; }          // escaped char: skip it
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    // A comment starts here: everything after is prose, never split it.
    if ((c === '/' && text[i + 1] === '/') || c === '#') break;
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    // Prefer the comma nearest the middle: splitting at the first one usually
    // leaves a tail that is still too long.
    if (c === ',' && depth === 1) {
      if (best === undefined || Math.abs(i - text.length / 2) < Math.abs(best - text.length / 2)) best = i + 1;
    }
  }
  if (best === undefined || quote !== undefined) return undefined;
  if (best < 12 || text.length - best < 8) return undefined;   // pointless split
  return best;
}
