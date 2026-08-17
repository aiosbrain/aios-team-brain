---
resolver: v1
scope: aios-team-brain
parent: ../RESOLVER.md
skills_roots: [.claude/skills]
fixtures: .claude/resolver-fixtures.yaml
---

# aios-team-brain — Resolver

Canonical router for the Team Brain repo. `CLAUDE.md` is the entrypoint; this
file decides which skill, rule, or doc to load. Gates always apply. Parent
gates (AIOS hub, Tessera root) apply in addition.

## Always-On Gates

| Trigger | Load |
|---|---|
| BEFORE building any change | `docs/ARCHITECTURE.md` — consult the sources-of-truth table; reason from the source of truth, never a random call site |
| AFTER building any change | Update `docs/ARCHITECTURE.md` **in the same PR**; enumerable surfaces are machine-guarded by `scripts/check-docs-drift.mjs` (CI + pre-push) |
| Any task that will create commits | Worktree REQUIRED — never branch in the primary checkout (hub rule) |
| Any Railway command | **Read-only CLI**: status/logs/variables/deployment-list ONLY; never up/redeploy/down/delete — deploys happen ONLY by merging to main. Confirm `railway status` shows Project: AIOS first (`scripts/railway-deploy-guard.sh` + `scripts/service-guard.mjs` enforce; the 2026-06-27 cross-project deploy incident) |
| Any read path or dashboard surface touched | Tier isolation is an app-code invariant (no RLS): route through the `lib/auth/visibility.ts` choke point; guard test `test/guards/dashboard-tier-filter.test.ts` |
| Any sync-protocol/API change | Pinned contract `../aios-workspace/docs/brain-api.md` — versioned bump there first |
| Adding a column to an existing table | `postgres/migrations/` (alter) AND mirror into `postgres/schema.sql` (from-zero) — editing create-table alone is a prod no-op |
| Editing any `.claude/skills/<name>/SKILL.md` | If the skill is published to other runtimes, re-run `npm run check:skills:fix` in the same change — `.agents/`, `.opencode/`, `.cursor/rules/` are generated copies (guard: `test/guards/skill-runtime-sync.test.ts` + pre-push) |
| Writing any test | Spec-first, never characterization-first; pick the tier by failure mode (unit / data-mechanics / integration / eval — CLAUDE.md §4) |
| AIOS-internal PM/board work | `aios-linear` (global skill) — Linear is the canonical board used to build AIOS; do not dual-write AIO issues to Plane. The `lib/pm-sync` Plane adapter remains a supported product integration for customer teams and must not be removed or disabled under this board-policy rule. |

## Functional Areas

| Trigger | Skill |
|---|---|
| Admin/ops tasks on the brain instance | `.claude/skills/admin/SKILL.md` |
| Branches diverged / reconcile a fork | `.claude/skills/branch-reconciliation/SKILL.md` |
| "Is this test actually wired into CI" | `.claude/skills/test-ci-wiring-audit/SKILL.md` |
| Building a feature slice end-to-end ("build the next phase/slice", dual adversarial reviews) | `.claude/skills/adversarial-build/SKILL.md` — its steps 2–5 satisfy the Review gate; don't stack the attestation protocol on top |
| About to push a PR branch / "did this get reviewed" / attest a PR | `.claude/skills/pr-review-attestation/SKILL.md` |
| Just merged to main / "did the deploy go out" / check Railway | `.claude/skills/railway-deploy-verify/SKILL.md` |
| PM projection questions (brain→Linear) | `lib/pm-sync/` — the brain's tasks table is canonical, projection is one-way; reconcile reads live status surface-only |

## Agent Roles

| Need | Agent |
|---|---|
| (never auto-selected) | `.claude/agents/code-reviewer.md` — plain diffs → built-in `code-review`; see the workspace resolver's review arbitration |

## Disambiguation

1. Most-specific scope wins; ties break project local > global > plugin > built-in.
2. Persistence/access bugs → data-mechanics tier (real Postgres), never the FakeSupabase shape tier — a stubbed-model green is false confidence for a data-pipeline change.
3. A claim is real only when a red test reproduces the observable outcome; audits and AI-suggested bugs are hypotheses to re-derive.
4. Guards are built reactively — each must trace to a real bug or contract (CLAUDE.md §7); don't add ceremony guards.
