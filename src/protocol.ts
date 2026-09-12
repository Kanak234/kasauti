/* =============================================================================
 * KASAUTI — protocol.ts
 * -----------------------------------------------------------------------------
 * WHAT:  The exact messages exchanged between the extension host and the two
 *        webviews (sidebar Overview, Pyramid panel).
 * WHY:   Both sides import this file, so a renamed field is a compile error on
 *        both sides instead of a silent runtime bug.
 * FLOW:  host views/webviews.ts  <-- postMessage -->  webview/*.ts
 * ========================================================================== */

import type { UiDetail, UiFile, UiSummary } from './snapshot';

export type HostMessage =
  | { type: 'init'; files: UiFile[]; summary: UiSummary; colorBlind: boolean }
  | { type: 'files'; upsert: UiFile[]; remove: string[]; summary: UiSummary }
  | { type: 'summary'; summary: UiSummary }
  | { type: 'detail'; detail: UiDetail }
  | { type: 'focus'; key: string }
  | { type: 'palette'; colorBlind: boolean };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'open'; key: string; line?: number }
  | { type: 'detail'; key: string }
  | { type: 'command'; id: 'scan' | 'pyramid' | 'export' | 'cancel' };
