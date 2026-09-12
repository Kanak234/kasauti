/* =============================================================================
 * KASAUTI — engine/types.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Every data shape that flows through the analysis pipeline.
 * WHY:   The engine (parser, metrics, rules, scoring) must NOT import `vscode`.
 *        Keeping all shared types here lets the same engine run inside a
 *        worker thread, inside unit tests, and inside the VS Code host.
 * FLOW:  worker.ts produces `FileAnalysis`  ->  store.ts keeps it  ->
 *        rules.ts turns metrics into `Finding[]`  ->  scoring.ts turns
 *        findings into `ScoreResult`  ->  views render everything.
 * ========================================================================== */

/** Analysis depth of a file. See SPEC §A7.2. */
export type Tier = 1 | 2 | 3;
//  1 = full AST analysis (tree-sitter grammar available)
//  2 = generic, language-independent analysis (no grammar)
//  3 = skipped (binary, minified, generated, too large, not source code)

/** Finding severity. Maps to colors in the UI (SPEC §B4.4). */
export type Severity = 'critical' | 'major' | 'minor' | 'info';

/** File/function grade from the technical-debt ratio (SPEC §A7.1). */
export type Grade = 'A' | 'B' | 'C' | 'D' | 'E';

/** Halstead metrics for one function (Halstead, 1977). */
export interface Halstead {
  n1: number;          // distinct operators
  n2: number;          // distinct operands
  N1: number;          // total operators
  N2: number;          // total operands
  volume: number;      // V = N * log2(n)
  difficulty: number;  // D = (n1 / 2) * (N2 / n2)
  effort: number;      // E = D * V
}

/** Everything measured about one function/method/top-level lambda. */
export interface FunctionMetrics {
  name: string;                         // best-effort readable name
  kind: 'function' | 'method' | 'lambda';
  startLine: number;                    // 0-based (VS Code convention)
  startCol: number;
  endLine: number;
  endCol: number;
  params: number;                       // formal parameter count
  cyclomatic: number;                   // McCabe CC (extended: counts && and ||)
  cognitive: number;                    // SonarSource Cognitive Complexity
  maxNesting: number;                   // deepest nested control structure
  sloc: number;                         // non-blank, non-comment lines
  halstead: Halstead;
  mi: number;                           // Maintainability Index 0..100
}

/** A class-like container (class, struct with methods, trait, module...). */
export interface ClassMetrics {
  name: string;
  startLine: number;
  startCol: number;
  endLine: number;
  methods: number;                      // functions directly owned by this class
}

/** A TODO/FIXME/HACK/XXX marker found in the code. */
export interface TodoMarker { line: number; col: number; text: string }

/**
 * Raw result of analyzing ONE file. Produced by the worker.
 * IMPORTANT: this contains only *measurements*, never threshold decisions.
 * Thresholds live in settings, so keeping them out of here means a settings
 * change never requires re-parsing (SPEC §B5).
 */
export interface FileAnalysis {
  engineVersion: string;                // cache invalidation key part
  languageKey: string;                  // e.g. 'python', 'tier2:pascal'
  tier: Tier;
  skipReason?: string;                  // set when tier === 3
  lines: number;                        // physical lines
  sloc: number;                         // non-blank, non-comment lines
  commentLines: number;
  functions: FunctionMetrics[];
  classes: ClassMetrics[];
  todos: TodoMarker[];
  /** Line lengths (characters) per physical line — used by CQ010.
   *  Typed array: far less memory than number[] across thousands of files. */
  lineLengths: Uint32Array;
  /** Tier 2 only: nesting estimated from indentation, and where it peaks. */
  indentNesting?: { depth: number; line: number };
  hasSyntaxErrors: boolean;
  /** Normalized token stream for duplication detection (SPEC §B4.1). */
  tokenIds: Uint32Array;                // FNV-1a hash per token
  tokenLines: Uint32Array;              // 0-based line of each token
  analysisMs: number;
  /** Set when a grammar existed but failed; file fell back to tier 2. */
  fallbackNote?: string;
}

/** One problem the user can act on. Created by rules.ts (and duplication). */
export interface Finding {
  ruleId: string;                       // 'CQ001'..'CQ012'
  severity: Severity;
  message: string;                      // human readable, specific
  line: number;                         // 0-based
  col: number;
  endLine: number;
  endCol: number;
  value?: number;                       // measured value (e.g. CC 14)
  threshold?: number;                   // configured limit (e.g. 10)
  debtMinutes: number;                  // remediation cost (SPEC §B4.3)
  symbol?: string;                      // function/class name if any
  relatedPath?: string;                 // CQ007: the other copy
  relatedLine?: number;
}

/** Output of scoring.ts for a file, folder, function, or the workspace. */
export interface ScoreResult {
  debtMinutes: number;
  sloc: number;
  debtRatio: number;                    // debt / (sloc * 30 min)
  score: number;                        // 0..100
  grade: Grade;
}

/** User-configurable thresholds. Defaults in rules.ts (SPEC §B4.2). */
export interface Thresholds {
  cyclomatic: number;
  cognitive: number;
  functionLength: number;
  parameters: number;
  nesting: number;
  fileLength: number;
  duplicationTokens: number;
  miWarning: number;
  miCritical: number;
  classMethods: number;
  lineLength: number;
}

/** Message sent from the host to a worker. */
export interface WorkerRequest {
  id: number;
  languageKey: string;                  // grammar key or 'tier2:<name>'
  path: string;                         // for generated-file detection only
  text: string;
  /** Host already knows this grammar is broken on this machine -> Tier 2. */
  forceGeneric?: boolean;
}

/** Message sent from a worker back to the host. */
export interface WorkerResponse {
  id: number;
  ok: boolean;
  analysis?: FileAnalysis;
  error?: string;
  /** Grammar that failed to load/parse; host stops using it (SPEC §B9). */
  brokenGrammar?: string;
}
