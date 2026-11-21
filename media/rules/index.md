# KASAUTI rules

Every finding links to one of these pages. All limits are configurable in Settings.

| Rule | What it checks | Default limit | Applies to |
|---|---|---|---|
| [CQ001](CQ001.md) | Function is too complex (cyclomatic) | 10 | languages with a parser |
| [CQ002](CQ002.md) | Function is hard to understand (cognitive) | 15 | languages with a parser |
| [CQ003](CQ003.md) | Function is too long | 50 | languages with a parser |
| [CQ004](CQ004.md) | Too many parameters | 7 | languages with a parser |
| [CQ005](CQ005.md) | Control flow is nested too deeply | 3 | all languages |
| [CQ006](CQ006.md) | File is too long | 1000 | all languages |
| [CQ007](CQ007.md) | Duplicated code | 100 | all languages |
| [CQ008](CQ008.md) | Low maintainability index | 20 | languages with a parser |
| [CQ009](CQ009.md) | Class has too many methods | 35 | languages with a parser |
| [CQ010](CQ010.md) | Line is too long | 120 | all languages |
| [CQ011](CQ011.md) | TODO / FIXME left in code | — | all languages |
| [CQ012](CQ012.md) | File contains syntax errors | — | languages with a parser |

## v2.0 — 360° audit rules

Found deterministically on the same parse tree as the metrics. No limits to configure: each rule is a code shape.

| Rule | What it checks | Category | Languages |
|---|---|---|---|
| [KP101](KP101.md) | Nested loops (estimated O(nᵏ)) | Performance | Python, JavaScript, TypeScript, Java |
| [KP102](KP102.md) | Membership test on a list inside a loop | Performance | Python |
| [KP103](KP103.md) | Linear search or shift inside a loop | Performance | Python, JavaScript, TypeScript, Java |
| [KP104](KP104.md) | String built with += inside a loop | Performance | Python, Java |
| [KP105](KP105.md) | Recursion that may be exponential | Performance | Python, JavaScript, TypeScript, Java |
| [KP106](KP106.md) | Sorting inside a loop | Performance | Python, JavaScript, TypeScript, Java |
| [KP201](KP201.md) | Dynamic code execution (eval / exec / new Function) | Security | Python, JavaScript, TypeScript |
| [KP202](KP202.md) | OS command injection risk | Security | Python, JavaScript, TypeScript, Java |
| [KP203](KP203.md) | SQL built from strings (SQL injection) | Security | Python, JavaScript, TypeScript, Java |
| [KP204](KP204.md) | Hard-coded secret | Security | Every language |
| [KP205](KP205.md) | Unsafe deserialization | Security | Python, JavaScript, TypeScript, Java |
| [KP206](KP206.md) | TLS certificate verification disabled | Security | Python, JavaScript, TypeScript, Java |
| [KP207](KP207.md) | Weak hash algorithm (MD5 / SHA-1) | Security | Python, JavaScript, TypeScript, Java |
| [KP208](KP208.md) | HTML injection sink (XSS) | Security | JavaScript, TypeScript |
| [KP301](KP301.md) | Import not declared in the project's dependencies | AI-risk | Python, JavaScript, TypeScript |
| [KP302](KP302.md) | Package does not exist on the registry | AI-risk | Python, JavaScript, TypeScript |
| [KP303](KP303.md) | Package is brand-new on the registry | AI-risk | Python, JavaScript, TypeScript |
| [KP304](KP304.md) | Exception swallowed | AI-risk | Python, JavaScript, TypeScript, Java |
| [KP305](KP305.md) | Placeholder or stub left in code | AI-risk | Python, JavaScript, TypeScript, Java |
| [KP306](KP306.md) | Unreachable code | AI-risk | Python, JavaScript, TypeScript, Java |
| [KP307](KP307.md) | Mutable default argument | AI-risk | Python |
| [KP401](KP401.md) | if/else that only returns a boolean | Simplify | Python, JavaScript, TypeScript, Java |
| [KP402](KP402.md) | Comparison with a boolean literal | Simplify | Python, JavaScript, TypeScript, Java |
| [KP403](KP403.md) | range(len(x)) loop | Simplify | Python |
| [KP404](KP404.md) | Manual sum loop | Simplify | Python, JavaScript, TypeScript |
| [KP405](KP405.md) | Non-idiomatic None / emptiness check | Simplify | Python |
