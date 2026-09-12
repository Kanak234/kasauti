/* =============================================================================
 * KASAUTI — engine/languages.ts
 * -----------------------------------------------------------------------------
 * WHAT:  (1) Which file extensions belong to which language and tier.
 *        (2) For every Tier 1 language, a small "role mapping": which tree-sitter
 *            node types mean "function", "if", "loop", "catch", etc.
 * WHY:   The metrics engine (metrics.ts) is language-agnostic. It never says
 *        `if (node.type === 'if_statement')`. It asks `roleOf(node)` and gets
 *        back a Role. Supporting a new language = adding one entry here, no
 *        engine change (SPEC §B3).
 * FLOW:  analyzer.ts -> detectLanguage(path) picks a LangSpec -> parser.ts loads
 *        its grammar -> metrics.ts walks the tree calling roleOf()/nameOf().
 *
 * Node type names below were VERIFIED on 11 Sep 2026 by dumping every node type
 * from each grammar in tree-sitter-wasms@0.1.13 (see docs/SPEC.md §B3), and are
 * locked by the golden tests in test/.
 * ========================================================================== */

/** The minimal slice of a tree-sitter node the engine needs.
 *  Declared here (instead of importing web-tree-sitter types) so metrics code
 *  stays decoupled from the parser library version. */
export interface SyntaxNode {
  type: string;
  isNamed: boolean;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childCount: number;
  namedChildCount: number;
  child(i: number): SyntaxNode | null;
  namedChild(i: number): SyntaxNode | null;
  parent: SyntaxNode | null;
  childForFieldName(name: string): SyntaxNode | null;
  previousNamedSibling: SyntaxNode | null;
  nextNamedSibling: SyntaxNode | null;
  nextSibling: SyntaxNode | null;
  id: number;
}

/** What a syntax node MEANS for complexity purposes. */
export type Role =
  | 'function'  // named function / method / constructor -> its own metrics unit
  | 'lambda'    // anonymous function; a unit only when not inside another unit
  | 'class'     // class-like container (owns methods)
  | 'if'        // if / unless / guard
  | 'elseif'    // dedicated else-if node (python elif_clause, ruby elsif...)
  | 'else'      // dedicated else node (else_clause, ruby else...)
  | 'loop'      // for / while / do / repeat / foreach
  | 'switch'    // switch / match / when / case-expression
  | 'case'      // one branch of a switch (default branches are auto-excluded)
  | 'catch'     // catch / except / rescue
  | 'ternary'   // a ? b : c
  | 'jump';     // goto (cognitive complexity "break in flow")

/** Per-language configuration. */
export interface LangSpec {
  key: string;                // stable id, also the grammar file suffix
  display: string;            // shown in UI
  extensions: string[];       // lower-case, with dot
  /** node type -> role lookup table (built from `roles` below at load time) */
  roles: Partial<Record<Role, string[]>>;
  /** Wrapper node types that may sit between an `if` and its else-branch `if`
   *  (e.g. Kotlin's control_structure_body). Used for else-if detection. */
  transparent?: string[];
  /** Node types whose logical-operator children (&&, ||, and, or) count. */
  logicalParents?: RegExp;
  /** Language-specific override. Return a Role, `null` for "no role", or
   *  `undefined` to fall back to the `roles` table. */
  customRole?(node: SyntaxNode): Role | null | undefined;
  /** Language-specific function-name extraction (fallback is generic). */
  nameOf?(node: SyntaxNode): string | undefined;
  /** Language-specific parameter counting (fallback is generic). */
  paramsOf?(node: SyntaxNode): number | undefined;
}

/* -----------------------------------------------------------------------------
 * Shared building blocks. Many C-family grammars share names, so we compose.
 * --------------------------------------------------------------------------- */
const DEFAULT_LOGICAL_PARENTS = /binary|boolean_operator|infix|conjunction|disjunction|logical/;

const C_FAMILY_FLOW: Partial<Record<Role, string[]>> = {
  if: ['if_statement'],
  else: ['else_clause'],
  loop: ['for_statement', 'while_statement', 'do_statement'],
  switch: ['switch_statement'],
  case: ['case_statement'],
  ternary: ['conditional_expression'],
  jump: ['goto_statement'],
};

const JS_TS: Partial<Record<Role, string[]>> = {
  function: ['function_declaration', 'generator_function_declaration', 'method_definition'],
  lambda: ['arrow_function', 'function_expression', 'generator_function', 'function'],
  class: ['class_declaration', 'class', 'abstract_class_declaration'],
  if: ['if_statement'],
  else: ['else_clause'],
  loop: ['for_statement', 'for_in_statement', 'while_statement', 'do_statement'],
  switch: ['switch_statement'],
  case: ['switch_case'],
  catch: ['catch_clause'],
  ternary: ['ternary_expression'],
};

/* -----------------------------------------------------------------------------
 * Elixir: almost everything is a `call` node (`def`, `if`, `case` are macros),
 * so roles are decided by the call target's text.
 * --------------------------------------------------------------------------- */
function elixirTarget(node: SyntaxNode): string | undefined {
  if (node.type !== 'call') return undefined;
  const t = node.childForFieldName('target');
  return t ? t.text : undefined;
}
const ELIXIR_FN = new Set(['def', 'defp', 'defmacro', 'defmacrop']);
const ELIXIR_CLASS = new Set(['defmodule', 'defprotocol', 'defimpl']);
const ELIXIR_IF = new Set(['if', 'unless']);
const ELIXIR_SWITCH = new Set(['case', 'cond', 'with', 'receive', 'try']);
const ELIXIR_LOOP = new Set(['for']);

/** Inner `name(args)` call of `def name(args)` — used for name and params. */
function elixirHead(node: SyntaxNode): SyntaxNode | undefined {
  // def foo(a, b) do ... end  ->  call(target:def, arguments(call(target:foo, arguments(a, b))))
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)!;
    if (c.type === 'arguments') {
      const first = c.namedChild(0);
      if (!first) return undefined;
      // `def foo(a) when a > 0` wraps the head in a binary_operator ("when")
      if (first.type === 'binary_operator') return first.namedChild(0) ?? undefined;
      return first;
    }
  }
  return undefined;
}

/* -----------------------------------------------------------------------------
 * THE REGISTRY — 24 Tier 1 languages (Elm excluded: its prebuilt grammar is
 * ABI 12, which web-tree-sitter 0.25 cannot load; Elm runs as Tier 2).
 * --------------------------------------------------------------------------- */
export const TIER1: LangSpec[] = [
  {
    key: 'bash', display: 'Bash', extensions: ['.sh', '.bash', '.zsh'],
    roles: {
      function: ['function_definition'],
      if: ['if_statement'], elseif: ['elif_clause'], else: ['else_clause'],
      loop: ['for_statement', 'c_style_for_statement', 'while_statement'],
      switch: ['case_statement'], case: ['case_item'],
      ternary: ['ternary_expression'],
    },
    // `a && b` in bash lives in `list` nodes; `[[ a && b ]]` in binary_expression
    logicalParents: /^list$|binary_expression/,
  },
  {
    key: 'c', display: 'C', extensions: ['.c', '.h'],
    roles: { function: ['function_definition'], ...C_FAMILY_FLOW, catch: ['seh_except_clause'] },
    logicalParents: /^binary_expression$/,   // avoid `&&` in declarators
  },
  {
    key: 'cpp', display: 'C++', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.ipp', '.inl'],
    roles: {
      function: ['function_definition'], lambda: ['lambda_expression'],
      class: ['class_specifier', 'struct_specifier'],
      ...C_FAMILY_FLOW,
      loop: ['for_statement', 'for_range_loop', 'while_statement', 'do_statement'],
      catch: ['catch_clause', 'seh_except_clause'],
    },
    logicalParents: /^binary_expression$/,   // `&&` is also an rvalue reference
  },
  {
    key: 'c_sharp', display: 'C#', extensions: ['.cs'],
    roles: {
      function: ['method_declaration', 'constructor_declaration', 'destructor_declaration',
        'local_function_statement', 'operator_declaration', 'conversion_operator_declaration'],
      lambda: ['lambda_expression', 'anonymous_method_expression'],
      class: ['class_declaration', 'struct_declaration', 'record_declaration', 'interface_declaration'],
      if: ['if_statement'],
      loop: ['for_statement', 'for_each_statement', 'while_statement', 'do_statement'],
      switch: ['switch_statement', 'switch_expression'],
      case: ['switch_section', 'switch_expression_arm'],
      catch: ['catch_clause'], ternary: ['conditional_expression'], jump: ['goto_statement'],
    },
    logicalParents: /^binary_expression$/,
  },
  {
    key: 'dart', display: 'Dart', extensions: ['.dart'],
    roles: {
      // Dart's grammar puts `function_signature` and `function_body` side by
      // side (not wrapped), so the BODY is the unit and the name comes from
      // the previous sibling (see nameOf/paramsOf below).
      function: ['function_body'],
      lambda: ['function_expression'],
      class: ['class_definition', 'mixin_declaration', 'extension_declaration'],
      if: ['if_statement', 'if_element'],
      loop: ['for_statement', 'while_statement', 'do_statement', 'for_element'],
      switch: ['switch_statement', 'switch_expression'],
      case: ['switch_statement_case', 'switch_expression_case'],
      catch: ['catch_clause'], ternary: ['conditional_expression'],
    },
    customRole(node) {
      // A function_body belonging to a lambda is part of that lambda, not a unit.
      if (node.type === 'function_body' && node.parent?.type === 'function_expression') return null;
      return undefined;
    },
    nameOf(node) {
      if (node.type !== 'function_body') return undefined;
      const sig = node.previousNamedSibling;
      if (!sig) return undefined;
      const inner = sig.type === 'method_signature' ? (sig.namedChild(0) ?? sig) : sig;
      const n = inner.childForFieldName('name');
      if (n) return n.text;
      for (let i = 0; i < inner.namedChildCount; i++) {
        const c = inner.namedChild(i)!;
        if (c.type === 'identifier') return c.text;
      }
      return undefined;
    },
    paramsOf(node) {
      if (node.type !== 'function_body') return undefined;
      const sig = node.previousNamedSibling;
      if (!sig) return 0;
      const list = findDescendant(sig, (n) => n.type === 'formal_parameter_list', 3);
      if (!list) return 0;
      let count = 0;
      for (let i = 0; i < list.namedChildCount; i++) {
        const c = list.namedChild(i)!;
        if (c.type === 'optional_formal_parameters') {
          for (let j = 0; j < c.namedChildCount; j++) if (!/comment/.test(c.namedChild(j)!.type)) count++;
        } else if (!/comment/.test(c.type)) count++;
      }
      return count;
    },
  },
  {
    key: 'elixir', display: 'Elixir', extensions: ['.ex', '.exs'],
    roles: {
      lambda: ['anonymous_function'],
      else: ['else_block'], catch: ['rescue_block', 'catch_block'],
      case: ['stab_clause'],
    },
    customRole(node) {
      const t = elixirTarget(node);
      if (t === undefined) {
        // stab_clause (`pattern -> body`) is a case only inside case/cond/etc.
        if (node.type === 'stab_clause') {
          const owner = node.parent?.parent;       // do_block -> call
          const ot = owner ? elixirTarget(owner) : undefined;
          return ot && ELIXIR_SWITCH.has(ot) ? 'case' : null;
        }
        return undefined;
      }
      if (ELIXIR_FN.has(t)) return 'function';
      if (ELIXIR_CLASS.has(t)) return 'class';
      if (ELIXIR_IF.has(t)) return 'if';
      if (ELIXIR_SWITCH.has(t)) return 'switch';
      if (ELIXIR_LOOP.has(t)) return 'loop';
      return null;
    },
    nameOf(node) {
      const head = elixirHead(node);
      if (!head) return undefined;
      const t = head.childForFieldName('target');
      return (t ?? head).text;
    },
    paramsOf(node) {
      const head = elixirHead(node);
      if (!head || head.type !== 'call') return 0;
      for (let i = 0; i < head.namedChildCount; i++) {
        const c = head.namedChild(i)!;
        if (c.type === 'arguments') return c.namedChildCount;
      }
      return 0;
    },
  },
  {
    key: 'go', display: 'Go', extensions: ['.go'],
    roles: {
      function: ['function_declaration', 'method_declaration'], lambda: ['func_literal'],
      if: ['if_statement'], loop: ['for_statement'],
      switch: ['expression_switch_statement', 'type_switch_statement', 'select_statement'],
      case: ['expression_case', 'type_case', 'communication_case'],
      jump: ['goto_statement'],
    },
    paramsOf(node) {
      // `func f(a, b int)` is ONE parameter_declaration holding two names.
      const list = node.childForFieldName('parameters');
      if (!list) return 0;
      let count = 0;
      for (let i = 0; i < list.namedChildCount; i++) {
        const d = list.namedChild(i)!;
        if (/comment/.test(d.type)) continue;
        let names = 0;
        for (let j = 0; j < d.namedChildCount; j++) if (d.namedChild(j)!.type === 'identifier') names++;
        count += Math.max(1, names);
      }
      return count;
    },
  },
  {
    key: 'java', display: 'Java', extensions: ['.java'],
    roles: {
      function: ['method_declaration', 'constructor_declaration', 'compact_constructor_declaration'],
      lambda: ['lambda_expression'],
      class: ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'],
      if: ['if_statement'],
      loop: ['for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement'],
      switch: ['switch_expression', 'switch_statement'],
      case: ['switch_block_statement_group', 'switch_rule'],
      catch: ['catch_clause'], ternary: ['ternary_expression'],
    },
  },
  { key: 'javascript', display: 'JavaScript', extensions: ['.js', '.jsx', '.mjs', '.cjs'], roles: JS_TS },
  { key: 'typescript', display: 'TypeScript', extensions: ['.ts', '.mts', '.cts'], roles: JS_TS },
  { key: 'tsx', display: 'TypeScript React', extensions: ['.tsx'], roles: JS_TS },
  {
    key: 'kotlin', display: 'Kotlin', extensions: ['.kt', '.kts'],
    roles: {
      function: ['function_declaration', 'secondary_constructor', 'getter', 'setter'],
      lambda: ['lambda_literal', 'anonymous_function'],
      class: ['class_declaration', 'object_declaration', 'companion_object'],
      if: ['if_expression'],
      loop: ['for_statement', 'while_statement', 'do_while_statement'],
      switch: ['when_expression'], case: ['when_entry'],
      catch: ['catch_block'],
    },
    transparent: ['control_structure_body'],
  },
  {
    key: 'lua', display: 'Lua', extensions: ['.lua'],
    roles: {
      function: ['function_declaration', 'function_definition_statement', 'local_function_definition_statement'],
      lambda: ['function_definition'],
      if: ['if_statement'], elseif: ['elseif_clause', 'elseif_statement'], else: ['else_clause', 'else_statement'],
      loop: ['for_generic_statement', 'for_numeric_statement', 'for_statement', 'while_statement', 'repeat_statement'],
    },
  },
  {
    key: 'objc', display: 'Objective-C', extensions: ['.m', '.mm'],
    roles: {
      function: ['function_definition', 'method_definition'],
      lambda: ['block_literal'],
      class: ['class_implementation', 'class_interface', 'implementation_definition'],
      ...C_FAMILY_FLOW,
      catch: ['catch_clause'],
    },
    logicalParents: /^binary_expression$/,
  },
  {
    key: 'ocaml', display: 'OCaml', extensions: ['.ml', '.mli'],
    roles: {
      function: ['method_definition'],
      lambda: ['fun_expression', 'function_expression'],
      class: ['class_definition', 'module_definition'],
      if: ['if_expression'], else: ['else_clause'],
      loop: ['for_expression', 'while_expression'],
      switch: ['match_expression', 'try_expression'],
      case: ['match_case'],
    },
    customRole(node) {
      // `let f a b = ...` is a let_binding WITH parameter children -> function.
      // `let x = 5` (no parameters) is just a value -> no role.
      if (node.type === 'let_binding') {
        for (let i = 0; i < node.namedChildCount; i++) {
          if (node.namedChild(i)!.type === 'parameter') return 'function';
        }
        return null;
      }
      return undefined;
    },
    nameOf(node) {
      if (node.type === 'let_binding') return node.childForFieldName('pattern')?.text;
      return undefined;
    },
    paramsOf(node) {
      if (node.type !== 'let_binding') return undefined;
      let n = 0;
      for (let i = 0; i < node.namedChildCount; i++) if (node.namedChild(i)!.type === 'parameter') n++;
      return n;
    },
    // OCaml uses `and` to chain let-bindings, so only symbolic operators count.
    logicalParents: /^infix_expression$/,
  },
  {
    key: 'php', display: 'PHP', extensions: ['.php', '.phtml'],
    roles: {
      function: ['function_definition', 'method_declaration'],
      lambda: ['anonymous_function_creation_expression', 'anonymous_function', 'arrow_function'],
      class: ['class_declaration', 'trait_declaration', 'interface_declaration', 'enum_declaration'],
      if: ['if_statement'], elseif: ['else_if_clause'], else: ['else_clause'],
      loop: ['for_statement', 'foreach_statement', 'while_statement', 'do_statement'],
      switch: ['switch_statement', 'match_expression'],
      case: ['case_statement', 'match_conditional_expression'],
      catch: ['catch_clause'], ternary: ['conditional_expression'], jump: ['goto_statement'],
    },
  },
  {
    key: 'python', display: 'Python', extensions: ['.py', '.pyw', '.pyi'],
    roles: {
      function: ['function_definition'], lambda: ['lambda'],
      class: ['class_definition'],
      if: ['if_statement', 'if_clause'], elseif: ['elif_clause'], else: ['else_clause'],
      loop: ['for_statement', 'while_statement', 'for_in_clause'],
      switch: ['match_statement'], case: ['case_clause'],
      catch: ['except_clause', 'except_group_clause'],
      ternary: ['conditional_expression'],
    },
  },
  {
    key: 'rescript', display: 'ReScript', extensions: ['.res', '.resi'],
    roles: {
      lambda: ['function'],
      if: ['if_expression'], elseif: ['else_if_clause'], else: ['else_clause'],
      loop: ['for_expression', 'while_expression'],
      switch: ['switch_expression', 'try_expression'], case: ['switch_match'],
      ternary: ['ternary_expression'],
    },
  },
  {
    key: 'ruby', display: 'Ruby', extensions: ['.rb', '.rake', '.gemspec'],
    roles: {
      function: ['method', 'singleton_method'],
      lambda: ['lambda', 'block', 'do_block'],
      class: ['class', 'module', 'singleton_class'],
      if: ['if', 'unless', 'if_modifier', 'unless_modifier'],
      elseif: ['elsif'], else: ['else'],
      loop: ['while', 'until', 'for', 'while_modifier', 'until_modifier'],
      switch: ['case', 'case_match'], case: ['when', 'in_clause'],
      catch: ['rescue', 'rescue_modifier'],
      ternary: ['conditional'],
    },
  },
  {
    key: 'rust', display: 'Rust', extensions: ['.rs'],
    roles: {
      function: ['function_item'], lambda: ['closure_expression'],
      class: ['impl_item', 'trait_item'],
      if: ['if_expression'], else: ['else_clause'],
      loop: ['for_expression', 'while_expression', 'loop_expression'],
      switch: ['match_expression'], case: ['match_arm'],
    },
    logicalParents: /^binary_expression$/,
  },
  {
    key: 'scala', display: 'Scala', extensions: ['.scala', '.sc'],
    roles: {
      function: ['function_definition'], lambda: ['lambda_expression'],
      class: ['class_definition', 'object_definition', 'trait_definition'],
      if: ['if_expression'],
      loop: ['for_expression', 'while_expression', 'do_while_expression'],
      switch: ['match_expression'], case: ['case_clause'],
      catch: ['catch_clause'],
    },
    customRole(node) {
      // The Scala grammar bundled in tree-sitter-wasms@0.1.13 parses
      // `for (...) {}` and `while (...) {}` (Scala 2 syntax) as a call to a
      // function named "for"/"while". Verified by golden test sample.scala.
      if (node.type === 'call_expression') {
        const fn = node.namedChild(0);
        if (fn && fn.type === 'identifier' && (fn.text === 'for' || fn.text === 'while')) return 'loop';
      }
      return undefined;
    },
  },
  {
    key: 'solidity', display: 'Solidity', extensions: ['.sol'],
    roles: {
      function: ['function_definition', 'constructor_definition', 'modifier_definition', 'fallback_receive_definition'],
      class: ['contract_declaration', 'interface_declaration', 'library_declaration'],
      if: ['if_statement'],
      loop: ['for_statement', 'while_statement', 'do_while_statement'],
      catch: ['catch_clause'], ternary: ['ternary_expression'],
    },
  },
  {
    key: 'swift', display: 'Swift', extensions: ['.swift'],
    roles: {
      function: ['function_declaration', 'init_declaration', 'deinit_declaration'],
      lambda: ['lambda_literal'],
      class: ['class_declaration', 'protocol_declaration'],
      if: ['if_statement', 'guard_statement'],
      loop: ['for_statement', 'while_statement', 'repeat_while_statement'],
      switch: ['switch_statement'], case: ['switch_entry'],
      catch: ['catch_block'], ternary: ['ternary_expression'],
    },
  },
  {
    key: 'zig', display: 'Zig', extensions: ['.zig'],
    roles: {
      function: ['function_declaration'],
      class: ['struct_declaration'],
      if: ['if_statement', 'if_expression'], else: ['else_clause'],
      loop: ['for_statement', 'for_expression', 'while_statement', 'while_expression'],
      switch: ['switch_expression'], case: ['switch_case'],
      catch: ['catch_expression'],
    },
  },
];

/* -----------------------------------------------------------------------------
 * Fast lookup tables, built once.
 * --------------------------------------------------------------------------- */
interface CompiledSpec extends LangSpec { table: Map<string, Role>; logical: RegExp }
const COMPILED = new Map<string, CompiledSpec>();
for (const spec of TIER1) {
  const table = new Map<string, Role>();
  for (const [role, types] of Object.entries(spec.roles) as [Role, string[]][]) {
    for (const t of types) table.set(t, role);
  }
  COMPILED.set(spec.key, { ...spec, table, logical: spec.logicalParents ?? DEFAULT_LOGICAL_PARENTS });
}

export function getSpec(key: string): CompiledSpec | undefined { return COMPILED.get(key); }

/** Role of a node in a given language (custom rule first, then table). */
export function roleOf(spec: CompiledSpec, node: SyntaxNode): Role | null {
  if (spec.customRole) {
    const r = spec.customRole(node);
    if (r !== undefined) return r;
  }
  return spec.table.get(node.type) ?? null;
}

/* -----------------------------------------------------------------------------
 * Tier 2: languages without a usable grammar. Analysis is generic (SPEC §A7.2);
 * we only need a display name and the full-line comment prefixes.
 * --------------------------------------------------------------------------- */
interface Tier2Lang { key: string; display: string; comments: string[] }
const T2 = (key: string, display: string, comments: string[], exts: string[]) => ({ key, display, comments, exts });
const TIER2_LIST = [
  T2('elm', 'Elm', ['--'], ['.elm']),
  T2('haskell', 'Haskell', ['--'], ['.hs', '.lhs']),
  T2('pascal', 'Pascal', ['//', '{', '(*'], ['.pas', '.pp', '.dpr']),
  T2('fortran', 'Fortran', ['!', 'c ', 'C '], ['.f', '.for', '.f77', '.f90', '.f95', '.f03', '.f08']),
  T2('vb', 'Visual Basic', ["'", 'REM '], ['.vb', '.vbs', '.bas']),
  T2('r', 'R', ['#'], ['.r']),
  T2('julia', 'Julia', ['#'], ['.jl']),
  T2('perl', 'Perl', ['#'], ['.pl', '.pm', '.t']),
  T2('clojure', 'Clojure', [';'], ['.clj', '.cljs', '.cljc', '.edn']),
  T2('lisp', 'Lisp', [';'], ['.lisp', '.lsp', '.el', '.scm', '.ss', '.rkt']),
  T2('erlang', 'Erlang', ['%'], ['.erl', '.hrl']),
  T2('fsharp', 'F#', ['//'], ['.fs', '.fsi', '.fsx']),
  T2('groovy', 'Groovy', ['//'], ['.groovy', '.gradle', '.gvy']),
  T2('powershell', 'PowerShell', ['#'], ['.ps1', '.psm1', '.psd1']),
  T2('batch', 'Batch', ['REM ', 'rem ', '::'], ['.bat', '.cmd']),
  T2('sql', 'SQL', ['--'], ['.sql', '.psql', '.plsql']),
  T2('asm', 'Assembly', [';', '#', '//'], ['.asm', '.s', '.nasm']),
  T2('verilog', 'Verilog', ['//'], ['.v', '.sv', '.svh', '.vh']),
  T2('vhdl', 'VHDL', ['--'], ['.vhd', '.vhdl']),
  T2('cobol', 'COBOL', ['*'], ['.cob', '.cbl', '.cpy']),
  T2('ada', 'Ada', ['--'], ['.ada', '.adb', '.ads']),
  T2('tcl', 'Tcl', ['#'], ['.tcl']),
  T2('nim', 'Nim', ['#'], ['.nim']),
  T2('crystal', 'Crystal', ['#'], ['.cr']),
  T2('d', 'D', ['//'], ['.d']),
  T2('matlab', 'MATLAB/Octave', ['%'], ['.matlab']),
  T2('coffeescript', 'CoffeeScript', ['#'], ['.coffee']),
  T2('vue', 'Vue SFC', ['//', '<!--'], ['.vue']),
  T2('svelte', 'Svelte', ['//', '<!--'], ['.svelte']),
  T2('html', 'HTML', ['<!--'], ['.html', '.htm']),
  T2('css', 'CSS', ['/*'], ['.css', '.scss', '.sass', '.less', '.styl']),
  T2('gdscript', 'GDScript', ['#'], ['.gd']),
  T2('cuda', 'CUDA', ['//'], ['.cu', '.cuh']),
  T2('glsl', 'GLSL/HLSL', ['//'], ['.glsl', '.vert', '.frag', '.hlsl', '.shader']),
  T2('prolog', 'Prolog', ['%'], ['.pro', '.prolog']),
  T2('apex', 'Apex', ['//'], ['.cls', '.trigger']),
  T2('abap', 'ABAP', ['*', '"'], ['.abap']),
  T2('makefile', 'Makefile', ['#'], ['.mk']),
  T2('cmake', 'CMake', ['#'], ['.cmake']),
  T2('dockerfile', 'Dockerfile', ['#'], ['.dockerfile']),
  T2('terraform', 'Terraform/HCL', ['#', '//'], ['.tf', '.hcl']),
  T2('protobuf', 'Protocol Buffers', ['//'], ['.proto']),
  T2('graphql', 'GraphQL', ['#'], ['.graphql', '.gql']),
];

/** Known filenames without a useful extension. */
const SPECIAL_NAMES: Record<string, string> = {
  makefile: 'tier2:makefile', gnumakefile: 'tier2:makefile', dockerfile: 'tier2:dockerfile',
  'cmakelists.txt': 'tier2:cmake', rakefile: 'ruby', gemfile: 'ruby', jenkinsfile: 'tier2:groovy',
};

const EXT_MAP = new Map<string, string>();
for (const s of TIER1) for (const e of s.extensions) EXT_MAP.set(e, s.key);
const TIER2 = new Map<string, Tier2Lang>();
for (const t of TIER2_LIST) {
  TIER2.set(t.key, { key: t.key, display: t.display, comments: t.comments });
  for (const e of t.exts) if (!EXT_MAP.has(e)) EXT_MAP.set(e, 'tier2:' + t.key);
}

/** Data/config/docs: NOT source code -> never scored (they would dilute the
 *  debt ratio with thousands of "lines" that have no logic). */
const NOT_SOURCE = new Set(['.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.md', '.markdown',
  '.txt', '.csv', '.tsv', '.lock', '.ini', '.cfg', '.conf', '.env', '.properties', '.rst', '.svg',
  '.log', '.ipynb_checkpoints', '.map', '.snap']);

/** Decide the language key for a file path. Returns undefined = ignore file. */
export function detectLanguage(filePath: string, extraTier2Exts: string[] = []): string | undefined {
  const base = filePath.split(/[\\/]/).pop()!.toLowerCase();
  if (SPECIAL_NAMES[base]) return SPECIAL_NAMES[base];
  const dot = base.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = base.slice(dot);
  if (ext === '.ipynb') return 'notebook:python';           // OD-6: notebook code cells
  if (NOT_SOURCE.has(ext)) return undefined;
  const hit = EXT_MAP.get(ext);
  if (hit) return hit;
  if (extraTier2Exts.map((e) => e.toLowerCase()).includes(ext)) return 'tier2:' + ext.slice(1);
  return undefined;
}

/** Every extension we analyze — used to build the workspace file glob. */
export function allKnownExtensions(): string[] { return [...EXT_MAP.keys(), '.ipynb']; }

export function tier2Info(key: string): Tier2Lang {
  const name = key.startsWith('tier2:') ? key.slice(6) : key;
  return TIER2.get(name) ?? { key: name, display: name.toUpperCase(), comments: ['//', '#'] };
}

export function displayName(languageKey: string): string {
  if (languageKey.startsWith('tier2:')) return tier2Info(languageKey).display;
  if (languageKey.startsWith('notebook:')) return 'Jupyter Notebook';
  return COMPILED.get(languageKey)?.display ?? languageKey;
}

/* -----------------------------------------------------------------------------
 * Small tree helper shared with metrics.ts.
 * --------------------------------------------------------------------------- */
export function findDescendant(node: SyntaxNode, pred: (n: SyntaxNode) => boolean, maxDepth: number): SyntaxNode | undefined {
  if (maxDepth < 0) return undefined;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)!;
    if (pred(c)) return c;
    const d = findDescendant(c, pred, maxDepth - 1);
    if (d) return d;
  }
  return undefined;
}
