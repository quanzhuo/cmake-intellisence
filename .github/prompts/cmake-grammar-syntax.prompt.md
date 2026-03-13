---
name: "CMake Grammar Or Syntax Change"
description: "Use when changing ANTLR grammar, generated parser behavior, TextMate syntax files, or tokenization/highlighting behavior in this repository"
argument-hint: "Describe the parsing, grammar, or syntax-highlighting change"
agent: "agent"
model: "GPT-5 (copilot)"
---

Work on grammar, parser, or syntax-highlighting behavior in this repository.

User request: ${input}

Inspect the correct layer before editing anything.

Relevant areas:
- ANTLR grammars: [server/src/antlr](../../server/src/antlr)
- Generated parser output: [server/src/generated](../../server/src/generated)
- Parse and token utilities: [server/src/utils.ts](../../server/src/utils.ts)
- Flat command extraction and downstream consumers: [server/src/flatCommands.ts](../../server/src/flatCommands.ts), [server/src/completion.ts](../../server/src/completion.ts), [server/src/format.ts](../../server/src/format.ts)
- Syntax highlighting grammars: [syntaxes](../../syntaxes)
- Semantic tokens: [server/src/semanticTokens.ts](../../server/src/semanticTokens.ts)
- Parser-oriented unit tests: [server/src/test/unit/cmakeSimple.test.ts](../../server/src/test/unit/cmakeSimple.test.ts), [server/src/test/unit/format.test.ts](../../server/src/test/unit/format.test.ts), [server/src/test/unit/docSymbols.test.ts](../../server/src/test/unit/docSymbols.test.ts)

Repository constraints:
- Only edit ANTLR grammar when a parser shape change is truly required. Prefer fixing downstream logic first if parsing is already correct.
- If you change `.g4` grammar files, regenerate parser output with `npm run antlr4`.
- If you change `.yml` syntax grammars, regenerate JSON with `npm run grammar`.
- Preserve editing-time behavior for incomplete commands where possible; completion depends on partially valid command contexts.
- Do not hand-edit generated parser files unless the repo explicitly expects it.

Execution steps:
1. Decide whether the issue belongs to ANTLR parsing, FlatCommand extraction, semantic tokens, or TextMate grammars.
2. Demonstrate the current failing input with a concrete CMake snippet.
3. Make the smallest layer-appropriate change.
4. Regenerate derived artifacts only when source grammar files changed.
5. Add or update the most specific parser/format/highlighting tests.
6. Validate with `npm run compile`, and run the affected tests. Include regeneration steps when used.
7. Summarize the behavioral impact and any compatibility risks.

Output:
- State which layer owns the problem.
- Then make the change.
- End with regeneration and verification details.