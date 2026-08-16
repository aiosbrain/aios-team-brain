# Background / reconnectable query stream (QBGSTREAM-1)

Status: **approved — building Option A′** · Owner: chetan
· Tier build-with: data-mechanics (persistence) + integration (reconnect) + unit (pure staleness logic)

**Deps:** none — QSTREAMRETRY-1 (PR #556, the answer-stream retry) is already merged to `main` and this
branch cuts from it; nothing else must land first.

**Increment:** ONE PR = Option A′ only (survival + persistence + reattach-by-poll). Option B (live
token reattach via an in-memory broker + a new SSE endpoint) is explicitly deferred to a sibling spec,
as is anything listed under "Scope → Out" below.

## Problem (reported)

> "If I run a query and click to another tab, when I come back the query job has died.
> It should keep running in the background and I should see the output when I click back."

## Current state (verified in the merged tree — corrected after plan review)

- The nav is a client-side App Router route change (`components/team-nav.tsx` `<Link>`). Leaving
  `/query` unmounts `ChatWorkspace` → `QueryChat`. **But there is no `AbortController`** wired to
  unmount (`components/query-chat.tsx` — none), so an in-app nav does **not** cancel the `fetch`:
  the `ask()` closure survives unmount, the orphaned reader keeps pumping (`query-chat.tsx:195-211`),
  the server never sees a disconnect, and the `done` branch persists the answer. **So for the
  literal "clicked another tab" case, the turn already runs to completion and persists today —
  what's broken is R2 (nothing reattaches on return), not survival.**
- The genuine death cases are **tab close / reload / real network drop**: there the socket closes,
  and because `send("done")` runs *before* the persistence block (`app/api/dashboard/query/route.ts` done branch), a failed
  `controller.enqueue` after disconnect throws and **skips all persistence — including the
  `query_log` row**. So a disconnected-before-done turn is **under-billed today** (real provider
  spend, no ledger row). That's a latent bug this work should also close.
- The assistant message is written only after the stream completes, via the single writer
  `lib/chat/store.appendMessage` (an INSERT). The **user** message is persisted *before* streaming
  (`app/api/dashboard/query/route.ts`, the user-message write), so "nothing persisted on failure" is wrong — what's missing on failure is a
  **failure record** (status + sanitized message) and the `query_log`/`recordLlmUsage` row.
- There is **no in-flight status, no partial-delta persistence, no reconnectable stream**.
  `chat_messages.content` carries a **stored generated tsvector + GIN index**
  (`postgres/schema.sql` ~2516-2530), so flushing partials into `content` would churn the FTS index
  on every flush.
- The `/query` page (`components/chat/chat-workspace.tsx:44-47`) holds `activeId`/`seed` purely in
  client state and reopens a fresh `new-0` on every mount — it never reattaches the in-flight thread.
  (The Home embed's `persistKey` restores the *completed* thread, but not live progress, and `/query`
  doesn't use it.)

Net: **survival is ~half-true today (nav yes, close/drop no); visibility-on-return is fully broken;
and close/drop turns silently under-bill.**

## Requirements

- R1 (survive): a started query must complete + persist regardless of the client (nav, tab close,
  reload, or network drop).
- R2 (visible on return): returning to `/query` shows the in-flight turn — the initiating tab keeps
  **live token streaming**; a returning/other tab shows progress (≤~1s granularity) without a click.
- R3 (exactly-once / no leak): reconnect never re-runs the LLM, never double-counts `query_log`/cost,
  never double-persists, and never bypasses tier isolation.
- R4 (failure is legible): a turn that failed — including one killed by a deploy/restart mid-run —
  shows as failed on return, never an eternal spinner.

## Design spine — **A′** (adopted after plan review; supersedes the earlier "quick-return POST")

The earlier draft had the POST return immediately and make *everyone* poll — which would have
**regressed the foreground tab from live SSE to 1s polling**. A′ avoids that: decouple
**persistence/completion from the client connection**, not generation from the request.

1. **Keep the SSE response bound to the initiating request** — the foreground tab keeps
   token-by-token streaming exactly as today.
2. **Make the server task disconnect-tolerant.** Track cancellation via the `ReadableStream`
   `cancel()` callback and make `send()` a **no-op after cancel** instead of letting
   `controller.enqueue` throw. The `start()` async task keeps running after a client disconnect on
   Railway's long-running Node server, so the loop runs to completion and persists. (This assumption
   is load-bearing — see Risks — and must be stated in a code comment, *including what breaks on
   serverless self-hosts*.)
3. **Move persistence out of the enqueue blast radius**, so `appendMessage`/`query_log`/
   `recordLlmUsage` cannot be skipped by a failed `send`. This alone fixes the under-billing bug.
4. **Persist in-flight state in a new `chat_turn_runs` table** (NOT columns on `chat_messages` — see
   below), heartbeat-flushed from inside the same loop: `status` (`streaming|done|error`),
   `partial_text`, `updated_at`, `final_message_id`, owner scope, `conversation_id`.
5. **Reattach on return by polling the run row** (light: status + partial + `updated_at`), not the
   full thread. A returning/other tab renders the partial until `status != streaming`.

### Why `chat_turn_runs`, not columns on `chat_messages` (plan review MEDIUM-4)

- `chat_messages.content` has a **stored generated tsvector + GIN index** — flushing partials into it
  churns the FTS index every ~1s.
- A partial assistant **row** in `chat_messages` would be mis-read as a completed turn by
  `recentTurns` (`store.ts:204-215`, feeds the LLM memory window) and `messagesToExchanges`
  (`query-chat.tsx:38-45`, renders as done). A separate table keeps both correct by construction.

### The partial→final transition (plan review HIGH-3) — pinned

- **Write order:** on completion, INSERT the final assistant message via `appendMessage` FIRST, then
  set the run to `done` with `final_message_id` pointing at it (ideally one transaction).
- **Reader precedence:** a final assistant message for the turn ALWAYS wins over the run's partial —
  so a crash between the two writes shows the good answer, never partial-beside-final.
- **Inverse criterion (falsifier):** after `done`, exactly ONE assistant rendering exists for the turn.

### Staleness (plan review HIGH-2) — required, or A′ violates its own R4

`maxDuration=120` is a **platform hint**; self-hosted `next start` on Railway does not enforce it and
won't kill a detached task at 120s. The real killer is a **process restart** — and deploys happen on
every merge to `main` (CLAUDE.md §6). A task killed mid-run leaves `status='streaming'` forever, so:

- **Heartbeat:** bump `updated_at` on every flush.
- **Staleness threshold:** a reader/poller treats a `streaming` run with `updated_at` older than the
  threshold as **failed** (and a sweeper may mark it — precedent: `lib/jobs/store.reclaimStaleJobs`).

## Access / correctness (R3)

- Reattach reads go through the existing owner-scope (`getConversation` / the run row keyed by
  `(team_id, member_id)`); a persisted partial is the current turn's own answer, generated under the
  caller's `enforce` set. The background task must **capture the `enforce` set at POST time and never
  recompute it mid-run**.
- Persist the **sanitized** `clientErrorMessage(e)` as the run's error text (log the raw server-side),
  so the QSTREAMRETRY-1 sanitization isn't undone via the replay path (plan review MEDIUM-5).
- `query_log`/`recordLlmUsage` fire **exactly once**, in the (now disconnect-safe) completion block.
  Budget/rate-limit checks stay at POST time. Reattach is read-only → no re-run path.
- Concurrent same-conversation POSTs can still interleave `recentTurns` pairing (exists today,
  slightly widened by auto-reattach) — either 409-on-active-run or accept with a noted caveat.

## Reattach trigger (open question 3 → resolved)

Server-side, not localStorage: the conversations list (or a tiny "active run" endpoint) returns a
`streaming` flag; `/query` auto-opens a thread **only when a run is actually streaming** (preserves
new-chat-on-open UX, works cross-device, and covers a user who navigated away before the conversation
id ever reached client state).

## Scope

- **In:** the dashboard path (`app/api/dashboard/query/route.ts`) + `/query` UI + the runs table.
- **Out (stated, per plan review MEDIUM-8):** `app/api/v1/query` (machine callers hold their own
  connection; delegated agent turns are stateless by design) and the `/sync` command
  (`syncResponse`) — both use the same channel but are not this feature.

## Schema mechanics

A brand-new `chat_turn_runs` table needs **no migration** — `create table if not exists` in
`postgres/schema.sql` covers from-zero (CLAUDE.md §6). Update the `<!-- drift:tables -->` block in
`docs/ARCHITECTURE.md` in the same PR; the replay-from-zero guard is satisfied by the idempotent table.

## THE FORK (owner decides)

- **Recommended: A′ now, B later.** A′ fixes the literal complaint end-to-end (foreground stays live;
  returning tabs see progress at ~1s; close/drop turns survive, persist, and stop under-billing) with
  no broker and no second streaming endpoint. **Option B** — a live token *reattach* for a returning
  tab via an in-memory pub/sub broker + a new `GET …/stream` SSE endpoint — is a polish layer on top
  of A′'s persistence (B ⊃ A′: the broker is lost on restart, so it still needs A′'s DB backstop). It
  adds subscriber-lifecycle/backpressure/GC and a second tier-gated endpoint for a "watch it stream
  live on return" nicety that A′'s 1s poll approximates.
- **Alternative:** straight to B (skip the incremental slice). Not recommended.
- **Fallback if A′ stalls:** an **R2-only** slice (reattach + poll of the already-persisted result)
  delivers most of the visible-on-return win, since nav turns already persist today.

## Acceptance criteria

Each criterion names the tier and the observable it is checked by. A builder can self-verify against
these without reading the prose above.

1. **data-mechanics** — `chat_turn_runs` row is created `streaming` at POST and flips to `done` with a
   non-null `final_message_id` once the answer completes, in that order (final message row exists
   before the flip).
2. **data-mechanics** — `lib/query/stream-persist.ts` writes exactly ONE assistant `chat_messages` row
   and ONE `query_log` row per turn, even when the client disconnects mid-stream (R1 + the
   under-billing fix): simulate a cancelled `ReadableStream` and assert both rows exist exactly once.
3. **unit** — `isRunStale(run, now)` in `lib/query/turn-runs.ts` returns true for a `streaming` run whose
   `updated_at` is older than the staleness threshold and false otherwise (R4: a deploy-killed run must
   read as failed, never an eternal spinner).
4. **data-mechanics** — `recentTurns` (`lib/chat/store.ts`) NEVER returns a partial: a conversation with
   an in-flight run yields only completed user→assistant pairs, so a half-answer can't enter the LLM
   memory window.
5. **unit** — the persisted run error text equals `clientErrorMessage(err)` and contains neither the
   model name nor the base URL (the QSTREAMRETRY-1 sanitization must not be undone via the replay path).
6. **integration** — `GET /api/dashboard/conversations/:id/run` returns the active run (status, partial,
   updated_at) for its owner and 403/404 for a non-owner, and never returns another member's run.
7. **data-mechanics** — a reattach read performs NO model call and writes NO second `query_log` /
   `llm_usage` row (R3: reconnect is strictly read-only).
8. **integration** — with `chat_turn_runs` present, the existing `/api/dashboard/query` SSE contract is
   byte-identical for the foreground tab (same `conversation`/`delta`/`sources`/`done` frames, same
   order) — the live-streaming path must not regress.
9. **unit** — `postgres/schema.sql` loads from zero and re-loads idempotently with the new table
   (`create table if not exists`), and `docs/ARCHITECTURE.md`'s `<!-- drift:tables -->` block lists
   `chat_turn_runs` (`npm run check:docs` passes).

## What would falsify the design

- A query completes while backgrounded (nav OR tab-close) but is NOT persisted → R1.
- A close/drop turn still lands no `query_log`/`recordLlmUsage` row (under-bill persists) → R1/ledger.
- Returning to `/query` shows a blank composer for an in-flight/just-finished turn → R2.
- The initiating tab loses first-token latency vs. today (foreground regression) → R2.
- A deploy/restart mid-turn leaves an eternal spinner on return → R4.
- After `done`, two assistant renderings (partial beside final) exist → HIGH-3 transition.
- Reattach re-runs the LLM or writes a second `query_log`/message row → R3.
- A reconnected partial shows content the principal can't see on an enforcing team → R3/leak.
- A persisted error contains the model/base URL → sanitization undone.
- `recentTurns` includes a partial (half-answer fed to the memory window) → MEDIUM-4.
