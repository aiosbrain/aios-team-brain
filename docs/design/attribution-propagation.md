# Attribution propagation — a re-association percolates everywhere, immediately

**Status:** design. **Grounds:** the question "if we change who's associated with a piece of context
(a Slack-handle mapping, an NL correction, …), does ownership percolate through the context layer and
do arcs recompute?" Answer today: **partially, and with a lag.** This closes both gaps.

## Today (measured in code)

- **One shared resolver** already drives attribution everywhere (`lib/attribution/resolve-authors`,
  `lib/ingest/reattribute`). Arcs read `items.member_id` **fresh at synthesis** (not from the graph), so
  a re-attribution needs **no graph re-projection** — the next synthesis reflects it.
- **But a mapping change doesn't auto-propagate.** `linkMemberIdentity` / `setMemberIdentity` /
  `addMemberEmail` / `removeMemberEmail` / `unlinkMemberIdentity` / `linkMemberGithub`
  (`app/t/[team]/admin/members/actions.ts`) only `revalidatePath` — they do **not** call
  `reattributeItems`. Propagation is the **manual** "Re-attribute content" button.
- **And arcs lag.** `arc_cache` (Postgres, 4h TTL + in-memory front, `lib/graph/arcs.ts` `cache`) is
  **not invalidated** when `member_id` changes. Even after a re-attribution, the Learning panel shows
  the old arcs until the SWR TTL lapses (≤4h) or a manual recompute.

## Prerequisite — a durable authority marker (`items.member_id_locked`)

Auto-`reattributeItems` re-resolves every item from frontmatter and re-points whenever the resolved
member differs — with **no knowledge of a deliberate correction**. Turning that on unconditionally would
make any unrelated mapping edit silently **revert a prior NL correction** (or refill a "correct-to-nobody")
— the exact revert class the unchanged-repush heal already forbids. So corrections need durability first:

- **New column `items.member_id_locked boolean not null default false`** (migration delta + `schema.sql`
  mirror). Set `true` by `applyAttributionCorrection` (both reassign-to-member and clear-to-nobody).
- **`reattributeItems` skips locked rows**; the **unchanged-repush heal** (`lib/ingest/index.ts`) skips
  them too (its null→member fill must not refill a deliberate "nobody"). This is the `attribution_source:
  manual|resolved` authority marker promised in `attribution-architecture.md §9` — it also closes that
  doc's "correct-to-nobody can be refilled" gap.

## Design — one reconcile primitive, hooked onto every re-association

**`reconcileAttribution(db, teamId)`** (new, in `lib/ingest` — it drives an `items` write via the
single-writer batch):
1. `reattributeItems(db, teamId)` — re-resolve every item's `member_id` from current mappings (existing,
   conservative: only re-points to a positively-resolved member, never erases a resolved human).
2. `staleArcCache(db, teamId)` — mark the team's arc_cache **stale**, so the next Learning view serves the
   stale-but-real arcs immediately AND fires the background SWR recompute (which re-synthesizes with the
   fresh `member_id`).

**Hook it onto every association-changing surface**, run in `after()` so the admin action returns
snappily and the reconcile happens post-response:
- the six identity/email/github member actions above,
- the **NL correction box** (`applyAttributionCorrection` already writes `member_id` directly → after it,
  `staleArcCache` so arcs reflect the correction without the 4h wait; no `reattributeItems` needed
  there since the items are already re-pointed).

**`staleArcCache(db, teamId)`** (in `lib/graph/arc-cache`, the sole writer):
- Postgres: `update arc_cache set computed_at = $ts where team_id = $1` where **`$ts = now − (CACHE_TTL_MS
  + 60s)`** — i.e. **just past the TTL, NOT epoch.** `getArcs` treats it stale → serves the stale-but-real
  prior + fires the SWR recompute (which reads the fresh `member_id`); but `commitArcs` still sees a
  "recent" prior (≈11 min ≪ `EMPTY_CLOBBER_MAX_AGE_MS` 48 h), so if that recompute **hiccups and returns
  []** the real arcs are KEPT, not clobbered. Using epoch would trip the "prior too old → accept empty"
  branch and blank the panel on the very recompute we forced (the 2026-07 incident) — so TTL+ε, never epoch.
- In-memory: `evictArcMemoryCache(teamSlug)` (exported from `lib/graph/arcs`) deletes this process's `cache`
  Map entries for the team's group keys (keys are `${slug}_team`/`${slug}_external` joins), so it doesn't
  serve its warm copy.

**Concurrency + durability notes (in the code):**
- **Trailing-edge coalescer** per team around `reattributeItems`: if a reconcile is already running for a
  team, mark it dirty and run ONE more trailing pass — serializes the `items` writes (kills a stale-map
  snapshot race where a slow scan overwrites a newer scan's re-points) and collapses N rapid mapping edits
  to ≤2 scans.
- `after()` callbacks run without request context → use `adminClient()` inside (per `app/actions/tasks.ts`
  precedent). Non-durable across a mid-callback deploy/restart — acceptable: reconcile is idempotent and the
  manual "Re-attribute content" button remains the recovery path.
- **In-flight-refresh race (bounded, documented):** a background arc refresh already running when reconcile
  fires can `commitArcs` pre-correction arcs with a fresh timestamp, re-pinning them ≤4h; self-heals at
  the next TTL.

**Explicit exclusions (do NOT hook):**
- **Ingest-time provider auto-mapping** (`lib/ingest/run.ts` slack/plane/linear) — runs every ~30-min tick;
  reconciling there = a full-scan storm + max correction-revert exposure. The null→resolved case is already
  covered by the unchanged-repush heal on the next tick; wrong→right stays admin-triggered.
- **Unlink/remove-email asymmetry:** `reattributeItems` is conservative and never *un*-attributes, so
  hooking unlink only helps when the removal makes items resolve to a *different* member — it won't clear
  attribution. Noted so nobody expects unlink → unattributed.

## Consistency bound (honest)

The **persistent** `arc_cache` goes stale immediately → any instance doing a cold/expired read serves the
stale prior and background-recomputes with the fresh attribution on the next Learning view. The **only**
lag: another app instance whose *in-memory* cache is still warm serves its copy for up to its 4h TTL
(`evictArcMemoryCache` only clears the acting process). Full cross-instance consistency ≤4h; the
authoritative store and the acting instance are immediate. (A cross-instance bust — e.g. a `pg_notify`
channel the in-memory layer listens on — is a clean follow-up if the ≤4h tail ever matters; today the
self-host deployment is typically single-instance so the tail is usually zero.)

## Not in scope
- A synchronous "recompute now" (blocking the action on an LLM call) — the SWR recompute-on-next-view is
  the right cost/latency tradeoff; the action stays snappy.
- Re-projecting the graph — unnecessary (arc attribution derives from `items.member_id` live).

## Verification
- **data-mechanics (real Postgres):**
  - reconcile re-points `items.member_id` from a new mapping AND stales `arc_cache`: assert `computed_at`
    is **older than `CACHE_TTL_MS`** (so `getArcs` treats it stale) **and younger than
    `EMPTY_CLOBBER_MAX_AGE_MS`** (so an empty recompute keeps the prior) — a test asserting "epoch" would
    enshrine the blank-panel bug.
  - **the lock:** an NL correction sets `member_id_locked`; a subsequent `reattributeItems` (and an
    unchanged-repush heal) leaves that item's `member_id` untouched even though frontmatter resolves elsewhere.
- **unit:** `evictArcMemoryCache(teamSlug)` clears only that team's keys; `staleArcCache` best-effort (no throw).
- Migration replays from zero (`db:test:up`) so the new column exists in the test tier.

## Known limitation (conscious deferral) — the lock is one-way

`member_id_locked` is set by a correction and **never cleared** (unlink doesn't clear it; a re-correction
re-locks to the new value). So a broad correction ("everything under `notion/` → Bob") permanently opts
those items out of automatic re-attribution — even the manual "Re-attribute content" button skips them; the
only way to change them is another NL correction. Acceptable v1 semantics ("deliberate beats automatic"),
but it's a one-way door. Follow-up: a `revert-to-auto` correction kind (clears the lock so auto-attribution
resumes) when needed.
