# Changelog

All notable changes to AIOS Team Brain are documented here. Dates are ISO-8601.

The Brain API sync contract (`docs/brain-api.md` in aios-workspace) is versioned
separately; it remains **v1** for this release. `ce_band` is an additive **v1.3**
field on the existing `POST /api/v1/metrics` endpoint.

## [Unreleased]

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
