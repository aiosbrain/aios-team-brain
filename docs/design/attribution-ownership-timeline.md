# Attribution ownership timeline — handoff vs. mislabel

**Status:** transition-log BUILT; windowed-credit consumer = follow-up. **Grounds:** an item's owner can
change for two very different reasons, and a future "credit each owner for their window" feature must not
treat them alike:

- **Handoff** — A really did early work, then B took over. Both windows are real; both deserve credit.
- **Mislabel** — it was *never* A's (a wrong auto-assignment, a bulk-import mistake). A's window is noise;
  crediting A would be wrong.

The source event is **ambiguous** (Linear just says "assignee changed"). We don't classify at write time —
we record the observable facts richly enough that the consumer (or a human) can decide.

## The transition stream — `item.reassigned` (audit_log)

Every ownership change from one real member to a different target emits ONE uniform, per-item, timestamped
`item.reassigned` audit event (`lib/ingest/reassignment-log.ts`), whatever the cause. `meta`:

```
{ from, to, source, via, from_owned_since? }
```

`via` is the classifier:

| `via` | Cause | Leaning | `from_owned_since` |
|---|---|---|---|
| `author_signal` | SOURCE reassignment — the frontmatter author/assignee moved (Linear/Plane; heals on the unchanged re-push and re-points, `decideReattribution`) | **handoff** (A may have real tenure) | set |
| `pusher_default` | A different key re-pushed with no author signal → attributed to the pusher (collaborative takeover) | neutral | set |
| `correction` | An admin mislabel-fix (`applyAttributionCorrection` + the durable `items.member_id_locked` flag) — authoritative "A was never really it" | **mislabel** (window void) | omitted (void) |

`from_owned_since` = when the outgoing owner's window began — the most recent prior ownership-establishing
audit event for the item (`item.created` / `item.reassigned` / `item.attribution_healed`). So each source
transition self-describes the outgoing owner's window `[from_owned_since, created_at]` — enough for tenure +
the short-tenure heuristic without an external join. **Best-effort, and the error direction is known:** an
*un-audited* `member_id` change (e.g. the `reattributeItems` batch) makes `from_owned_since` too *early* —
it can only OVERSTATE tenure (lean toward HANDOFF/credit), never understate it. Treat it as a soft upper
bound on tenure, not a hard lower bound on the window start; the **evidence gate** (rule 3) is what actually
prevents phantom credit, so a slightly-too-early `from_owned_since` never causes a wrong credit on its own.

Two related events on the same stream, deliberately NOT `item.reassigned`:
- `item.attribution_healed` (`{to, source}`) — a `null→member` FIRST attribution (a fill, not a reassignment).
- `attribution.corrected` (`{plan, updated, reassigned, target}`) — the correction's plan-level summary; the
  per-item transitions it caused are the `via: correction` rows above.

## The classification rule (for the windowed-credit consumer)

Do NOT credit by label. **Credit by evidence, gated, with corrections as a hard void:**

1. **Reconstruct** each item's owner windows from `item.created` (initial owner) + the ordered
   `item.reassigned` stream. Each `from` owned `[window_start, transition_time]`.
2. **Void mislabels explicitly:** a window ended by a `via: correction` transition (or on a currently
   `member_id_locked` item) is a human-asserted mislabel → **no credit** for that window.
3. **Evidence-gate the rest:** credit a window only if the owner has corroborating work-artifacts *inside* it
   (a comment, commit, status transition, or linked item attributed to them during the window). A mislabel
   leaves no evidence → contributes nothing automatically; a genuine handoff does. This is the robust core —
   it depends on the presence of real work, not on classifying the reassignment perfectly.
4. **Short-tenure heuristic (cheap prior):** an A→B transition within a small window of A becoming owner,
   with no intervening activity, is *likely* a mislabel — down-weight/skip A's window and, if ambiguous,
   surface it in the Admin → Attribution drill-down (the existing human-adjudication surface; its `mismatch`
   badge already flags current drift).

## First consumer — BUILT: evidence-gated arc participants

`lib/attribution/contributor-credit.resolveContributorsByItem` implements rules 1–3 above over
**`item_versions`** (each body change = a unit of work, attributed to the then-resolved author — a work-time
ledger, no sync-vs-work-time reconciliation needed): an item's contributors = its distinct non-connector
version authors (unlocked), collapsing to the corrected owner when `member_id_locked`. Wired into narrative-arc
**`participants`** (`lib/graph/arcs.ts`) so a prior contributor whose item was reassigned away is still on the
chip — the `narrative-arcs-representation` fix. `item_versions` naturally starves mislabels (an assigned-but-
never-worked owner leaves no version) without needing to read the `item.reassigned` stream.

## Out of scope (follow-ups)
- **Per-contributor fact BALANCING** (not just participants): a reassigned-away contributor's facts still
  balance under the current owner, so they appear as a co-participant but don't yet get their own balanced
  arc share. Next increment.
- Consuming the `item.reassigned` stream + `from_owned_since` directly (the version ledger covers the arc
  case; the transition stream matters for finer window boundaries + the short-tenure heuristic).
- **Heal `item_versions.member_id` on a re-point/heal.** A heal/source-re-point updates `items.member_id`
  but writes no new version and no lock, so a stale/mis-resolved version author (e.g. a doc pushed via the
  wrong key pre-#329) keeps its old `member_id`. Version-based credit then credits that stale author over
  the healed owner (the inverse of the bug this fixes). Today the admin **lock** (a correction) is the
  override; the durable fix is to re-point the matching `item_versions.member_id` rows when
  `decideReattribution` re-points, so the work ledger tracks the corrected author.
- The exact source-event timestamp (we use the sync-time `created_at`; a source history API would sharpen
  `from_owned_since`).
