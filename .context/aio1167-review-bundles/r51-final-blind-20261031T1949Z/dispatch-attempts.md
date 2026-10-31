# Blind-review dispatch attempts

- GPT-6 Astra HIGH, Codex CLI session `01a19383-f7bf-7150-8f1e-d31fac79fc24`: exact model accepted; candidate manifest hashes all matched, but review was incomplete because relative packet paths could not be resolved from the read-only source worktree. No verdict was issued, no tests ran, and no files were modified. This is preserved as `astra-attempt1-incomplete.md`; a fresh invocation will receive absolute paths.
- GPT-6.1 Sol HIGH, Codex CLI session `01a19383-fc12-7513-89b2-1de7c8b5e35d`: ChatGPT-account CLI returned `model_not_found` for the exact requested model before review began. No review occurred. Routed the same assigned model to the app's model-selectable independent reviewer delegation; no model substitution.
