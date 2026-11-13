Next parent host action is ready:

[One-shot native v9 upload and attachment request](/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-v9-publication-gate/linear-native-v9-upload-attachment-parent-request.json) — SHA `c5ecd5e4…`

It requires:

- Fresh clean/remote verification at `9cd35756…`.
- Fresh AIO-1217 readback: In Progress, unchanged exact v6/v7, zero v9 markers, no existing v9 attachment.
- Exactly one `fileUpload`, one signed HTTPS PUT with returned provider headers only, and one `attachmentCreate`.
- No API credential to the PUT target; no signed URLs/header values persisted.
- Immediate attachment identity query, unchanged-ticket readback, and authenticated private asset readback proving v9 SHA `0a19ddf8…` and 203946 bytes.
- No retry after an uncertain write.

[CURRENT.json](/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/CURRENT.json) and the [package manifest](/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-v9-publication-gate/package-manifest.json) reflect the completed schema chain. No runtime, E4/E6, historical-gap, or final-task credit is implied.