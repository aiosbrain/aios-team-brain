# Fable review admission

- Read time: 2026-10-31 about 18:51 UTC, from `/usage` in the existing logged-in `aio1167-r30-opus-writer` Claude TUI.
- Applicable utilization: session 47%, all-model week 36%, Fable week 42%; usage credits off. All windows are below the 90% stop threshold.
- Full-user CLI auth checked through normal elevated read-only `claude auth status`: `loggedIn=true`, `authMethod=claude.ai`, `apiProvider=firstParty`, subscription `max`. Personal account identifiers omitted.
- Review model: `claude-fable-5-1`; tools restricted to Read/Grep/Glob; MCP config empty; no session persistence; API key/token/base URL overrides unset; no API billing or credit use.
- Pre-dispatch remote checkpoint: recovery branch `codex/aio-1167-checkpoint-20261027` at `59152ca2b9bd037f91ab31f9c9f6de3cd36c7f17`, independently verified with `git ls-remote`.
- Exact prompt: `.context/aio1167-review-bundles/r51-f1-delta-20261031T1843Z/fable-review-prompt.md`, SHA-256 `057bee28d912644e0e3baa58522b75e0e985a9ee2da0652f2609befa0a70439b`.
- Review scope: one test-only path per the packet manifest.
