---
description: Run the full verification suite (lint, unit, docs-drift, real-Postgres data-mechanics)
---

Run the Team Brain verification suite and report results concisely. Stop and surface
the first failure with its output.

1. `npm run lint`
2. `npm run test` (unit tier — pure logic + drift/contract guards)
3. `npm run check:docs` (architecture-map drift guard)
4. `npm run db:test:up && npm run test:datamechanics` (real Postgres: persistence + tier
   isolation), then `npm run db:test:down`

Report pass/fail per step. If anything fails, show the failing test/output and propose a fix
before re-running. Do not claim "done" unless every step is green.
