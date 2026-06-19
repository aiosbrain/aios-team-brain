# Agentic Engineering Radar

The radar continuously mines the best practicing agentic engineers into the brain, then
curated insights are promoted to the public wiki. It is the freshness engine behind the
AEM pattern library (`agentic-engineering-maturity/` at the monorepo root, published at
`/agentic` on the website).

## Tiers — the public + team split

| Layer | Tier | Where | What |
|---|---|---|---|
| **Staging** | `team` | brain `items` (kind `artifact`, source `radar`) | Every new feed entry, raw + summarized. Internal only. |
| **Public wiki** | `external` | `aios-website/src/content/docs/agentic/reading.mdx` | Only *curated, approved* insights. A deliberate human/agent act. |

The radar ingestion source (`ingestion/aios_ingest/sources/radar.py`) **only ever writes
team tier**. It never produces `external`/`admin`. Promotion to the public wiki is a
separate, deliberate step — nothing reaches the public site automatically. This mirrors
the workspace spine philosophy: content is promoted, never auto-published.

## Pipeline

```
watchlist.json feeds (RSS/Atom · GitHub releases.atom · hnrss)
        │  aios-ingest schedule --config connections.yaml
        ▼
RadarSource.fetch → RawDoc(kind=artifact, access=team) → POST /api/v1/items
        │  (dedupe-safe by permalink → content sha256)
        ▼
brain `items` (team tier)  ── queryable via /api/v1/query, "what did the radar surface?"
        │  curation: human/agent reviews, scores actionability, maps to an AEM pattern
        ▼  (deliberate promotion)
aios-website /agentic/reading  (external tier, public)
```

## Run it

```bash
cd ingestion
uv pip install -e '.[radar]'                 # feedparser
cp connections.example.yaml connections.yaml # edit feeds / set AIOS_WATCHLIST_PATH
export BRAIN_URL=... AIOS_API_KEY=... AIOS_TEAM=...
aios-ingest backfill --source radar --opt watchlist_path=../../agentic-engineering-maturity/rubric/watchlist.json
# or run on a schedule (every 6h):
aios-ingest schedule --config connections.yaml --poll-interval 21600
```

## Promotion (staging → public)

Promotion is intentionally manual/curated — the radar's value is selection, not volume
(guarding against the "slopacalypse"). To promote an item:

1. Review the team-tier radar artifacts (dashboard or `aios query`).
2. For a keeper: write a one-line entry under the right section of
   `aios-website/src/content/docs/agentic/reading.mdx`, linking the source and noting the
   reusable technique (and which AEM pattern it informs).
3. If it's a genuinely new technique, also propose a pattern addition to
   `agentic-engineering-maturity/01-pattern-library.md` (canonical) — the website mirrors it.

The root `/docs-sync` skill audits that the public wiki hasn't drifted from the canonical
framework.
