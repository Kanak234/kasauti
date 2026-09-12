/* =============================================================================
 * KASAUTI — fixes/index.ts   (v0.2.0, feature F4)
 * -----------------------------------------------------------------------------
 * WHAT:  Quick Fixes offered on KASAUTI diagnostics, via the lightbulb.
 * WHY:   A finding you cannot act on becomes noise. These three are the only
 *        transforms that are safe to apply without understanding the code.
 * HOW:   Every edit is a WorkspaceEdit over ranges the engine already knows.
 *        Nothing is reformatted, nothing is re-indented, no AST is rewritten.
 * FLOW:  diagnostics.ts publishes a Diagnostic carrying the rule id
 *        -> this provider matches the id -> builds an edit -> VS Code applies it
 *
 * WHAT IS DELIBERATELY MISSING:
 *   "Remove unused binding" appeared in the v0.2.0 plan. The engine reports no
 *   such rule (CQ001-CQ012 contain nothing about unused bindings), so the fix
 *   was cut rather than inventing a rule to justify it.
 *   "Extract function" is not here either: it needs scope and data-flow
 *   analysis the engine does not do, and a wrong extraction changes behaviour.
 *
 * Tier 2 files get NO fixes at all. Their line and symbol positions are
 * heuristics, and an edit at a guessed position can corrupt a file.
 * ========================================================================== */

import * as vscode from 'vscode';
import { suppressionComment } from '../engine/suppress';
import { safeSplitPoint } from './split';

export { safeSplitPoint };

/** Rules that have a fix, and what the lightbulb should say. */
const TITLES: Record<string, string> = {
  CQ009: 'Remove this TODO marker',
  CQ010: 'Split this line',
};

export interface FixContext {
  /** Language key of the document, for the comment syntax. */
  languageKey(doc: vscode.TextDocument): string | undefined;
  /** True when the file was only estimated (tier 2) — no fixes there. */
  isPartial(doc: vscode.TextDocument): boolean;
}

export class KasautiFixProvider implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  constructor(private readonly ctx: FixContext) {}

  provideCodeActions(
    doc: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (this.ctx.isPartial(doc)) return [];            // never edit a guessed position
    const lang = this.ctx.languageKey(doc);
    if (!lang) return [];

    const actions: vscode.CodeAction[] = [];
    for (const d of context.diagnostics) {
      const ruleId = typeof d.code === 'object' ? String(d.code.value) : String(d.code ?? '');
      if (!/^CQ\d{3}$/.test(ruleId)) continue;          // not ours

      if (ruleId === 'CQ009') {
        const fix = removeTodoMarker(doc, d);
        if (fix) actions.push(fix);
      }
      if (ruleId === 'CQ010') {
        const fix = splitLongLine(doc, d);
        if (fix) actions.push(fix);
      }
      // Always available: silence this one finding, in place, reviewably.
      actions.push(suppressHere(doc, d, ruleId, lang));
    }
    void range;
    return actions;
  }
}

/* -----------------------------------------------------------------------------
 * Transform 1 — remove a TODO/FIXME marker word, keeping the note itself.
 * The comment stays; only the marker that triggered CQ009 goes, so no
 * information is lost and the finding clears.
 * --------------------------------------------------------------------------- */
export function removeTodoMarker(doc: vscode.TextDocument, d: vscode.Diagnostic): vscode.CodeAction | undefined {
  const line = doc.lineAt(d.range.start.line);
  const m = /\b(TODO|FIXME|HACK|XXX)\b\s*:?\s*/i.exec(line.text);
  if (!m) return undefined;
  const start = new vscode.Position(line.lineNumber, m.index);
  const end = new vscode.Position(line.lineNumber, m.index + m[0].length);
  const action = new vscode.CodeAction(TITLES.CQ009, vscode.CodeActionKind.QuickFix);
  action.edit = new vscode.WorkspaceEdit();
  action.edit.delete(doc.uri, new vscode.Range(start, end));
  action.diagnostics = [d];
  return action;
}

/* -----------------------------------------------------------------------------
 * Transform 2 — split an over-long line at a safe boundary.
 * "Safe" means: a top-level comma or operator, outside every string, comment
 * and bracket pair. If no such point exists, no fix is offered — a wrapped
 * string literal or a broken comment is worse than a long line.
 * --------------------------------------------------------------------------- */
export function splitLongLine(doc: vscode.TextDocument, d: vscode.Diagnostic): vscode.CodeAction | undefined {
  const line = doc.lineAt(d.range.start.line);
  const point = safeSplitPoint(line.text);
  if (point === undefined) return undefined;
  const indent = /^\s*/.exec(line.text)?.[0] ?? '';
  const continuation = indent + '  ';
  const head = line.text.slice(0, point).replace(/\s+$/, '');
  const tail = line.text.slice(point).replace(/^\s+/, '');
  const action = new vscode.CodeAction(TITLES.CQ010, vscode.CodeActionKind.QuickFix);
  action.edit = new vscode.WorkspaceEdit();
  action.edit.replace(doc.uri, line.range, `${head}\n${continuation}${tail}`);
  action.diagnostics = [d];
  return action;
}

/* -----------------------------------------------------------------------------
 * Transform 3 — insert a suppression comment above the finding.
 * Always offered, for every rule: the escape hatch must never be missing.
 * --------------------------------------------------------------------------- */
export function suppressHere(
  doc: vscode.TextDocument, d: vscode.Diagnostic, ruleId: string, languageKey: string,
): vscode.CodeAction {
  const line = doc.lineAt(d.range.start.line);
  const indent = /^\s*/.exec(line.text)?.[0] ?? '';
  const action = new vscode.CodeAction(`Ignore ${ruleId} on this line`, vscode.CodeActionKind.QuickFix);
  action.edit = new vscode.WorkspaceEdit();
  action.edit.insert(doc.uri, new vscode.Position(line.lineNumber, 0),
    `${indent}${suppressionComment(languageKey, ruleId)}\n`);
  action.diagnostics = [d];
  return action;
}
