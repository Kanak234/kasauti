/* =============================================================================
 * KASAUTI — audit/astAudit.ts   (v2.0 "Parakh")
 * -----------------------------------------------------------------------------
 * WHAT:  The deterministic 360° auditor. Walks the tree-sitter syntax tree the
 *        worker already built and reports KP1xx (performance), KP2xx
 *        (security), KP3xx (AI-risk) and KP4xx (simplification) findings for
 *        Python, JavaScript, TypeScript/TSX and Java.
 * WHY:   - Runs on the SAME parse as the quality metrics, so it costs one extra
 *          tree walk, not a second parser (keeps live-as-you-type fast).
 *        - No AI here, on purpose (SPEC OD-11): this file is the judge that
 *          AI-proposed fixes are checked against. A judge must be reproducible.
 *        - Every rule is a code SHAPE, not a guess about types. Where a shape
 *          can be innocent (e.g. `.includes` on a string), the severity is
 *          lowered and the message says so, instead of crying wolf.
 * FLOW:  engine/analyzer.ts (Tier 1) -> auditTree(root, grammarKey, source)
 *        -> Finding[] stored on FileAnalysis.audit -> engine/rules.ts evaluate()
 *        appends them -> store -> diagnostics / pyramid / SARIF / CLI / MCP.
 * ========================================================================== */

import type { SyntaxNode } from '../engine/languages';
import type { Finding, Severity } from '../engine/types';

/** The languages this auditor understands. Others get only the text checks. */
type Lang = 'python' | 'js' | 'java';

/** Map a grammar key to an audit dialect. JS covers TS and TSX: the node
 *  types this file looks at are identical in all three grammars. */
export function auditLang(grammarKey: string): Lang | undefined {
  if (grammarKey === 'python') return 'python';
  if (grammarKey === 'javascript' || grammarKey === 'typescript' || grammarKey === 'tsx') return 'js';
  if (grammarKey === 'java') return 'java';
  return undefined;
}

/* ---------------------------------------------------------------------------
 * Per-language vocabulary: which tree-sitter node types mean what.
 * WHY a table: the walker below is written ONCE; adding a language later means
 * adding one entry here plus its call shapes, not a new walker.
 * ------------------------------------------------------------------------- */
const FUNCS: Record<Lang, Set<string>> = {
  python: new Set(['function_definition']),
  js: new Set(['function_declaration', 'generator_function_declaration', 'method_definition', 'function_expression', 'arrow_function', 'function']),
  java: new Set(['method_declaration', 'constructor_declaration']),
};
const LOOPS: Record<Lang, Set<string>> = {
  python: new Set(['for_statement', 'while_statement']),
  js: new Set(['for_statement', 'for_in_statement', 'while_statement', 'do_statement']),
  java: new Set(['for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement']),
};
/** Python comprehensions are loops too: each `for` clause adds one level. */
const COMPREHENSIONS = new Set(['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']);
const BLOCKS: Record<Lang, Set<string>> = {
  python: new Set(['block']),
  js: new Set(['statement_block']),
  java: new Set(['block']),
};
const JUMPS = new Set(['return_statement', 'raise_statement', 'throw_statement', 'break_statement', 'continue_statement']);
const COMMENTS = new Set(['comment', 'line_comment', 'block_comment']);

/** Collection methods that scan or shift every element (KP103), per language.
 *  The value is the cheaper alternative shown in the message. */
const LINEAR_METHODS: Record<Lang, Record<string, string>> = {
  python: { index: 'a dict from value to index', count: 'collections.Counter built once', remove: 'a set, or a filtered copy built in one pass' },
  js: { indexOf: 'a Set or Map built once', lastIndexOf: 'a Map built once', includes: 'a Set built once', find: 'a Map keyed by the field you search', findIndex: 'a Map keyed by the field you search', splice: 'a filtered copy built in one pass', shift: 'an index pointer or a real queue', unshift: 'push + reverse once at the end' },
  java: { contains: 'a HashSet built once', indexOf: 'a HashMap from value to index', lastIndexOf: 'a HashMap from value to index' },
};
const SORT_METHODS: Record<Lang, Set<string>> = {
  python: new Set(['sort', 'sorted']),
  js: new Set(['sort', 'toSorted']),
  java: new Set(['sort']),
};

/** Comment text that AI assistants leave as placeholders (KP305). */
const PLACEHOLDER_COMMENT = /(your (code|logic|implementation) here|implement (this|me|later|the rest)|rest of (the )?(code|implementation|logic)|\.\.\.\s*(existing|rest|remaining|other) (code|logic)|add (your )?(own )?logic here|placeholder (code|implementation))/i;

/** SQL-looking text, so KP203 does not fire on every dynamic string. */
const SQL_WORDS = /\b(select\s.+\sfrom|insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+table|drop\s+table|alter\s+table|where\s+\w+\s*=)/is;

/* ---------------------------------------------------------------------------
 * Small tree helpers. tree-sitter's API is verbose; these keep rules readable.
 * ------------------------------------------------------------------------- */
function named(n: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (c) out.push(c); }
  return out;
}
/** Named children that are real code (comments removed). */
function stmts(n: SyntaxNode): SyntaxNode[] { return named(n).filter((c) => !COMMENTS.has(c.type)); }
function all(n: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < n.childCount; i++) { const c = n.child(i); if (c) out.push(c); }
  return out;
}
/** If a node is a block (or else-clause) holding exactly ONE statement, return
 *  that statement — used to recognise `if x: return True` shapes in any language. */
function single(n: SyntaxNode | null): SyntaxNode | null {
  if (!n) return null;
  if (n.type === 'else_clause') return single(n.childForFieldName('body') ?? stmts(n)[0] ?? null);
  if (n.type === 'block' || n.type === 'statement_block') {
    const s = stmts(n);
    return s.length === 1 ? single(s[0]) : null;
  }
  return n;
}
/** Is this a boolean literal node? Returns true/false, or undefined if not. */
function boolLiteral(n: SyntaxNode | null | undefined): boolean | undefined {
  if (!n) return undefined;
  if (n.type === 'true') return true;
  if (n.type === 'false') return false;
  return undefined;
}
/** The value a `return X` statement returns (or null for bare return). */
function returned(n: SyntaxNode | null): SyntaxNode | null {
  if (!n || n.type !== 'return_statement') return null;
  return stmts(n)[0] ?? null;
}
/** A string with no interpolation: safe to pass to a shell/SQL call. */
function isLiteralString(n: SyntaxNode | null | undefined): boolean {
  if (!n) return false;
  if (n.type === 'string') return !all(n).some((c) => c.type === 'interpolation');   // python f"{x}" has interpolation
  if (n.type === 'string_literal') return true;                                       // java
  if (n.type === 'template_string') return !all(n).some((c) => c.type === 'template_substitution');
  if (n.type === 'concatenated_string') return named(n).every(isLiteralString);       // python "a" "b"
  return false;
}
/** A string built from variables: f-string, "…" + x, "…" % x, "…".format(x), `…${x}`. */
function isDynamicString(n: SyntaxNode | null | undefined): boolean {
  if (!n) return false;
  if (n.type === 'string') return all(n).some((c) => c.type === 'interpolation');
  if (n.type === 'template_string') return all(n).some((c) => c.type === 'template_substitution');
  if (n.type === 'binary_operator' || n.type === 'binary_expression') {
    // "SELECT " + x   or   "SELECT %s" % x   — at least one side is string-ish.
    const op = n.childForFieldName('operator')?.text;
    if (op !== '+' && op !== '%') return false;
    return named(n).some((c) => isLiteralString(c) || isDynamicString(c));
  }
  if (n.type === 'call') {   // "…".format(x)
    const fn = n.childForFieldName('function');
    return fn?.type === 'attribute' && fn.childForFieldName('attribute')?.text === 'format' && isLiteralString(fn.childForFieldName('object'));
  }
  return false;
}

/** Read a call node in any of the three languages as { object, method, args }.
 *  `os.system(x)` -> { object: 'os', method: 'system', full: 'os.system' }. */
interface CallInfo { node: SyntaxNode; full: string; object: string; method: string; args: SyntaxNode[]; argList: SyntaxNode | null }
function callInfo(n: SyntaxNode, lang: Lang): CallInfo | undefined {
  if (lang === 'python' && n.type === 'call') {
    const fn = n.childForFieldName('function');
    const argList = n.childForFieldName('arguments');
    if (!fn) return undefined;
    const method = fn.type === 'attribute' ? fn.childForFieldName('attribute')?.text ?? '' : fn.text;
    const object = fn.type === 'attribute' ? fn.childForFieldName('object')?.text ?? '' : '';
    return { node: n, full: fn.text, object, method, args: argList ? stmts(argList) : [], argList };
  }
  if (lang === 'js' && n.type === 'call_expression') {
    const fn = n.childForFieldName('function');
    const argList = n.childForFieldName('arguments');
    if (!fn) return undefined;
    const method = fn.type === 'member_expression' ? fn.childForFieldName('property')?.text ?? '' : fn.text;
    const object = fn.type === 'member_expression' ? fn.childForFieldName('object')?.text ?? '' : '';
    return { node: n, full: fn.text, object, method, args: argList ? stmts(argList) : [], argList };
  }
  if (lang === 'java' && n.type === 'method_invocation') {
    const name = n.childForFieldName('name')?.text ?? '';
    const obj = n.childForFieldName('object')?.text ?? '';
    const argList = n.childForFieldName('arguments');
    return { node: n, full: obj ? `${obj}.${name}` : name, object: obj, method: name, args: argList ? stmts(argList) : [], argList };
  }
  return undefined;
}

/** Best readable name of a function node (arrow functions take the variable name). */
function functionName(n: SyntaxNode): string {
  const own = n.childForFieldName('name');
  if (own) return own.text;
  const p = n.parent;
  if (p?.type === 'variable_declarator') return p.childForFieldName('name')?.text ?? '<anonymous>';
  if (p?.type === 'pair') return p.childForFieldName('key')?.text ?? '<anonymous>';
  if (p?.type === 'assignment_expression') return p.childForFieldName('left')?.text ?? '<anonymous>';
  return '<anonymous>';
}

/* ---------------------------------------------------------------------------
 * Walk state: one frame per function, so loop depth and self-calls are
 * counted per function (a loop in an outer function does not make the inner
 * function O(n²)). The bottom frame represents module/script level.
 * ------------------------------------------------------------------------- */
interface Frame {
  name: string;
  node: SyntaxNode | null;          // null = module level
  loopDepth: number;                // current nesting of input-sized loops
  maxLoop: number;                  // deepest nesting seen in this function
  deepestOuter: SyntaxNode | null;  // outermost loop of the deepest nest (module-level report position)
  outerLoop: SyntaxNode | null;     // outermost loop we are currently inside
  selfCalls: number;                // call sites that call this same function
  memo: boolean;                    // decorated with a cache, or mentions memo/cache
}

/** Superscript digits for O(n²) style messages. */
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
export const power = (k: number) => (k <= 1 ? 'n' : 'n' + String(k).split('').map((d) => SUP[+d]).join(''));

/**
 * Audit one parsed file.
 * @param root       tree root (already parsed by the worker)
 * @param grammarKey 'python' | 'javascript' | 'typescript' | 'tsx' | 'java' (others return [])
 * @param filePath   used only to recognise .pyi stub files
 */
export function auditTree(root: SyntaxNode, grammarKey: string, filePath = ''): Finding[] {
  const maybe = auditLang(grammarKey);
  if (!maybe) return [];
  const lang: Lang = maybe;               // narrowed once, visible to the hoisted rule functions below
  const out: Finding[] = [];
  const isStubFile = filePath.endsWith('.pyi');

  /** Push a finding positioned on a node. */
  const report = (n: SyntaxNode, ruleId: string, severity: Severity, debtMinutes: number, message: string, symbol?: string) => {
    out.push({ ruleId, severity, message, debtMinutes, symbol,
      line: n.startPosition.row, col: n.startPosition.column,
      // Keep squiggles to the first line: a whole function underlined is unreadable.
      endLine: n.startPosition.row,
      endCol: n.startPosition.row === n.endPosition.row ? n.endPosition.column : n.startPosition.column + Math.min(80, n.text.split('\n')[0].length) });
  };

  /* ---- Pass 1: cheap type facts the rules need (names bound to lists / strings).
   *      WHY a pre-pass: `seen = []` may be declared before or after the loop
   *      textually; collecting first keeps the main walk single-pass. */
  const listNames = new Set<string>();      // python: x = [] / list(...) / [comp] ; java: List<…> x
  const stringNames = new Set<string>();    // python x = "" ; java String x
  const collect = (n: SyntaxNode, depth: number) => {
    if (depth > 400) return;                // pathological nesting guard
    if (lang === 'python' && n.type === 'assignment') {
      const left = n.childForFieldName('left'), right = n.childForFieldName('right');
      if (left?.type === 'identifier' && right) {
        if (right.type === 'list' || right.type === 'list_comprehension' || (right.type === 'call' && right.childForFieldName('function')?.text === 'list')) listNames.add(left.text);
        if (right.type === 'string') stringNames.add(left.text);
      }
    }
    if (lang === 'java' && (n.type === 'local_variable_declaration' || n.type === 'field_declaration' || n.type === 'formal_parameter')) {
      const type = n.childForFieldName('type')?.text ?? '';
      const names = n.type === 'formal_parameter' ? [n.childForFieldName('name')?.text]
        : named(n).filter((d) => d.type === 'variable_declarator').map((d) => d.childForFieldName('name')?.text);
      for (const nm of names) if (nm) {
        if (type === 'String') stringNames.add(nm);
        if (/^(List|ArrayList|LinkedList|Vector|Collection)\b/.test(type)) listNames.add(nm);
      }
    }
    for (const c of named(n)) collect(c, depth + 1);
  };
  collect(root, 0);

  const frames: Frame[] = [{ name: 'module level', node: null, loopDepth: 0, maxLoop: 0, deepestOuter: null, outerLoop: null, selfCalls: 0, memo: false }];
  const top = () => frames[frames.length - 1];

  /** Is this loop bounded by a small constant (range(3), i < 4, over a literal list)?
   *  Such loops do not grow with input, so they must not inflate the Big-O estimate. */
  const constantLoop = (n: SyntaxNode): boolean => {
    if (lang === 'python' && n.type === 'for_statement') {
      const r = n.childForFieldName('right');
      if (!r) return false;
      if (r.type === 'list' || r.type === 'tuple' || r.type === 'string') return true;
      if (r.type === 'call' && r.childForFieldName('function')?.text === 'range') {
        const args = stmts(r.childForFieldName('arguments')!);
        return args.length > 0 && args.every((a) => a.type === 'integer');
      }
      return false;
    }
    if (n.type === 'for_statement' && (lang === 'js' || lang === 'java')) {
      const cond = n.childForFieldName('condition');
      const bin = cond?.type === 'binary_expression' ? cond : cond ? named(cond).find((c) => c.type === 'binary_expression') : undefined;
      const right = bin?.childForFieldName('right');
      return !!right && (right.type === 'number' || right.type === 'decimal_integer_literal');
    }
    if (lang === 'js' && n.type === 'for_in_statement') return n.childForFieldName('right')?.type === 'array';
    // `while True:` / `while (true)` is an event/game loop, not a pass over the data.
    if (n.type === 'while_statement' || n.type === 'do_statement') {
      const c = (n.childForFieldName('condition')?.text ?? '').replace(/[()\s]/g, '');
      return c === 'True' || c === 'true' || c === '1';
    }
    return false;
  };

  /* ---- Per-node checks. Each block is one rule family; see catalog.ts. ---- */
  const visit = (n: SyntaxNode, depth: number): void => {
    if (depth > 400) return;
    const f = top();
    const inLoop = f.loopDepth > 0;

    // ---------- functions: open a frame, walk, then judge the whole function
    if (FUNCS[lang].has(n.type)) {
      const name = functionName(n);
      const decorators = n.parent?.type === 'decorated_definition' ? named(n.parent).filter((d) => d.type === 'decorator').map((d) => d.text).join(' ') : '';
      const body = n.childForFieldName('body');
      const frame: Frame = { name, node: n, loopDepth: 0, maxLoop: 0, deepestOuter: null, outerLoop: null, selfCalls: 0,
        memo: /cache|memo/i.test(decorators) || /\b(memo|cache|dp)\b/i.test(body?.text ?? '') };
      frames.push(frame);
      checkFunction(n, name, decorators);
      for (const c of named(n)) visit(c, depth + 1);
      frames.pop();
      const nameNode = n.childForFieldName('name') ?? n;
      if (frame.maxLoop >= 2) report(nameNode, 'KP101', frame.maxLoop >= 3 ? 'major' : 'minor', frame.maxLoop >= 3 ? 15 : 5,
        `'${name}' nests input-sized loops ${frame.maxLoop} deep — estimated O(${power(frame.maxLoop)}). Run "KASAUTI: Prove Complexity" to measure it.`, name);
      if (frame.selfCalls >= 2 && !frame.memo) report(nameNode, 'KP105', 'major', 20,
        `'${name}' calls itself ${frame.selfCalls} times per call with no cache — may be exponential, O(2ⁿ). Memoize it or write it bottom-up.`, name);
      return;
    }

    // ---------- loops: count depth (constant loops are free)
    let added = 0;
    if (LOOPS[lang].has(n.type) && !constantLoop(n)) added = 1;
    if (lang === 'python' && COMPREHENSIONS.has(n.type)) added = named(n).filter((c) => c.type === 'for_in_clause').length;
    if (added > 0) {
      if (f.loopDepth === 0) f.outerLoop = n;
      f.loopDepth += added;
      if (f.loopDepth > f.maxLoop) { f.maxLoop = f.loopDepth; f.deepestOuter = f.outerLoop; }
      checkLoop(n);
      for (const c of named(n)) visit(c, depth + 1);
      f.loopDepth -= added;
      if (f.loopDepth === 0) f.outerLoop = null;
      return;
    }

    // ---------- calls
    const call = callInfo(n, lang);
    if (call) checkCall(call, inLoop, f);
    if (lang === 'js' && n.type === 'new_expression' && n.childForFieldName('constructor')?.text === 'Function')
      report(n, 'KP201', 'critical', 30, '`new Function(...)` compiles a string into code — anything in that string runs with full access.');
    if (lang === 'java' && n.type === 'object_creation_expression' && /^(ObjectInputStream|XMLDecoder)$/.test(n.childForFieldName('type')?.text ?? ''))
      report(n, 'KP205', 'major', 20, `${n.childForFieldName('type')!.text} can run code while reading an untrusted stream — prefer JSON, or a look-ahead filter (ObjectInputFilter).`);

    // ---------- other node shapes
    switch (n.type) {
      case 'comparison_operator': checkPyComparison(n, inLoop); break;               // python
      case 'binary_expression': checkBoolCompare(n); break;                          // js / java
      case 'augmented_assignment': case 'augmented_assignment_expression': case 'assignment_expression': case 'assignment':
        checkAssignment(n, inLoop); break;
      case 'except_clause': checkExcept(n); break;
      case 'catch_clause': checkCatch(n); break;
      case 'if_statement': checkBooleanIf(n); break;
      case 'keyword_argument':
        if (n.childForFieldName('name')?.text === 'verify' && n.childForFieldName('value')?.type === 'false')
          report(n, 'KP206', 'major', 20, '`verify=False` turns off HTTPS certificate checks — any network attacker can read and change this traffic.');
        break;
      case 'pair':
        if (/^["']?rejectUnauthorized["']?$/.test(n.childForFieldName('key')?.text ?? '') && n.childForFieldName('value')?.type === 'false')
          report(n, 'KP206', 'major', 20, '`rejectUnauthorized: false` accepts any TLS certificate — traffic can be intercepted.');
        break;
      case 'jsx_attribute':
        if (named(n)[0]?.text === 'dangerouslySetInnerHTML') report(n, 'KP208', 'major', 20, '`dangerouslySetInnerHTML` renders raw HTML — sanitise it (DOMPurify) or render text instead.');
        break;
      case 'default_parameter': case 'typed_default_parameter': {
        const v = n.childForFieldName('value');
        const mutable = v && (v.type === 'list' || v.type === 'dictionary' || v.type === 'set' || (v.type === 'call' && /^(list|dict|set)$/.test(v.childForFieldName('function')?.text ?? '')));
        if (mutable) report(n, 'KP307', 'major', 10, `Default value \`${v!.text}\` is created once and shared by every call — use None and create it inside the function.`);
        break;
      }
    }
    if (COMMENTS.has(n.type) && PLACEHOLDER_COMMENT.test(n.text))
      report(n, 'KP305', 'major', 15, `Placeholder comment "${n.text.trim().slice(0, 60)}" — the logic it stands for is missing.`);
    if (BLOCKS[lang].has(n.type) || n.type === 'module' || n.type === 'program') checkUnreachable(n);

    for (const c of named(n)) visit(c, depth + 1);
  };

  /* ---------------------------- rule bodies ---------------------------------- */

  /** KP305: function whose whole body is a stub. Abstract/overload stubs are fine. */
  function checkFunction(n: SyntaxNode, name: string, decorators: string) {
    if (lang !== 'python' || isStubFile || /abstract|overload/.test(decorators)) return;
    const body = n.childForFieldName('body');
    if (!body) return;
    const s = stmts(body).filter((x) => !(x.type === 'expression_statement' && named(x)[0]?.type === 'string'));   // drop docstring
    if (s.length !== 1) return;
    const only = s[0];
    const isStub = only.type === 'pass_statement'
      || (only.type === 'expression_statement' && named(only)[0]?.type === 'ellipsis')
      || (only.type === 'raise_statement' && /NotImplementedError/.test(only.text));
    // Inside a Protocol / ABC class an empty body is the interface itself.
    const cls = n.parent?.parent?.type === 'class_definition' ? n.parent.parent : n.parent?.parent?.parent?.type === 'class_definition' ? n.parent.parent.parent : null;
    if (isStub && !/Protocol|ABC/.test(cls?.childForFieldName('superclasses')?.text ?? ''))
      report(n.childForFieldName('name') ?? n, 'KP305', 'major', 15, `'${name}' has no real body (${only.text.split('\n')[0].trim()}) — generated stub left unimplemented.`, name);
  }

  /** KP403 / KP404: python/js loop shapes that have a one-line idiom. */
  function checkLoop(n: SyntaxNode) {
    if (lang === 'python' && n.type === 'for_statement') {
      const right = n.childForFieldName('right')?.text.replace(/\s+/g, '') ?? '';
      const m = /^range\(len\(([\w.]+)\)\)$/.exec(right);
      if (m) report(n, 'KP403', 'minor', 2, `\`for … in range(len(${m[1]}))\` — iterate directly: \`for item in ${m[1]}\`, or \`for i, item in enumerate(${m[1]})\` if you need the index.`);
    }
    const isForEach = (lang === 'python' && n.type === 'for_statement') || (lang === 'js' && n.type === 'for_in_statement' && n.childForFieldName('operator')?.text === 'of');
    if (isForEach) {
      const v = n.childForFieldName('left')?.text;
      const only = single(n.childForFieldName('body'));
      const asg = only?.type === 'expression_statement' ? named(only)[0] : only;
      if (v && asg && /^augmented_assignment(_expression)?$/.test(asg.type) && asg.childForFieldName('operator')?.text === '+='
        && asg.childForFieldName('right')?.text === v && asg.childForFieldName('left')?.type === 'identifier') {
        const total = asg.childForFieldName('left')!.text, xs = n.childForFieldName('right')?.text ?? 'items';
        report(n, 'KP404', 'minor', 2, lang === 'python'
          ? `This loop only sums — \`${total} += sum(${xs})\` does it in one line.`
          : `This loop only sums — \`${total} += ${xs}.reduce((a, b) => a + b, 0)\`.`);
      }
    }
  }

  /** Calls: KP103/KP106 inside loops, KP105 recursion count, KP201/202/203/205/207/208. */
  function checkCall(c: CallInfo, inLoop: boolean, f: Frame) {
    const firstArg = c.args[0];
    // ---- recursion: a call to the enclosing function's own name
    if (f.node && (c.full === f.name || c.full === `self.${f.name}` || c.full === `this.${f.name}`)) f.selfCalls++;

    // ---- KP103 / KP106: O(n) or O(n log n) work repeated by a loop
    if (inLoop) {
      // Python/Java: list.remove / List.contains are O(n), but set.remove /
      // HashSet.contains are O(1). Only names we SAW bound to a list get 'major';
      // Java skips unknown receivers entirely (String.indexOf is everywhere).
      const knownList = listNames.has(c.object);
      const alt = lang === 'java' && !knownList ? undefined : LINEAR_METHODS[lang][c.method];
      // pop(0) / insert(0, x) shift every element; pop() at the end is O(1) and fine.
      const pyShift = lang === 'python' && ((c.method === 'pop' && firstArg?.text === '0') || (c.method === 'insert' && firstArg?.text === '0'));
      const javaShift = lang === 'java' && c.method === 'remove' && firstArg?.text === '0';
      if ((alt && c.object) || pyShift || javaShift) {
        // `.includes` / `.indexOf` are also string methods (fast for short strings) -> minor.
        const maybeString = (lang === 'js' && (c.method === 'includes' || c.method === 'indexOf')) || (lang === 'python' && !knownList && !pyShift);
        const fix = pyShift ? 'collections.deque (popleft/appendleft are O(1))' : javaShift ? 'an ArrayDeque (pollFirst is O(1))' : alt;
        report(c.node, 'KP103', maybeString ? 'minor' : 'major', maybeString ? 5 : 10,
          `\`${c.node.text.split('\n')[0].slice(0, 50)}\` runs inside a loop and walks the whole collection each time (O(n) per iteration → O(n²)). Use ${fix}.` + (maybeString ? ' (Ignore if this is a short string or a set.)' : ''));
      }
      if (SORT_METHODS[lang].has(c.method) && (c.object || c.method === 'sorted'))
        report(c.node, 'KP106', 'major', 10, `Sorting inside a loop costs O(n log n) per iteration (O(n² log n) total). Sort once before the loop, or use a heap.`);
    }

    // ---- KP201: eval / exec
    if ((lang === 'python' && (c.full === 'eval' || c.full === 'exec')) || (lang === 'js' && c.full === 'eval')) {
      const lit = isLiteralString(firstArg);
      report(c.node, 'KP201', lit ? 'minor' : 'critical', lit ? 5 : 30,
        lit ? `\`${c.full}\` of a fixed string — harmless now, but replace it before someone passes input to it.`
            : `\`${c.full}(${(firstArg?.text ?? '').slice(0, 30)})\` executes data as code — if it can contain user input this is remote code execution. Use json/ast.literal_eval or a dict of allowed actions.`);
    }
    if (lang === 'js' && (c.full === 'setTimeout' || c.full === 'setInterval') && firstArg && (isDynamicString(firstArg) || firstArg.type === 'string'))
      report(c.node, 'KP201', 'major', 15, `\`${c.full}\` with a string argument evaluates it as code — pass a function instead.`);

    // ---- KP202: OS command execution
    let shellCall = false;
    if (lang === 'python') {
      if (/^(os\.(system|popen)|commands\.getoutput|subprocess\.(getoutput|getstatusoutput))$/.test(c.full)) shellCall = true;
      if (/^subprocess\.(run|call|Popen|check_output|check_call)$/.test(c.full)
        && c.args.some((a) => a.type === 'keyword_argument' && a.childForFieldName('name')?.text === 'shell' && a.childForFieldName('value')?.type === 'true')) shellCall = true;
    }
    if (lang === 'js' && (c.method === 'exec' || c.method === 'execSync') && (/child_process|^cp$|childProcess/.test(c.object) || (!c.object && /child_process/.test(root.text)))) shellCall = true;
    if (lang === 'java' && c.method === 'exec' && /Runtime|getRuntime/.test(c.object)) shellCall = true;
    if (shellCall) {
      const fixed = isLiteralString(firstArg);
      report(c.node, 'KP202', fixed ? 'major' : 'critical', fixed ? 15 : 30,
        fixed ? `\`${c.full}\` starts a shell. The command is fixed today; switch to an argument list (shell=False / execFile) before it ever takes input.`
              : `\`${c.full}\` runs a shell command built from variable data — characters like ; | && in that data run extra commands. Pass an argument list without a shell.`);
    }

    // ---- KP203: SQL built from strings
    if (/^(execute|executemany|executescript|raw|query|executeQuery|executeUpdate|prepareStatement|createQuery|createNativeQuery|queryForList|queryForObject)$/.test(c.method)
      && firstArg && isDynamicString(firstArg) && SQL_WORDS.test(firstArg.text))
      report(c.node, 'KP203', 'critical', 30, `SQL text passed to \`${c.method}\` is built from variables — classic SQL injection. Use placeholders (%s / ? / $1) and pass values separately.`);

    // ---- KP205: unsafe deserialization
    if (lang === 'python') {
      if (/^(c?[Pp]ickle|dill|marshal|cloudpickle|joblib)\.loads?$/.test(c.full) || c.full === 'jsonpickle.decode' || c.full === 'shelve.open')
        report(c.node, 'KP205', 'major', 20, `\`${c.full}\` can execute code while loading. Only load data you created yourself; for exchange use JSON.`);
      if (c.full === 'yaml.load' && !/SafeLoader|CSafeLoader|BaseLoader/.test(c.argList?.text ?? ''))
        report(c.node, 'KP205', 'major', 20, '`yaml.load` without SafeLoader can construct arbitrary objects — use `yaml.safe_load`.');
    }
    if (lang === 'js' && c.method === 'unserialize') report(c.node, 'KP205', 'critical', 30, '`unserialize` (node-serialize) executes functions embedded in the data — never use it on input.');

    // ---- KP207: weak hashes
    const algo = (firstArg?.text ?? '').replace(/["'`]/g, '').toLowerCase();
    if ((lang === 'python' && (/^hashlib\.(md5|sha1)$/.test(c.full) || (c.full === 'hashlib.new' && /^(md5|sha1)$/.test(algo))))
      || (lang === 'js' && c.method === 'createHash' && /^(md5|sha1)$/.test(algo))
      || (lang === 'java' && c.full === 'MessageDigest.getInstance' && /^(md5|sha-?1)$/.test(algo)))
      report(c.node, 'KP207', 'minor', 10, `${(c.full.includes('md5') || algo === 'md5') ? 'MD5' : 'SHA-1'} is broken for security — fine for a checksum, never for passwords or signatures (use SHA-256, or bcrypt/Argon2 for passwords).`);

    // ---- KP208: document.write / insertAdjacentHTML with data
    if (lang === 'js' && (c.full === 'document.write' || c.full === 'document.writeln') && firstArg && !isLiteralString(firstArg))
      report(c.node, 'KP208', 'major', 20, '`document.write` with non-literal data is an XSS sink — build DOM nodes or use textContent.');
    if (lang === 'js' && c.method === 'insertAdjacentHTML' && c.args[1] && !isLiteralString(c.args[1]))
      report(c.node, 'KP208', 'major', 20, '`insertAdjacentHTML` with non-literal data is an XSS sink — sanitise it first.');
  }

  /** Python comparisons: KP102 (in list inside loop), KP402 (== True), KP405 (== None, len()==0). */
  function checkPyComparison(n: SyntaxNode, inLoop: boolean) {
    const ops = all(n).filter((c) => !c.isNamed).map((c) => c.text).join(' ');
    const operands = named(n);
    if (inLoop && /\bin\b/.test(ops) && operands.length === 2 && operands[1].type === 'identifier' && listNames.has(operands[1].text))
      report(n, 'KP102', 'major', 10, `\`${n.text.slice(0, 40)}\` searches the list '${operands[1].text}' on every iteration (O(n) each). Make it a set: membership becomes O(1).`);
    if (/^(==|!=)$/.test(ops) && operands.some((o) => boolLiteral(o) !== undefined))
      report(n, 'KP402', 'minor', 1, `\`${n.text}\` — compare-to-boolean is redundant; use the value directly (\`if x:\` / \`if not x:\`).`);
    if (/^(==|!=)$/.test(ops) && operands.some((o) => o.type === 'none'))
      report(n, 'KP405', 'minor', 1, `\`${n.text}\` — use \`is None\` / \`is not None\` (== can be overridden by __eq__).`);
    if (/^(==|!=|>)$/.test(ops) && operands.length === 2 && /^len\(.+\)$/.test(operands[0].text) && operands[1].text === '0')
      report(n, 'KP405', 'minor', 1, `\`${n.text}\` — an empty collection is already falsy: \`if not x:\` / \`if x:\`.`);
  }

  /** JS/Java: KP402 (x === true). */
  function checkBoolCompare(n: SyntaxNode) {
    const op = n.childForFieldName('operator')?.text ?? '';
    if (!/^(==|===|!=|!==)$/.test(op)) return;
    if (boolLiteral(n.childForFieldName('left')) !== undefined || boolLiteral(n.childForFieldName('right')) !== undefined)
      report(n, 'KP402', 'minor', 1, `\`${n.text}\` — comparing with a boolean literal is redundant; use \`x\` or \`!x\`.`);
  }

  /** KP104 (string += in loop) and KP208 (innerHTML = data) and TLS env override. */
  function checkAssignment(n: SyntaxNode, inLoop: boolean) {
    const left = n.childForFieldName('left'), right = n.childForFieldName('right');
    const op = n.childForFieldName('operator')?.text ?? (n.type === 'assignment_expression' || n.type === 'assignment' ? '=' : '');
    if (inLoop && left?.type === 'identifier' && right) {
      const stringy = (x: SyntaxNode) => x.type === 'string' || x.type === 'string_literal' || isDynamicString(x) || (x.type === 'call' && x.childForFieldName('function')?.text === 'str');
      // s += "..."   or   s = s + "..."
      const plusEq = op === '+=' && (stringNames.has(left.text) || stringy(right)) && (lang === 'python' || lang === 'java');
      const selfConcat = op === '=' && lang !== 'js' && (right.type === 'binary_operator' || right.type === 'binary_expression')
        && right.childForFieldName('left')?.text === left.text && right.childForFieldName('operator')?.text === '+' && named(right).some(stringy);
      if ((plusEq || selfConcat) && (lang === 'java' ? stringNames.has(left.text) : true))
        report(n, 'KP104', lang === 'java' ? 'major' : 'minor', lang === 'java' ? 10 : 5, lang === 'java'
          ? `String '${left.text}' grows with += inside a loop — every step copies the whole string (O(n²)). Use a StringBuilder.`
          : `String '${left.text}' grows with += inside a loop — each step can copy everything so far (O(n²)). Append parts to a list and "".join() once.`);
    }
    if (lang === 'js' && left?.type === 'member_expression' && /^(innerHTML|outerHTML)$/.test(left.childForFieldName('property')?.text ?? '') && right && !isLiteralString(right))
      report(n, 'KP208', 'major', 20, `Assigning data to \`.${left.childForFieldName('property')!.text}\` parses it as HTML (XSS sink). Use textContent, or sanitise first.`);
    if (/NODE_TLS_REJECT_UNAUTHORIZED/.test(left?.text ?? '') && /['"]0['"]/.test(right?.text ?? ''))
      report(n, 'KP206', 'major', 20, 'Setting NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate checks for the whole process.');
  }

  /** KP304 python: bare `except:` / body that only passes. */
  function checkExcept(n: SyntaxNode) {
    const parts = named(n);
    const body = parts.find((p) => p.type === 'block');
    const bare = parts.filter((p) => p.type !== 'block' && !COMMENTS.has(p.type)).length === 0;
    const silent = !!body && stmts(body).every((s) => s.type === 'pass_statement' || s.type === 'continue_statement' || (s.type === 'expression_statement' && named(s)[0]?.type === 'ellipsis'));
    if (bare || silent)
      report(n, 'KP304', 'major', 10, bare && silent ? '`except: pass` hides every error, even Ctrl+C — catch the specific exception and handle or log it.'
        : bare ? 'Bare `except:` also catches KeyboardInterrupt and SystemExit — name the exception you expect.'
        : `\`${n.text.split('\n')[0].trim()}\` then nothing — the error disappears silently. Log it, handle it, or let it propagate.`);
  }

  /** KP304 js/java: empty catch block. */
  function checkCatch(n: SyntaxNode) {
    const body = n.childForFieldName('body') ?? named(n).find((c) => c.type === 'block' || c.type === 'statement_block');
    if (body && stmts(body).length === 0)
      report(n, 'KP304', 'major', 10, 'Empty catch block — the error is swallowed and the program continues with bad state. Handle it, log it, or rethrow.');
  }

  /** KP401: `if c: return True else: return False` (and the no-else variant). */
  function checkBooleanIf(n: SyntaxNode) {
    const cond = n.childForFieldName('condition');
    const thenV = boolLiteral(returned(single(n.childForFieldName('consequence'))));
    if (thenV === undefined || !cond) return;
    const alt = n.childForFieldName('alternative');
    if (lang === 'python' && named(n).some((c) => c.type === 'elif_clause')) return;
    let elseV: boolean | undefined;
    if (alt) elseV = boolLiteral(returned(single(alt)));
    else {
      // `if c: return True` immediately followed by `return False`.
      let sib = n.nextNamedSibling;
      while (sib && COMMENTS.has(sib.type)) sib = sib.nextNamedSibling;
      elseV = boolLiteral(returned(sib));
    }
    if (elseV === undefined || elseV === thenV) return;
    const c = cond.text.replace(/^\((.*)\)$/s, '$1');
    const expr = thenV ? (lang === 'python' ? `bool(${c})` : `Boolean(${c})`) : (lang === 'python' ? `not (${c})` : `!(${c})`);
    report(n, 'KP401', 'minor', 2, `This if/else only returns ${thenV ? 'true/false' : 'false/true'} — write \`return ${expr}\`${thenV ? ' (drop the bool()/Boolean() if the condition is already a boolean)' : ''}.`);
  }

  /** KP306: statements after an unconditional jump in the same block. */
  function checkUnreachable(n: SyntaxNode) {
    const s = stmts(n);
    for (let i = 0; i < s.length - 1; i++) {
      if (!JUMPS.has(s[i].type)) continue;
      const next = s.slice(i + 1).find((x) => x.type !== 'function_declaration' && x.type !== 'class_declaration'); // hoisted in JS
      if (next) report(next, 'KP306', 'major', 5, `Unreachable: this line comes after \`${s[i].text.split('\n')[0].trim().slice(0, 40)}\` and can never run.`);
      return;                                // one report per block is enough
    }
  }

  visit(root, 0);

  // Module-level nested loops (scripts, notebooks): report at the outer loop.
  const mod = frames[0];
  if (mod.maxLoop >= 2 && mod.deepestOuter)
    report(mod.deepestOuter, 'KP101', mod.maxLoop >= 3 ? 'major' : 'minor', mod.maxLoop >= 3 ? 15 : 5,
      `Loops nested ${mod.maxLoop} deep at module level — estimated O(${power(mod.maxLoop)}).`);

  // De-duplicate: the same rule on the same position once (e.g. nested binary ops).
  const seen = new Set<string>();
  return out.filter((x) => { const k = `${x.ruleId}:${x.line}:${x.col}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
