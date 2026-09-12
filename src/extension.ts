/* =============================================================================
 * KASAUTI — extension.ts  (entry point)
 * -----------------------------------------------------------------------------
 * WHAT:  VS Code calls activate() once when the extension starts, and
 *        deactivate() when it stops.
 * WHY:   Kept tiny on purpose: all real work lives in Controller, so startup
 *        cost is just constructing it (grammars load lazily; SPEC §B7).
 * FLOW:  VS Code -> activate() -> new Controller(context) -> everything else.
 * ========================================================================== */

import * as vscode from 'vscode';
import { Controller } from './controller';

let controller: Controller | undefined;

export function activate(context: vscode.ExtensionContext): void {
  controller = new Controller(context);
  context.subscriptions.push(controller);   // disposed automatically on shutdown
}

export function deactivate(): void {
  controller = undefined;                   // disposal handled via subscriptions
}
