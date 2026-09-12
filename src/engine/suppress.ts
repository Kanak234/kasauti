/* =============================================================================
 * KASAUTI — engine/suppress.ts   (v0.2.0, feature F4 R4.5)
 * -----------------------------------------------------------------------------
 * WHAT:  Recognises `kasauti-disable-*` directives written in code comments,
 *        and filters findings the user has chosen to silence.
 * WHY:   A quality tool without an escape hatch gets disabled entirely. One
 *        deliberate, reviewable comment beats turning a rule off workspace-wide.
 * HOW:   Language-independent BY DESIGN. The directive is found in the *text of
 *        a comment node*, so it works on all 24 Tier 1 grammars without any
 *        per-language work (metrics.ts already identifies comment nodes), and
 *        on Tier 2 files via their comment prefixes. That removes the risk the
 *        update spec flagged: "a grammar that reports comments oddly".
 * FLOW:  metrics.ts / generic.ts collect Suppression[] while scanning comments
 *        -> analyzer puts them in FileAnalysis -> store applies them after
 *        rules.evaluate(), before findings reach any view.
 *
 * Accepted forms (case-insensitive, anywhere inside a comment):
 *     kasauti-disable-next-line CQ001
 *     kasauti-disable-line CQ001, CQ010
 *     kasauti-disable-file
 *     kasauti-disable-next-line            (no ids -> every rule on that line)
 * ========================================================================== */

import type { Finding } from './types';

export type SuppressScope = 'line' | 'nextLine' | 'file';

export interface Suppression {
  scope: SuppressScope;
  /** 0-based line the directive sits on. Meaningless for scope 'file'. */
  line: number;
  /** Rule ids to silence; empty array means "all rules". */
  rules: string[];
}

/** One directive per comment line; `next-line` beats `line` if both appear. */
const DIRECTIVE = /kasauti-disable(-next-line|-line|-file)?\b[:\s]*([A-Za-z0-9,\s]*)/i;

/**
 * Look for a directive in one comment's text.
 * @param text  the comment's full text (may span several lines)
 * @param startLine 0-based line where the comment starts
 */
export function parseDirectives(text: string, startLine: number): Suppression[] {
  if (!/kasauti-disable/i.test(text)) return [];      // fast path: almost always
  const out: Suppression[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = DIRECTIVE.exec(lines[i]);
    if (!m) continue;
    const scope: SuppressScope = m[1] === '-file' ? 'file' : m[1] === '-next-line' ? 'nextLine' : 'line';
    // Rule ids: CQ001 style only. Anything else in the tail is prose and ignored.
    const rules = (m[2] ?? '').toUpperCase().match(/CQ\d{3}/g) ?? [];
    out.push({ scope, line: startLine + i, rules });
  }
  return out;
}

/**
 * Remove findings the user silenced.
 * Pure function: same inputs -> same outputs, so it cannot break determinism.
 */
export function applySuppressions(findings: Finding[], suppressions: Suppression[]): Finding[] {
  if (!suppressions.length) return findings;

  const fileWide: Set<string> | 'all' = (() => {
    const ids = new Set<string>();
    for (const s of suppressions) {
      if (s.scope !== 'file') continue;
      if (!s.rules.length) return 'all';
      s.rules.forEach((r) => ids.add(r));
    }
    return ids;
  })();
  if (fileWide === 'all') return [];

  // line number -> rules silenced on it ('all' = every rule)
  const perLine = new Map<number, Set<string> | 'all'>();
  const add = (line: number, rules: string[]) => {
    const existing = perLine.get(line);
    if (existing === 'all') return;
    if (!rules.length) { perLine.set(line, 'all'); return; }
    const set = existing ?? new Set<string>();
    rules.forEach((r) => set.add(r));
    perLine.set(line, set);
  };
  for (const s of suppressions) {
    if (s.scope === 'line') add(s.line, s.rules);
    else if (s.scope === 'nextLine') add(s.line + 1, s.rules);
  }

  return findings.filter((f) => {
    if (fileWide.has(f.ruleId)) return false;
    // A finding is silenced if its own line is covered, or — for findings
    // reported on a symbol that spans lines — its first line is covered.
    const hit = perLine.get(f.line);
    if (!hit) return true;
    return hit !== 'all' && !hit.has(f.ruleId);
  });
}

/** Comment syntax used when the Quick Fix writes a suppression comment. */
export interface CommentSyntax { line?: string; blockOpen?: string; blockClose?: string }

/** Per-language comment syntax, keyed by the engine's language key.
 *  Only languages that differ from `//` need an entry. */
const COMMENTS: Record<string, CommentSyntax> = {
  python: { line: '#' }, bash: { line: '#' }, ruby: { line: '#' }, elixir: { line: '#' },
  lua: { line: '--' }, sql: { line: '--' }, ocaml: { blockOpen: '(*', blockClose: '*)' },
  rescript: { line: '//' }, zig: { line: '//' }, solidity: { line: '//' },
};

export function commentSyntaxFor(languageKey: string): CommentSyntax {
  const key = languageKey.replace(/^tier2:|^notebook:/, '');
  return COMMENTS[key] ?? { line: '//' };
}

/** Build the comment text a Quick Fix inserts. */
export function suppressionComment(languageKey: string, ruleId: string): string {
  const c = commentSyntaxFor(languageKey);
  const body = `kasauti-disable-next-line ${ruleId}`;
  return c.line ? `${c.line} ${body}` : `${c.blockOpen} ${body} ${c.blockClose}`;
}
