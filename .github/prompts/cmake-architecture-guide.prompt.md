---
name: "CMake IntelliSence Architecture Guide"
description: "Use when you need a precise architecture walkthrough, feature trace, or code-reading guide for this repository"
argument-hint: "Ask about a subsystem, request flow, or file group in this repo"
agent: "agent"
model: "GPT-5 (copilot)"
---

Explain this repository using its actual implementation, not generic VS Code extension or LSP theory.

Question: ${input}

Architecture anchors:
- VS Code activation and language client: [client/src/extension.ts](../../client/src/extension.ts)
- LSP lifecycle and request registration: [server/src/server.ts](../../server/src/server.ts)
- Environment bootstrap from external tools: [server/src/cmakeEnvironment.ts](../../server/src/cmakeEnvironment.ts)
- Symbol and dependency indexing: [server/src/symbolIndex.ts](../../server/src/symbolIndex.ts)
- Completion and command-context logic: [server/src/completion.ts](../../server/src/completion.ts)
- Definition/references/rename/link flows: [server/src/defination.ts](../../server/src/defination.ts), [server/src/references.ts](../../server/src/references.ts), [server/src/rename.ts](../../server/src/rename.ts), [server/src/docLink.ts](../../server/src/docLink.ts)
- Formatting and semantic tokens: [server/src/format.ts](../../server/src/format.ts), [server/src/semanticTokens.ts](../../server/src/semanticTokens.ts)
- Tests and LSP harness: [server/src/test/integration/integration.test.ts](../../server/src/test/integration/integration.test.ts)

What to deliver:
1. Start with the smallest useful overview of the subsystem or flow asked about.
2. Trace control flow through specific files and functions.
3. Explain what state is cached, where it is refreshed, and which external processes or generated artifacts are involved.
4. Call out repo-specific conventions and non-obvious constraints.
5. If relevant, suggest the safest file to edit for a future change.

When comparing alternatives:
- Explain why one layer is the right place to change behavior.
- Mention tradeoffs for parser changes, server routing changes, and feature-module changes.

Output:
- Overview paragraph.
- Concrete flow with file references.
- Risks, extension points, and recommended edit locations.