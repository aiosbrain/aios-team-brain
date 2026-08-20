# Changelog

All notable changes to AIOS Team Brain are documented here. Dates are ISO-8601.

The Brain API sync contract (`docs/brain-api.md` in aios-workspace) is versioned
separately. The current member-facing major remains **v1**, at additive document
revision **v1.22**.

## [Unreleased]

### Changed

- **PRET-3 — every arcs panel is now the fused per-project panel.** External members and
  members of not-yet-flipped (permissive) teams are served the same per-partition fusion
  enforcing teams already had; the legacy single tier-row synthesis is retired. Two visible
  consequences: arc corrections can no longer target the external-shared partition (its
  synthesis is corrections-free — internal editorial prose never reaches client-visible arcs;
  the recompute endpoint returns 422 for it), and recomputes now always name a `sourceGroup`
  (stale clients get a 422 until the panel reloads). Existing tier-scoped corrections are
  migrated to the General partition automatically. Social discovery now mines the acting
  admin's own arc scope rather than the whole team tier.

- **PRET-2 — teams begin auto-flipping to per-project access enforcement.** A warning-free,
  converged team is now flipped to `enforcing` automatically by the scheduler (gated on the
  full readiness assessment; rate-limited; an operator's manual downgrade permanently holds a
  team out of auto-flip). **On flip day a team's Learning panel changes**: the single
  tier-wide narrative is replaced by the fused per-project arc panel — the accepted product
  change of the membership-is-the-access-model program
  (`docs/design/retire-permissive-model.md`). Teams with active connectors or unplaced agents
  are NOT auto-flipped: their warnings surface via the permission inspector and
  `admin.ts set-access-enforcement --dry-run`, and the flip stays a manual decision.

### Added

- **Coverage arrives with its denominator (AIO-995, Brain API 1.22).** `test_coverage_pct` was a
  bare percentage carrying 40% of `health_score` and 25% of `agentic_score`, so a repo measuring
  436 lines and one measuring 10,647 were indistinguishable in every composite. The scan payload
  gains six optional, nullable raw measures — `test_coverage_lines_total` /
  `test_coverage_lines_covered` (the denominator) and `tests_total` / `tests_passed` /
  `tests_skipped` / `tests_failed` (run integrity) — and the brain derives, persists and displays
  `coverage_breadth_pct`. Coverage now renders with its scope (`99% (436 / 3,140 lines)`), a
  narrow measurement is visually distinct, and a run with skipped or failed cases is flagged
  partial. **No score changes**: breadth is disclosed, not weighted, because every pre-1.22 row
  has a null denominator and a factor applied today would rank re-scanned repos against
  un-rescanned ones under two different formulas. Null means unknown throughout — never zero,
  never full scope.

- **Code Maintenance Loop Phase 0 (AIO-610)** — Brain API 1.17 accepts the backward-compatible
  codebase-health v2 snapshot with repository profile identity, explicit evidence completeness,
  fail-closed automation admission, and a redacted normalized finding ledger. V1 snapshots remain
  valid and Team Brain gains no repository-write authority.

## [0.10.0] — 2026-08-03

### Added

- **One-click Team Brain onboarding (AIO-445)** — the official Railway template provisions the
  app and Postgres together, collects team and first-admin details in Railway, generates the app
  secrets, and bootstraps a usable admin login on first start. `npm run setup` opens the stable
  `aiosbrain.dev` deploy front door without requiring a GitHub fork or local Railway CLI.

### Changed

- The shared onboarding contract is v3: Create now stops for deployment approval, opens the
  Railway template, and then resumes the same canonical-origin and `GET /api/v1/me` validation
  used by Join. Operator-supplied admin passwords are no longer printed in deployment logs.

## [0.9.0] — 2026-08-01

The Brain API contract is unchanged at **v1.15** — no member-facing route, shape,
or semantics changed after the 1.15 revision landed (#456).

### Added

- **Workspace-governance health ingest (brain-api 1.15, AIO-609, #456)** —
  `POST /api/v1/codebases` accepts an optional, provenance-only
  `metrics.codebase_health` object (scored scanner-side, persisted verbatim on
  `code_metrics.codebase_health`, never recomputed; sparse or malformed pushes
  are rejected 422). The codebase detail view surfaces the latest snapshot
  (score, status, measured_at). Deployed to production and live-verified; this
  is the same scanner-ingest endpoint that serves the workspace repo's
  scan-on-merge CI push (an anonymous-checkout, team-tier-key consumer).
- **Setup front door** — `npm run setup` is a real interview (#453), backed by a
  one-command local stack + `npm run doctor` preflight (#444) and agent-driven,
  provisioning-scoped Railway setup (#445). Connectors gained terminal status,
  forced verify, and a `/connect` skill (#447).
- **Cost visibility** — graph extraction + embeddings are metered (#437), the
  spend the ledger can't see is named instead of reported as an anonymous
  percentage (#450, #458, #463), and the cost window no longer fakes 30 days.
- **Meetings on push** — the meeting note is created when a transcript is
  pushed, not up to 30 minutes later on the next tick (#454), with
  push-triggered backfills traced to `ingest_runs` (#457).
- **Model administration** — a separate, save-time-validated model for graph
  extraction so the graph stops billing the answer model (#442, #452); the
  graph's LLM key lives only in the admin console (#425).
- **Plain-English timeline** — headline-first day summaries with no machine
  tokens (#435), and a one-screen Pulse snapshot (#440, #441).

### Changed

- **Review gate enforced** — the pre-push diff review attestation
  (`Reviewed by … — verdict …`) is now a required CI check
  (`pr-review-gate.yml`), not a remembered convention (#460, #462).
- Phantom connectors retired (sidecar GitHub, Drive watch, `wise`, Granola);
  README rewritten from the code — hosted-first setup order, per-step timings,
  and the Team Brain schematic (#421, #424, #431, #436, #448).

### Fixed

- **NDA hook chain (#459)** — the pre-commit guard is tracked in `.githooks/`
  and the NDA leak gate chains through `core.hooksPath`, so the policy hooks
  can no longer be silently clobbered or skipped.
- Re-running the provisioner rotated both secrets, logging the team out and
  orphaning every token (#451); `SECRETS_KEY` is warned about at boot and
  `doctor` accepts valid hex keys (#449).
- Graph extraction: the 120s proxy timeout killed long extractions (#438), and
  monitoring now detects extraction that *stopped*, not just extraction that
  never started (#423).
- Cache-backed routes report the row's real age, and degraded state has its own
  column instead of overloading `computed_at` (#426, #432).
- The LLM single-caller guard covers `.mjs` and stops flagging prose (#455);
  Notion/Drive/Confluence `fetch()` is proven without an account, fixing the
  TypeError it found (#439); personal Slack OAuth scopes aligned (#443); the
  ingest-health banner no longer cries wolf on a healthy 12h job (#434).

## [0.8.0] — 2026-07-28

### Added

- **Onboarding V2 connection validation** — `GET /api/v1/me` is the canonical
  proof that an approved Brain origin and API key belong to the expected member
  and team.
- **Expanded team context surfaces** — additive v1 contract capabilities for
  subscriptions, company graph, timeline, attribution, task-key lookup,
  transcript facts, and stakeholder mentions.

### Changed

- Workstation setup remains discoverable for new members and active teams without
  blocking access to Pulse. Personal and Create remain valid Workspace outcomes.
- A successful onboarding validation durably records API-key usage so setup
  completion survives navigation and later sessions.

### Fixed

- Ordinary API authentication stays available if non-critical usage telemetry
  fails; `/me` reports a persistence failure as a server error instead of a
  false invalid-key response.
- Architecture documentation now points at the landed Brain API v1.14 revision
  instead of calling it outstanding.

## [0.7.0] — 2026-07-04

Cognitive Ergonomics shadow band — ingest + dashboard (epic AIO-211, slices B3/B4).

### Added

- **`ce_band` column** on `agentic_maturity_snapshots` — optional integer `0`–`4`
  or `null`; persisted verbatim from client pushes; never recomputed server-side.
  (AIO-219)
- **Individual Maturity dashboard** — CE column on the people table, CE stat card
  on member deep-dive, dashed amber CE timeline (`connectNulls={false}` for honest
  gaps). Every CE element badged **shadow · uncalibrated**; CE excluded from radar,
  spine distribution, and team-axis rollups. Team-tier only. (AIO-220, #154)

### Changed

- **Display rename** — "Agentic Engineering Maturity (AEM)" → **Agentic Maturity
  (AM)** in dashboard copy. (AIO-221, coordinated with workspace/website)

## [0.5.0] — 2026-06-19

Prior tagged release (AEM individual metrics endpoint, codebase ingest, and related
dashboard surfaces). See git history between `v0.5.0` and `v0.7.0` for incremental
changes not listed here.
