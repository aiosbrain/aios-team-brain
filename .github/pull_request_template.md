## What & Why

<!-- One paragraph: what changed and why. -->

## Work item

<!-- Link this PR to a Plane item so aios-work-sync closes it on merge. -->
AIOS-Work: <!-- e.g. AIOS-123 -->

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
