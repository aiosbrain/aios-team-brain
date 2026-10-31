Perform a fresh, blind, read-only final review of the exact AIO-1167 candidate identified below. This is an independent review; do not open prior review reports, adjudications, acceptance mappings, handoffs, writer explanations, or conversation history. In particular, do not inspect other files under .context beyond the explicitly named review inputs below.

Inputs:
- User request: user-request.md
- Accepted specification: accepted-spec.md
- Repository instructions: AGENTS.md and workflow-skill.md
- Base SHA: 5ecd2989e21fded915b41b508477bb267aaec06d
- Exact 46-path source manifest: manifest.json
- Tracked source diff: tracked-source.diff
- Added source files: untracked-source.tar.gz
- The candidate source tree is available read-only at /Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree.

Snapshot fingerprints: tracked patch SHA-256 7bce966593bb2e4c67374d17aa7317f1a0386c92eee34f37c8a97d2b4e165e6f; untracked archive SHA-256 bfbc6e4e13ea011d51a1312d3d652a1f118644830bb7a54927333c0c592dffb4; manifest SHA-256 dfce2bf22f2717b1e688fe7b44bbc0cfdbddae80ed2b2fd281cbc61bd05f3c82.

Inspect the entire changed source surface and the necessary unchanged callers/contracts. Assess correctness, security/privacy, authorization, tier boundaries, identity and audience behavior, retry/recovery and delayed work, persistence/schema compatibility, watch lifecycle, quota and cancellation semantics, integration risks, and every acceptance criterion. Trace findings to concrete changed code and relevant callers. Do not run tests or modify files.

Report only actionable findings, ordered by severity, with trigger, expected/actual behavior, exact file and line references, acceptance impact, and a focused regression if warranted. Explicitly distinguish confirmed defects from uncertain risks and coverage suggestions. If the snapshot or required evidence is inaccessible or the full review cannot be completed, say so and do not issue PASS. A review verdict is not a readiness or publication approval.
