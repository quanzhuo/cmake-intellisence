---
name: "CMake LSP Feature Change"
description: "Use when changing completion, hover, signature help, diagnostics, symbols, rename, references, links, or formatting in this repository"
argument-hint: "Describe the LSP behavior change or bug"
agent: "agent"
model: "GPT-5 (copilot)"
---

Implement or analyze an LSP behavior change in this repository.

User request: ${input}

Start from the real request path instead of guessing.

Primary files to inspect:
- Request router and caches: [server/src/server.ts](../../server/src/server.ts)
- Completion context and suggestion construction: [server/src/completion.ts](../../server/src/completion.ts)
- Symbol caches and dependency graph: [server/src/symbolIndex.ts](../../server/src/symbolIndex.ts)
- Builtin data discovery from `cmake` and `pkg-config`: [server/src/cmakeEnvironment.ts](../../server/src/cmakeEnvironment.ts)
- Parsing helpers and file loading: [server/src/utils.ts](../../server/src/utils.ts)
- Symbol extraction: [server/src/symbolExtractor.ts](../../server/src/symbolExtractor.ts)
- Diagnostics: [server/src/diagnostics.ts](../../server/src/diagnostics.ts)
- Formatting: [server/src/format.ts](../../server/src/format.ts)
- Hover doc conversion: [server/src/rstToMarkdown.ts](../../server/src/rstToMarkdown.ts)
- Integration tests: [server/src/test/integration/integration.test.ts](../../server/src/test/integration/integration.test.ts)
- Unit tests: [server/src/test/unit](../../server/src/test/unit)

Repository constraints:
- `server.ts` coordinates requests; prefer fixing feature logic in the dedicated module when possible.
- Builtin command/module/policy/variable/property information is discovered at runtime from the host `cmake` executable.
- Commands are case-insensitive, while variables and targets are case-sensitive.
- Comment filtering and incomplete-command handling are part of correct behavior, especially for completion and hover.
- Reuse the existing caches and helper flows instead of adding parallel lookup paths.
- Keep edits minimal and avoid unrelated refactors.

Execution steps:
1. Restate the user-visible behavior that should change.
2. Trace the current flow through the exact handlers and helpers involved.
3. Identify the narrowest root cause.
4. Implement the fix or feature in the correct module.
5. Add or update focused tests. Prefer integration tests for request/response behavior and unit tests for pure conversion or helper logic.
6. Validate with the smallest relevant command set, usually `npm run compile` plus `npm test` when behavior changed.
7. Summarize the changed flow, validation, and remaining edge cases.

Output:
- Short plan first.
- Then code changes or architecture explanation.
- End with validation results and risks.