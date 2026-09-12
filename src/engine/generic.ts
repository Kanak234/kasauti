/* =============================================================================
 * KASAUTI — engine/generic.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Language-independent ("Tier 2") analysis for files that have no
 *        tree-sitter grammar: SLOC, comment lines, TODOs, line lengths,
 *        indentation-estimated nesting, and a token stream for duplication.
 * WHY:   Kanak's requirement: EVERY language is supported from day one. Where
 *        no parser exists we still measure what can be measured honestly, and
 *        the UI labels the result "Partial analysis" (SPEC §A7.2).
 * FLOW:  analyzer.ts -> analyzeTier2(text, commentPrefixes, languageKey)
 *        -> partial FileAnalysis -> back to analyzer.ts
 * ========================================================================== */

import { fnv1a } from './metrics';
import { parseDirectives, Suppression } from './suppress';
import type { TodoMarker } from './types';

/* A deliberately simple tokenizer: identifiers, numbers, quoted strings, and
 * single punctuation characters. Good enough for copy-paste detection, which
 * is the only thing tokens are used for in Tier 2. */
const TOKEN_RE = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\S/g;
const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b[:\s-]*(.*)/;

/** Markup/style files are naturally deeply indented, so indentation says
 *  nothing about control-flow nesting there. Skip the estimate for them. */
const NO_INDENT_NESTING = new Set(['html', 'css', 'vue', 'svelte', 'xml']);

export function analyzeTier2(text: string, commentPrefixes: string[], languageKey: string) {
  const lines = text.split(/\r?\n/);
  const lineLengths = Uint32Array.from(lines, (l) => l.length);
  const todos: TodoMarker[] = [];
  const suppressions: Suppression[] = [];
  const ids: number[] = [];
  const tokLines: number[] = [];
  let sloc = 0, commentLines = 0;

  // Indentation bookkeeping for the nesting estimate.
  const indents: number[] = [];
  const deltaVotes = new Map<number, number>();
  let prevIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;                                   // blank line
    const todo = TODO_RE.exec(raw);
    if (todo) todos.push({ line: i, col: todo.index, text: (todo[1] + ' ' + todo[2]).trim().slice(0, 120) });
    if (commentPrefixes.some((p) => trimmed.startsWith(p))) { commentLines++; suppressions.push(...parseDirectives(raw, i)); continue; }
    sloc++;

    // Leading whitespace width (tab = 4 columns).
    let w = 0;
    for (const ch of raw) { if (ch === ' ') w++; else if (ch === '\t') w += 4; else break; }
    indents.push(w);
    if (w > prevIndent) { const d = w - prevIndent; deltaVotes.set(d, (deltaVotes.get(d) ?? 0) + 1); }
    prevIndent = w;

    for (const m of raw.matchAll(TOKEN_RE)) { ids.push(fnv1a(m[0])); tokLines.push(i); }
  }

  // Indent unit = the most common indentation step (2, 4, 8...).
  let unit = 4, best = 0;
  for (const [d, votes] of deltaVotes) if (d >= 2 && d <= 8 && votes > best) { best = votes; unit = d; }

  let indentNesting: { depth: number; line: number } | undefined;
  const name = languageKey.replace(/^tier2:/, '');
  if (!NO_INDENT_NESTING.has(name)) {
    let maxDepth = 0, maxLine = 0, k = 0;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || commentPrefixes.some((p) => trimmed.startsWith(p))) continue;
      const depth = Math.floor(indents[k++] / unit);
      if (depth > maxDepth) { maxDepth = depth; maxLine = i; }
    }
    // Level 1 is normally a function/procedure body, so control nesting is
    // one less than raw indentation depth. Labelled "estimated" in the UI.
    indentNesting = { depth: Math.max(0, maxDepth - 1), line: maxLine };
  }

  return {
    lines: lines.length, sloc, commentLines, todos, suppressions, lineLengths, indentNesting,
    tokenIds: Uint32Array.from(ids), tokenLines: Uint32Array.from(tokLines),
  };
}
