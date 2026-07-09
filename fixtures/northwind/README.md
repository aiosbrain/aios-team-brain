# Sample Engagement — Northwind Robotics (synthetic)

A fully synthetic engagement used to demonstrate and test the AIOS
harnesses. **Northwind Robotics and everyone in it are fictional.** The data is
seeded with deliberate issues so the harnesses have something real to find.

Run any harness with `repoPath` pointing at this folder, e.g.:

```
Workflow({
  scriptPath: "scaffold/.claude/skills/decision-audit/decision-audit.workflow.js",
  args: { repoPath: "<abs path>/examples/sample-engagement", runDate: "2026-06-05" }
})
```

## What's here
- `00-engagement/` — `scope-baseline.md` (4 contracted tracks) + `scope-ledger.md`.
- `01-intake/transcripts/` — 2 meeting transcripts with extractable decisions.
- `02-deliverables/sprint-1/` — 5 deliverables spanning in-scope / watch / out-of-scope.
- `03-status/` — decision log, client-surface log, hours, tasks, sprint ledger.

## Seeded findings (expected harness output)

> These are the issues deliberately planted for the harnesses to surface. Agent
> harnesses are **non-deterministic** — a given run may also flag other genuine issues
> (e.g. rationales that merely restate the decision) or vary in exact coverage on a
> small log. Sample outputs from one run are in `../sample-output/`.

### decision-audit (against `03-status/decision-log.md`, runDate 2026-06-05)
| Entry | Rule | Issue |
|-------|------|-------|
| #5 | missing-rationale | Rationale is `—` |
| #8 | missing-decided-by | Decided By is blank |
| #11 | bad-audience-tag | Audience is `external` (not admin/team/client) |
| #10 | type-impact-mismatch | Phase-2 **pricing** marked Type 1 (should be Type 3) |
| #18 | orphaned-client | Audience `client` but no client-surface-log entry |
| #13 | stale | 2026-03-20 policy draft "awaiting SC sign-off", unresolved >30d |
| #19 + #20 | near-duplicate | Same "Ops LJ Day 1 delivered" decision twice |

### scope-creep (against `02-deliverables/sprint-1/`)
| Deliverable | Expected grade |
|-------------|----------------|
| ai-readiness-assessment-report | in-scope (track 1) |
| ops-team-learning-journey | in-scope (track 2.1) |
| governance-framework | in-scope (track 3) |
| support-chatbot-design | watch (ledger #3 design-only; build plan is an expansion) |
| predictive-maintenance-prototype | out-of-scope (ledger #4; net-new build) |

### transcript-decisions (against `01-intake/transcripts/`)
Both transcripts contain decisions already in the log (e.g. ops LJ outline approval,
advisory gates, usage-policy circulation) which dedup should drop, plus novel ones
(mid-sprint ops check-in, no Sprint-1 dashboard, co-facilitation, data-retention
section, deferring legal review) which should survive as new, grounded rows.
