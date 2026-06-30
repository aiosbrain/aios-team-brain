## What & Why

<!-- One paragraph: what changed and why. -->

## Work item

<!-- Reference the brain task so aios-work-sync advances it to Done on merge (brain → Linear).
     No task yet, and this work should be tracked? Create one FIRST in the Team Brain dashboard
     (→ Tasks; it projects to Linear), then put its key here. Don't hand-edit the Linear issue —
     the brain is the source of truth, Linear is a one-way projection. -->
AIOS-Work: <!-- e.g. AIO-72 -->

## Checklist

- [ ] `node scripts/check-docs-drift.mjs` passes locally (or no routes/tables/sources changed)
- [ ] Unit tests pass: `npm test`
- [ ] Datamechanics tests pass if persistence changed: `npm run test:datamechanics:local`
- [ ] Ingestion tests pass if Python changed: `cd ingestion && pytest -q`
- [ ] `brain-api.md` version bumped if sync protocol changed
- [ ] No secrets or admin-tier content in diff

## Bot review summary

<!-- After Bugbot + CodeRabbit post, paste a one-line summary of their findings here,
     or write "no blocking findings." Helps reviewers scan quickly. -->
