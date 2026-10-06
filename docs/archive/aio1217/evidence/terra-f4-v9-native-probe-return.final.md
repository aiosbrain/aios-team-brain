Concrete next parent action:

[Read-only schema follow-up request](/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-v9-publication-gate/linear-native-attachment-schema-followup-parent-request.json) — SHA `1a3eefaf…`

It uses only the verified local toolkit:

`/Users/chetan/Dropbox/Code/aios/aios-toolkit/scripts/linear.mjs`

The action:

- Reads actual `fileUpload` and `attachmentCreate` mutation return types.
- Derives payload type names from that response, then introspects their fields without guessed literals.
- Captures full JSON through anonymous temp files, validates JSON before sanitization, records only hashed/redacted URL facts, and deletes raw capture.
- Confirms AIO-1217 remains In Progress with unchanged exact v6/v7 description and no v9 attachment.
- Makes no Linear mutation, upload, comment, or retry.

[CURRENT.json](/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/CURRENT.json) and the [publication package manifest](/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-v9-publication-gate/package-manifest.json) preserve the blocked probe and this next gate.