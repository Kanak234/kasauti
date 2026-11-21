/* =============================================================================
 * KASAUTI — audit/plain.ts   (v2.2 — "say it simply")
 * -----------------------------------------------------------------------------
 * WHAT:  Five plain-language problem groups that EVERY finding maps to, with a
 *        colour and a one-sentence explanation a non-expert understands:
 *          Security risk · Slow code · AI mistakes · Can be simpler · Hard to maintain
 * WHY:   Kanak's feedback on 2.1: users could see "AI-risk" rings but not WHAT
 *        the risk was. Rule ids (KP203) and words like "cognitive complexity"
 *        mean nothing to most students. Every view now speaks in these five
 *        groups first and shows the technical detail only on request.
 *        No vscode/DOM import: used by the host (snapshot.ts) AND the webviews.
 * FLOW:  snapshot.ts toUiFile() -> UiFile.issues -> Code Map tooltip / panel /
 *        detail drawer / Overview sidebar.
 * ========================================================================== */

export type PlainCat = 'security' | 'slow' | 'ai' | 'simpler' | 'quality';

export const PLAIN: Record<PlainCat, { label: string; color: string; explain: string }> = {
  security: { label: 'Security risk', color: '#ff4d5e',
    explain: 'Someone could misuse this code — run their own commands, read your database, or steal a key written in the code.' },
  slow: { label: 'Slow code', color: '#ff9f43',
    explain: 'Works on small data, but gets much slower as the data grows (for example a loop inside a loop).' },
  ai: { label: 'AI mistakes', color: '#f4d03f',
    explain: 'Mistakes AI-written code often has: packages that may not exist, errors that are silently ignored, unfinished placeholder code.' },
  simpler: { label: 'Can be simpler', color: '#4fc3f7',
    explain: 'The code works, but the same thing can be written shorter and clearer.' },
  quality: { label: 'Hard to maintain', color: '#9aa3b8',
    explain: 'Too long, too deeply nested, too complex or copy-pasted — hard to change without breaking something.' },
};

/** Order used everywhere: most dangerous first. */
export const PLAIN_ORDER: PlainCat[] = ['security', 'ai', 'slow', 'simpler', 'quality'];

/** KP2xx security · KP3xx AI mistakes · KP1xx slow · KP4xx simpler · CQxxx maintainability. */
export function plainCat(ruleId: string): PlainCat {
  if (ruleId.startsWith('KP2')) return 'security';
  if (ruleId.startsWith('KP3')) return 'ai';
  if (ruleId.startsWith('KP1')) return 'slow';
  if (ruleId.startsWith('KP4')) return 'simpler';
  return 'quality';
}
