Next parent action:

[Native attachment nested-schema probe](/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-v9-publication-gate/linear-native-attachment-nested-schema-parent-request.json) — SHA `2ad149ce…`

It uses the verified local toolkit and only live-derived types:

- `fileUpload → UploadPayload → UploadFile`
- `attachmentCreate → AttachmentPayload → Attachment`

The probe captures the exact `UploadFile` fields—including any header-object type—and attachment readback fields. It uses a restrictive temporary file for complete JSON capture, persists only sanitized/hash-only URL facts, and authorizes no mutation.

The worktree remains clean and synchronized at `9cd35756…`; all runtime, E4/E6, and historical-gap qualifications remain unchanged.