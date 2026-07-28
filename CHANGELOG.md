# Changelog

All notable changes to AIOS Team Brain are documented here. Dates are ISO-8601.

The Brain API sync contract (`docs/brain-api.md` in aios-workspace) is versioned
separately. The current member-facing major remains **v1**, at additive document
revision **v1.14**.

## [Unreleased]

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
