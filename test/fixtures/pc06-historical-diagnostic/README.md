# PC-06 historical diagnostic fixture — SHAPE COVERAGE ONLY

Real provider responses for a September 6 2026 `scan-on-merge` push run whose job was refused by an
environment branch policy (`trusted-automation`). They show the API shape the off-branch probe parser
reads — job → `check_run_url` → check run → exactly two annotations.

They are NOT PC-06 evidence: wrong event, workflow, branch, environment and actor, outside any
commissioning window, with no probe intent. `test/staging-offbranch-probe.test.ts` proves they pass
only the isolated shape parser and FAIL the live validator.

`jobs.json` and `annotations.json` are byte-identical to the retained responses. `run.json` and
`check.json` each have exactly one field removed, listed below; no other field was changed, and the
retained originals are unaltered in private evidence. The test asserts the SHA-256 of all four files
as published here, so any further edit fails the suite.

| File | Removed | Why | Retained original SHA-256 |
| --- | --- | --- | --- |
| `run.json` | `head_commit` | carried a commit author's name and email this public repository does not need | `7d2efcae31a31961b5252d414fcecb2eb368a0ed6211dc481a2f5436acb22b8e` |
| `check.json` | `app.client_id` | GitHub's own Actions App OAuth client identifier. Public provider metadata, not a credential and not a secret of this repository — but it is an unreferenced field that a secret scanner reasonably flags, and no parser reads it, so it is removed rather than waived | `59089a7981d5f9f0016cb5ddfd46d8f2b87a87473a8f1a010e481dee05bc2e7b` |

Nothing here is allowlisted, suppressed or excluded from scanning. `parseProbeCheck` joins the check
producer on `app.id`, `app.slug` and `app.owner` only, so the removed field is dead weight in both
files.
