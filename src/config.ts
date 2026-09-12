/* =============================================================================
 * KASAUTI — config.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Reads every `kasauti.*` setting into one typed object.
 * WHY:   Settings are read in many places (store, scanner, views). One reader
 *        means one set of defaults, which must match package.json exactly.
 * FLOW:  controller.ts calls readConfig() at startup and on every
 *        onDidChangeConfiguration event, then pushes values to the store/views.
 * ========================================================================== */

import * as vscode from 'vscode';
import { DEFAULT_THRESHOLDS } from './engine/rules';
import type { Thresholds } from './engine/types';

export interface KasautiConfig {
  thresholds: Thresholds;
  liveAnalysis: boolean;          // re-analyze while typing (Live Preview style)
  liveDelayMs: number;            // pause after the last keystroke
  includeTier2InScore: boolean;
  diagnosticsScope: 'openFiles' | 'workspace' | 'off';
  codeLens: boolean;
  exclude: string[];              // extra glob patterns
  maxFileSizeKB: number;
  extraTier2Extensions: string[];
  colorBlindPalette: boolean;
  largeWorkspaceWarning: number;  // file count that triggers a warning
}

export function readConfig(): KasautiConfig {
  const c = vscode.workspace.getConfiguration('kasauti');
  const t = DEFAULT_THRESHOLDS;
  const num = (k: string, d: number) => {
    const v = c.get<number>(k, d);
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    thresholds: {
      cyclomatic: num('thresholds.cyclomatic', t.cyclomatic),
      cognitive: num('thresholds.cognitive', t.cognitive),
      functionLength: num('thresholds.functionLength', t.functionLength),
      parameters: num('thresholds.parameters', t.parameters),
      nesting: num('thresholds.nesting', t.nesting),
      fileLength: num('thresholds.fileLength', t.fileLength),
      duplicationTokens: Math.max(20, num('thresholds.duplicationTokens', t.duplicationTokens)),
      miWarning: num('thresholds.maintainabilityWarning', t.miWarning),
      miCritical: num('thresholds.maintainabilityCritical', t.miCritical),
      classMethods: num('thresholds.classMethods', t.classMethods),
      lineLength: num('thresholds.lineLength', t.lineLength),
    },
    liveAnalysis: c.get('liveAnalysis', true),
    liveDelayMs: Math.min(5000, Math.max(50, c.get('liveDelayMs', 300))),
    includeTier2InScore: c.get('includePartialAnalysisInScore', true),
    diagnosticsScope: c.get('diagnostics.scope', 'openFiles'),
    codeLens: c.get('codeLens.enabled', true),
    exclude: c.get<string[]>('exclude', []),
    maxFileSizeKB: num('maxFileSizeKB', 1024),
    extraTier2Extensions: c.get<string[]>('additionalPartialAnalysisExtensions', []),
    colorBlindPalette: c.get('colorBlindPalette', false),
    largeWorkspaceWarning: num('largeWorkspaceWarning', 50000),
  };
}
