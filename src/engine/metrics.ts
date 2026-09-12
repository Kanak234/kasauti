/* =============================================================================
 * KASAUTI — engine/metrics.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Turns ONE parsed syntax tree into measurements: functions (with
 *        cyclomatic, cognitive, nesting, Halstead, MI, SLOC, params), classes,
 *        comment/code lines, TODO markers, and the token stream for duplication.
 * WHY:   This is the heart of the "industrial level" claim. Every formula here
 *        is a published, documented metric (SPEC §B4.1) — nothing invented.
 * FLOW:  analyzer.ts calls analyzeTier1(tree, spec, text)
 *        -> pass 1: tokenPass()      (tokens, code rows, comments, TODOs)
 *        -> pass 2: discoverUnits()  (functions/classes and their nesting)
 *        -> pass 3: per unit, complexityWalk() + halstead() + MI
 *        -> returns partial FileAnalysis back to analyzer.ts
 * ========================================================================== */

import { SyntaxNode, Role, getSpec, roleOf } from './languages';
import type { ClassMetrics, FunctionMetrics, Halstead, TodoMarker } from './types';

type Spec = NonNullable<ReturnType<typeof getSpec>>;

/** Minimal tree-cursor surface we use (fast, allocation-free traversal). */
export interface CursorLike {
  nodeType: string;
  nodeIsNamed: boolean;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  currentNode: SyntaxNode;
  gotoFirstChild(): boolean;
  gotoNextSibling(): boolean;
  gotoParent(): boolean;
}
/** Extra fields tree-sitter nodes have that the SyntaxNode interface omits. */
type NodeWithIndex = SyntaxNode & { startIndex: number; endIndex: number };

/* -----------------------------------------------------------------------------
 * Token model
 * --------------------------------------------------------------------------- */
interface Token {
  text: string;
  named: boolean;   // named leaf (identifier/literal) = operand; anonymous = operator
  start: number;    // source index, for "is this token inside unit X" checks
  row: number;
}

/** String-literal node types collapsed into ONE operand token (their inner
 *  pieces like string_content/escape_sequence are not separate operands). */
const STRING_TYPES = new Set([
  'string', 'string_literal', 'raw_string_literal', 'interpreted_string_literal', 'char_literal',
  'character_literal', 'character', 'verbatim_string_literal', 'template_string', 'encapsed_string',
  'line_string_literal', 'multi_line_string_literal', 'multiline_string', 'quoted_string',
  'heredoc_body', 'nowdoc_string', 'raw_string', 'ansi_c_string', 'translated_string',
  'system_lib_string', 'bare_string', 'hex_string_literal', 'unicode_string_literal', 'polyvar_string',
  'sigil', 'interpolated_string_expression',
]);

/** Delimiters that are NOT Halstead operators. Opening brackets are counted
 *  once (the pair is one operator); closing ones and separators are ignored. */
const NON_OPERATORS = new Set([')', ']', '}', ',', ';', '"', "'", '`', '\n', '']);

const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b[:\s-]*(.*)/;

/** FNV-1a 32-bit hash of a string -> token id for duplication detection.
 *  WHY FNV: tiny, fast, well-distributed, no dependency. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const isComment = (type: string) => type.includes('comment');

/* -----------------------------------------------------------------------------
 * PASS 1 — walk every leaf once with a cursor (fast, no recursion limit).
 * --------------------------------------------------------------------------- */
function tokenPass(cursor: CursorLike, lineCount: number) {
  const tokens: Token[] = [];
  const codeRows = new Uint8Array(lineCount);      // 1 = row has real code
  const commentRows = new Uint8Array(lineCount);   // 1 = row has a comment
  const todos: TodoMarker[] = [];

  // Iterative depth-first traversal: down, then right, then up-and-right.
  let descend = true;
  for (;;) {
    const type = cursor.nodeType;
    if (descend) {
      if (isComment(type) && cursor.nodeIsNamed) {
        // Comment: mark its rows, look for TODO markers, do NOT emit tokens.
        const s = cursor.startPosition.row, e = cursor.endPosition.row;
        for (let r = s; r <= e && r < lineCount; r++) commentRows[r] = 1;
        const text = cursor.currentNode.text;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const m = TODO_RE.exec(lines[i]);
          if (m) todos.push({ line: s + i, col: i === 0 ? cursor.startPosition.column + m.index : m.index, text: (m[1] + ' ' + m[2]).trim().slice(0, 120) });
        }
        descend = false;
        continue;
      }
      const collapse = STRING_TYPES.has(type) && cursor.nodeIsNamed;
      if (collapse || !cursor.gotoFirstChild()) {
        // Leaf (or collapsed string): emit exactly one token.
        const node = cursor.currentNode;
        const text = node.text;
        if (text.length > 0 && !(text.trim() === '' )) {
          const s = cursor.startPosition.row, e = cursor.endPosition.row;
          for (let r = s; r <= e && r < lineCount; r++) codeRows[r] = 1;
          tokens.push({ text, named: cursor.nodeIsNamed || collapse, start: cursor.startIndex, row: s });
        }
        descend = false;
        continue;
      }
      continue;                       // went down into first child
    }
    if (cursor.gotoNextSibling()) { descend = true; continue; }
    if (!cursor.gotoParent()) break;  // back at root: finished
  }

  let sloc = 0, commentOnly = 0;
  for (let r = 0; r < lineCount; r++) {
    if (codeRows[r]) sloc++;
    else if (commentRows[r]) commentOnly++;
  }
  return { tokens, codeRows, sloc, commentLines: commentOnly, todos };
}

/* -----------------------------------------------------------------------------
 * PASS 2 — find metrics units (functions, methods, top-level lambdas) and
 * classes. A lambda INSIDE a function is part of that function (it raises
 * nesting), exactly like SonarSource's cognitive-complexity spec.
 * --------------------------------------------------------------------------- */
interface Unit {
  node: NodeWithIndex;
  kind: FunctionMetrics['kind'];
  nested: Array<[number, number]>;   // source ranges of units/classes inside it
}
interface ClassRec { node: SyntaxNode; methods: number }

function discoverUnits(root: SyntaxNode, spec: Spec) {
  const units: Unit[] = [];
  const classes: ClassRec[] = [];
  const visit = (node: SyntaxNode, ctxUnit: Unit | null, ctxClass: ClassRec | null): void => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i)! as NodeWithIndex;
      const r = roleOf(spec, c);
      if (r === 'function' || (r === 'lambda' && !ctxUnit)) {
        const u: Unit = { node: c, kind: r === 'lambda' ? 'lambda' : ctxClass ? 'method' : 'function', nested: [] };
        if (ctxClass && r === 'function') ctxClass.methods++;
        if (ctxUnit) ctxUnit.nested.push([c.startIndex, c.endIndex]);
        units.push(u);
        visit(c, u, null);            // class context does not leak into bodies
      } else if (r === 'class') {
        const cls: ClassRec = { node: c, methods: 0 };
        classes.push(cls);
        if (ctxUnit) ctxUnit.nested.push([c.startIndex, c.endIndex]);
        visit(c, null, cls);          // class members start a fresh unit context
      } else {
        visit(c, ctxUnit, ctxClass);
      }
    }
  };
  visit(root, null, null);
  return { units, classes };
}

/* -----------------------------------------------------------------------------
 * PASS 3a — cyclomatic + cognitive complexity + max nesting for one unit.
 *
 * Cognitive Complexity (SonarSource spec, G. Ann Campbell 2017):
 *   +1            for if, else-if, else, switch, loops, catch, ternary, goto,
 *                 and each *sequence* of like logical operators
 *   +nesting      extra for if/switch/loop/catch/ternary based on depth
 *   nesting++     inside if/else/switch/loop/catch/ternary and nested lambdas
 *   else-if/else  get +1 but no nesting penalty
 * Cyclomatic (McCabe 1976, extended): 1 + decisions + logical operators.
 * --------------------------------------------------------------------------- */
const LOGICAL_WORDS = new Set(['&&', '||', 'and', 'or']);
const LOGICAL_NAMED = new Set(['logical_and_operator', 'logical_or_operator']);
const DEFAULT_CASE_RE = /^(default\b|else\b|case\s+_\s*(=>|:|if\b)|_\s*(=>|->)|\|\s*_\s*(=>|->)|true\s*->)/;

/** Returns 'and' / 'or' if `node` is a logical binary expression, else null.
 *  Also returns how many operator tokens are its direct children. */
function logicalInfo(node: SyntaxNode, spec: Spec): { op: 'and' | 'or'; count: number } | null {
  if (!spec.logical.test(node.type)) return null;
  // Dart wraps the operator token itself in a named node (logical_and_operator);
  // that wrapper is not an expression and must not be counted a second time.
  if (LOGICAL_NAMED.has(node.type)) return null;
  let op: 'and' | 'or' | null = null, count = 0;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)!;
    let t: string | null = null;
    if (!c.isNamed && LOGICAL_WORDS.has(c.type)) t = c.type;
    else if (c.isNamed && LOGICAL_NAMED.has(c.type)) t = c.text;
    else if (c.isNamed && c.childCount === 0 && (c.text === '&&' || c.text === '||')) t = c.text;
    if (t) { count++; op = t === '&&' || t === 'and' ? 'and' : 'or'; }
  }
  return op ? { op, count } : null;
}

function isDefaultCase(node: SyntaxNode): boolean {
  const pat = node.childForFieldName('pattern');
  if (pat && pat.text.trim() === '_') return true;             // Rust `_ => ...`
  return DEFAULT_CASE_RE.test(node.text.trimStart());
}

/** Step through wrapper nodes (e.g. Kotlin control_structure_body). */
function unwrap(node: SyntaxNode | null, spec: Spec): SyntaxNode | null {
  let n = node;
  while (n && spec.transparent?.includes(n.type) && n.namedChildCount === 1) n = n.namedChild(0);
  return n;
}

function complexityWalk(unit: SyntaxNode, spec: Spec) {
  let cc = 1, cog = 0, maxNest = 0;
  const elseIfIds = new Set<number>();   // `if` nodes known to be an else-if

  // For grammars where `else` is a bare keyword directly under the `if`
  // (Java, C#, Go, Kotlin, Swift, Scala...): decide else-if vs plain else.
  const scanElseKeywords = (ifNode: SyntaxNode) => {
    // i starts at 1: an `else` that is the node's OWN first token (ReScript's
    // `else_if_clause` = "else" "if" ...) is its header, not an else-branch.
    for (let i = 1; i < ifNode.childCount; i++) {
      const c = ifNode.child(i)!;
      if (c.type !== 'else' || c.childCount !== 0) continue;
      let next = c.nextSibling;
      while (next && isComment(next.type)) next = next.nextSibling;
      const target = unwrap(next, spec);
      if (target && roleOf(spec, target) === 'if') elseIfIds.add(target.id);
      else cog += 1;                    // plain `else` branch
    }
  };

  // Is this else-node attached to an if/elseif (and not a loop/try/case else)?
  const elseBelongsToIf = (elseNode: SyntaxNode): boolean => {
    let p = elseNode.parent;
    while (p && (spec.transparent?.includes(p.type) || p.type === 'do_block')) p = p.parent;
    if (!p) return false;
    const r = roleOf(spec, p);
    return r === 'if' || r === 'elseif';
  };

  const visit = (node: SyntaxNode, level: number, depth: number): void => {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i)!;
      if (!c.isNamed || isComment(c.type)) continue;
      const r: Role | null = roleOf(spec, c);
      switch (r) {
        case 'function':
        case 'class':
          continue;                     // measured as its own unit
        case 'lambda':
          visit(c, level + 1, depth);   // nested lambda: nesting++, no increment
          continue;
        case 'if':
          cc++;
          if (elseIfIds.has(c.id)) {
            cog += 1;                   // else-if: flat +1, same level as its if
            scanElseKeywords(c);
            visit(c, level, depth);
          } else {
            cog += 1 + level;
            maxNest = Math.max(maxNest, depth + 1);
            scanElseKeywords(c);
            visit(c, level + 1, depth + 1);
          }
          continue;
        case 'elseif':
          cc++; cog += 1;
          scanElseKeywords(c);
          visit(c, level, depth);
          continue;
        case 'else': {
          // `else if` written as else-node wrapping an if -> the inner if is
          // the else-if (counted there); otherwise a plain else: +1.
          let inner: SyntaxNode | null = null, named = 0;
          for (let j = 0; j < c.namedChildCount; j++) {
            const k = c.namedChild(j)!;
            if (isComment(k.type)) continue;
            named++; inner = k;
          }
          const u = unwrap(inner, spec);
          if (named === 1 && u && roleOf(spec, u) === 'if') elseIfIds.add(u.id);
          else if (elseBelongsToIf(c)) cog += 1;
          visit(c, level, depth);
          continue;
        }
        case 'loop':
        case 'catch':
          cc++; cog += 1 + level;
          maxNest = Math.max(maxNest, depth + 1);
          visit(c, level + 1, depth + 1);
          continue;
        case 'switch':
          cog += 1 + level;             // CC comes from its cases instead
          maxNest = Math.max(maxNest, depth + 1);
          visit(c, level + 1, depth + 1);
          continue;
        case 'case':
          if (!isDefaultCase(c)) cc++;
          visit(c, level, depth);
          continue;
        case 'ternary':
          cc++; cog += 1 + level;
          visit(c, level + 1, depth);
          continue;
        case 'jump':
          cog += 1;
          visit(c, level, depth);
          continue;
        default: {
          const li = logicalInfo(c, spec);
          if (li) {
            cc += li.count;
            // A new *sequence* starts unless the parent is the same operator.
            const pi = c.parent ? logicalInfo(c.parent, spec) : null;
            if (!pi || pi.op !== li.op) cog += 1;
          }
          visit(c, level, depth);
        }
      }
    }
  };
  // Start from the unit's own children at nesting 0.
  visit(unit, 0, 0);
  return { cyclomatic: cc, cognitive: cog, maxNesting: maxNest };
}

/* -----------------------------------------------------------------------------
 * PASS 3b — Halstead metrics from the tokens inside a unit (minus nested units).
 * --------------------------------------------------------------------------- */
function halstead(tokens: Token[], from: number, to: number, nested: Array<[number, number]>): Halstead {
  const ops = new Map<string, number>(), opnds = new Map<string, number>();
  let N1 = 0, N2 = 0;
  // Binary search the first token inside the unit (tokens are in source order).
  let lo = 0, hi = tokens.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (tokens[mid].start < from) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < tokens.length && tokens[i].start < to; i++) {
    const t = tokens[i];
    if (nested.some(([s, e]) => t.start >= s && t.start < e)) continue;
    if (t.named) { N2++; opnds.set(t.text, (opnds.get(t.text) ?? 0) + 1); }
    else if (!NON_OPERATORS.has(t.text)) { N1++; ops.set(t.text, (ops.get(t.text) ?? 0) + 1); }
  }
  const n1 = ops.size, n2 = opnds.size, n = n1 + n2, N = N1 + N2;
  const volume = n > 1 ? N * Math.log2(n) : 0;
  const difficulty = n2 > 0 ? (n1 / 2) * (N2 / n2) : 0;
  return { n1, n2, N1, N2, volume: round2(volume), difficulty: round2(difficulty), effort: round2(difficulty * volume) };
}

/** Maintainability Index, Visual Studio's 0..100 normalization of
 *  Oman & Hagemeister: (171 - 5.2 ln V - 0.23 CC - 16.2 ln LOC) * 100 / 171 */
export function maintainabilityIndex(volume: number, cc: number, sloc: number): number {
  if (sloc <= 0 || volume <= 0) return 100;
  const raw = (171 - 5.2 * Math.log(volume) - 0.23 * cc - 16.2 * Math.log(sloc)) * 100 / 171;
  return round2(Math.max(0, Math.min(100, raw)));
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/* -----------------------------------------------------------------------------
 * Names and parameters (generic fallbacks; languages may override).
 * --------------------------------------------------------------------------- */
const NAME_LEAF_RE = /^(identifier|simple_identifier|name|word|constant|field_identifier|property_identifier|type_identifier|qualified_identifier|operator_name|destructor_name|scoped_identifier)$/;
const PARAM_LIST_RE = /^(parameters|parameter_list|formal_parameters|formal_parameter_list|method_parameters|function_value_parameters|lambda_parameters|closure_parameters|block_parameters|parameter_clause|function_parameters)$/;
const PARAM_ITEM_RE = /^(parameter|formal_parameter|simple_parameter|lambda_parameter|class_parameter)$/;
const clean = (s: string) => s.split('\n')[0].trim().slice(0, 60);

function nameOf(node: SyntaxNode, spec: Spec): string {
  const custom = spec.nameOf?.(node);
  if (custom) return clean(custom);
  const n = node.childForFieldName('name');
  if (n) return clean(n.text);
  // C/C++/ObjC: name lives inside declarator -> function_declarator -> declarator
  let d = node.childForFieldName('declarator');
  for (let hops = 0; d && hops < 5; hops++) {
    if (NAME_LEAF_RE.test(d.type)) return clean(d.text);
    d = d.childForFieldName('declarator') ?? (d.type.includes('declarator') ? d.namedChild(0) : null);
  }
  const body = node.childForFieldName('body');
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)!;
    if (c === body || c.id === body?.id) break;
    if (NAME_LEAF_RE.test(c.type)) return clean(c.text);
  }
  // Anonymous function: borrow the name of what it is assigned to.
  let p = node.parent;
  for (let hops = 0; p && hops < 2; hops++, p = p.parent) {
    for (const f of ['name', 'left', 'key', 'pattern', 'declarator']) {
      const k = p.childForFieldName(f);
      if (k && k.id !== node.id) return clean(k.text);
    }
  }
  return '<anonymous>';
}

function paramsOf(node: SyntaxNode, spec: Spec): number {
  const custom = spec.paramsOf?.(node);
  if (custom !== undefined) return custom;
  if (node.childForFieldName('parameter')) return 1;          // JS `x => x`
  const body = node.childForFieldName('body');
  // Breadth-first search for a parameter list, never entering the body.
  const queue: Array<[SyntaxNode, number]> = [[node, 0]];
  while (queue.length) {
    const [n, depth] = queue.shift()!;
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i)!;
      if (body && c.id === body.id) continue;
      if (PARAM_LIST_RE.test(c.type)) {
        let count = 0;
        for (let j = 0; j < c.namedChildCount; j++) {
          if (!/comment|attribute|annotation|modifier/.test(c.namedChild(j)!.type)) count++;
        }
        return count;
      }
      if (depth < 3 && !roleOf(spec, c)) queue.push([c, depth + 1]);
    }
  }
  // Swift / Solidity: parameters are direct children without a list wrapper.
  let direct = 0;
  for (let i = 0; i < node.namedChildCount; i++) if (PARAM_ITEM_RE.test(node.namedChild(i)!.type)) direct++;
  return direct;
}

/* -----------------------------------------------------------------------------
 * PUBLIC ENTRY — called by analyzer.ts for every Tier 1 file.
 * --------------------------------------------------------------------------- */
export function analyzeTier1(root: SyntaxNode, cursor: CursorLike, specKey: string, lineCount: number) {
  const spec = getSpec(specKey);
  if (!spec) throw new Error(`No language spec for ${specKey}`);

  const tp = tokenPass(cursor, lineCount);
  const { units, classes } = discoverUnits(root, spec);

  const functions: FunctionMetrics[] = units.map((u) => {
    const n = u.node;
    const cx = complexityWalk(n, spec);
    const h = halstead(tp.tokens, n.startIndex, n.endIndex, u.nested);
    let sloc = 0;
    for (let r = n.startPosition.row; r <= n.endPosition.row && r < lineCount; r++) if (tp.codeRows[r]) sloc++;
    return {
      name: nameOf(n, spec),
      kind: u.kind,
      startLine: n.startPosition.row, startCol: n.startPosition.column,
      endLine: n.endPosition.row, endCol: n.endPosition.column,
      params: paramsOf(n, spec),
      ...cx,
      sloc,
      halstead: h,
      mi: maintainabilityIndex(h.volume, cx.cyclomatic, sloc),
    };
  });

  const classMetrics: ClassMetrics[] = classes.map((c) => ({
    name: nameOf(c.node, spec),
    startLine: c.node.startPosition.row, startCol: c.node.startPosition.column,
    endLine: c.node.endPosition.row,
    methods: c.methods,
  }));

  // Token stream for duplication: ids + lines as compact typed arrays.
  const tokenIds = new Uint32Array(tp.tokens.length);
  const tokenLines = new Uint32Array(tp.tokens.length);
  tp.tokens.forEach((t, i) => { tokenIds[i] = fnv1a(t.text); tokenLines[i] = t.row; });

  return {
    functions, classes: classMetrics,
    sloc: tp.sloc, commentLines: tp.commentLines, todos: tp.todos,
    tokenIds, tokenLines,
  };
}
