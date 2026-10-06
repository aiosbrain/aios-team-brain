Verified checkpoint: document-only commit/push `9cd35756…` is clean, remote-matched, and carries `AIOS-Work: AIO-1217`. The requested no-space trailer was a request typo; the actual normal trailer is correct.

The Linear write did not mutate: `set-desc` returned `Argument Validation Error`; immediate export/readback remained SHA `fa17678…`, 185181 bytes, complete v6/v7, zero v9 markers, and In Progress.

Next parent host action is read-only:

[Native attachment capability probe](/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-v9-publication-gate/linear-native-attachment-capability-probe-parent-request.json) — SHA `b1a7fc14…`

It uses the installed Node Linear CLI raw-query route to verify the exact `fileUpload` and `attachmentCreate` schema signatures plus current ticket state/history before authorizing any upload. The later write contract permits exactly one native upload and attachment only if that probe confirms the route, with signed URLs never retained and authenticated asset-hash readback required.

Linear’s official API supports a server-side `fileUpload` flow and issue attachments via `attachmentCreate`; the probe prevents guessing the live schema or payload. [Upload guide](https://linear.app/developers/how-to-upload-a-file-to-linear), [attachments API](https://linear.app/developers/attachments).

[CURRENT.json](/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/CURRENT.json) and the [package manifest](/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-v9-publication-gate/package-manifest.json) are updated. No E4 execution, E6 UI, or historical-gap credit was added.