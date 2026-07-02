# Design docs

Architecture and design documents for non-trivial features — written **before** (or alongside) the
build so the approach, alternatives, and trade-offs are recorded and reviewable. These are living
design records, distinct from:

- `docs/ARCHITECTURE.md` — the current-state map of what's built (source of truth, drift-guarded).
- `docs/TODO.md` — consciously-deferred work with rationale.

Add a doc here when a feature warrants an architecture decision (new subsystem, data model, external
dependency, cross-cutting change). Keep it grounded in the code; when the feature ships, fold the
durable parts into `ARCHITECTURE.md` and leave the design doc as the "why we built it this way" record.

## Index
- **[context-layer-roadmap.md](./context-layer-roadmap.md)** — the original context-layer vision vs.
  what's built, and the plan to close the gaps (faceted grouping, tiered memory).
- **[brain-learning-panel.md](./brain-learning-panel.md)** — "What the Brain is Learning" 3-layer
  panel (atomic facts → events → narrative arcs), sourced from Graphiti via direct Neo4j Cypher.
