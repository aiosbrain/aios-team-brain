# Transcript extraction contract v1 release evidence

Recorded: 2026-07-24

## Shared Brain API 1.12 contract

- JSON Schema SHA-256:
  `c380f811d20c0cfc0879c2b2d8299000b8f0eddfe0601581974c702f60415a28`
- Canonical fixture SHA-256:
  `9862e47581b9bdd68ecfd7aa92216011a6b56bc9dc7abaee3bd5e301240bfbea`
- Generated contract `contentHash`:
  `b9974f1381e490888b1063f57e34a22bd63c4b88009fe6a8bc4cf03e3cd9701b`
- Workspace and Team Brain schema/fixture copies are byte-identical (`cmp` exit 0).

## Persistence verification

- Fresh schema load: PASS
- Idempotent replay against the populated test schema: PASS
- Real-Postgres evidence mechanics: PASS
- Live-socket item API tests: PASS
- Strict JSON Schema/Zod fixture parity: PASS
- Company graph remained unchanged after stakeholder-mention ingestion: PASS
