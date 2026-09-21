# PC-06 historical diagnostic fixture — SHAPE COVERAGE ONLY

Real provider responses for a September 6 2026 `scan-on-merge` push run whose job was refused by an
environment branch policy (`trusted-automation`). They show the API shape the off-branch probe parser
reads — job → `check_run_url` → check run → exactly two annotations.

They are NOT PC-06 evidence: wrong event, workflow, branch, environment and actor, outside any
commissioning window, with no probe intent. `test/staging-offbranch-probe.test.ts` proves they pass
only the isolated shape parser and FAIL the live validator.

`jobs.json`, `check.json` and `annotations.json` are byte-identical to the retained responses (their
SHA-256 values are asserted by the test). `run.json` is the retained response with `head_commit`
removed — it carried a commit author's name and email that this public repository does not need; no
other field was changed. The retained original's SHA-256 was
`7d2efcae31a31961b5252d414fcecb2eb368a0ed6211dc481a2f5436acb22b8e`.
