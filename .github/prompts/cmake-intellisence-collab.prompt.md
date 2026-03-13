---
name: "CMake IntelliSence Repo Change"
description: "Use when working on a feature, bug fix, refactor, or architecture question in this CMake IntelliSence repository"
argument-hint: "Describe the change, bug, refactor, or question for this repo"
agent: "agent"
model: "GPT-5 (copilot)"
---

Work on this repository as a VS Code extension with a language-client/language-server split.

User request: ${input}

Before proposing or changing code, inspect the relevant architecture and trace the request through the real implementation.

Core map:
- Client bootstrap and VS Code integration: [client/src/extension.ts](../../client/src/extension.ts)
- LSP entrypoint and request orchestration: [server/src/server.ts](../../server/src/server.ts)
- Completion logic and command context handling: [server/src/completion.ts](../../server/src/completion.ts)
- Builtin CMake discovery and external tool integration: [server/src/cmakeEnvironment.ts](../../server/src/cmakeEnvironment.ts)
- Workspace/system symbol caches and dependency graph: [server/src/symbolIndex.ts](../../server/src/symbolIndex.ts)
- Formatting pipeline: [server/src/format.ts](../../server/src/format.ts)
- Symbol extraction and parse helpers: [server/src/symbolExtractor.ts](../../server/src/symbolExtractor.ts), [server/src/utils.ts](../../server/src/utils.ts)
- Diagnostics and quick fixes: [server/src/diagnostics.ts](../../server/src/diagnostics.ts)
- Hover doc conversion from CMake help output: [server/src/rstToMarkdown.ts](../../server/src/rstToMarkdown.ts)
- Integration and unit tests: [server/src/test/integration](../../server/src/test/integration), [server/src/test/unit](../../server/src/test/unit)

Repo-specific rules to follow:
- Treat [server/src/server.ts](../../server/src/server.ts) as the coordinator. Prefer fixing root logic in feature modules instead of piling special cases into the server unless the request is explicitly about request routing.
- Builtin commands, variables, properties, modules, and hover docs are discovered at runtime from the host `cmake` executable. Do not assume packaged static docs exist in the extension.
- Keep symbol-case behavior correct: commands are case-insensitive, while variables and targets are case-sensitive. Respect the cache behavior in [server/src/symbolIndex.ts](../../server/src/symbolIndex.ts).
- When working on completion, hover, formatting, references, rename, or symbols, verify comment filtering and incomplete-command behavior instead of only testing happy paths.
- If changing parsing or command structure behavior, inspect `FlatCommand`-based flows and existing tests before editing grammar.
- Only touch ANTLR grammar in [server/src/antlr](../../server/src/antlr) when the parser structure truly needs to change. If you edit grammar, regenerate parser output with `npm run antlr4`.
- If changing TextMate grammars in [syntaxes](../../syntaxes), regenerate JSON with `npm run grammar`.
- Keep edits minimal, preserve existing public behavior unless the request requires a change, and avoid unrelated cleanup.

Execution workflow:
1. Restate the requested outcome in repository terms.
2. Identify the concrete request path and the files that actually participate.
3. Explain any important assumptions, edge cases, or constraints before editing.
4. Make the smallest coherent implementation that fixes the root cause.
5. Add or update focused tests in the matching unit or integration test area when behavior changes.
6. Validate with the most relevant commands. Prefer `npm run compile` for server-only changes, `npm test` for behavior changes, and regenerate artifacts only when source grammars changed.
7. Summarize what changed, how it was validated, and any remaining risks or follow-up work.

When answering architecture questions without code changes:
- Trace the real flow through the repository instead of giving generic LSP explanations.
- Name the specific files and responsibilities involved.
- Call out external process boundaries such as `cmake`, `pkg-config`, ANTLR generation, webpack bundling, and VS Code client/server startup.

Output format:
- Start with a short architecture-aware plan.
- Then implement or explain the change.
- End with validation results and any unresolved risks.