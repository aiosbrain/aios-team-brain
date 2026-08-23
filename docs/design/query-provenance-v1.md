---
eval_tier: deterministic
spec_gate: block
safety: false
type: issue-spec
status: DECLINED
---

> # ⛔ DECLINED — do not build this
>
> **QPROV-1 (AIO-1052) was declined in spec review on 2026-08-22 and is retained only as the record
> of why.** Two adversarial rounds established that conversation-creation provenance cannot deliver
> the property it promises: an agent holding a member-scoped key can `GET /api/v1/conversations`,
> take a `dashboard` thread's id, and pass it to `POST /api/v1/query` — appending its question to a
> human thread and bumping it to the top of the list. Two documented API calls defeat the whole
> design, and the filter added to make it work is what enables the enumeration.
>
> The slice that replaced it is **AGENTUI-1** (`docs/design/agent-tokens-admin-ui-v1.md`): a
> delegated principal is conversation-stateless, so agent traffic creates no threads at all and
> there is nothing to filter.
>
> Everything below is the declined design, left unedited. Do not implement it.

# Query provenance — the Query tab shows what a human typed, not what an agent asked

## What / why

`app/api/v1/query/route.ts` creates a conversation whenever the request's API key is
member-scoped. `aios query "…"` uses exactly that key, so every query an agent runs from a
terminal is written into that member's dashboard chat history and rendered by the Query tab as
though the member had typed it. Nothing distinguishes the two: `conversations` carries no
provenance at all.

Measured in prod (read-only, 2026-08-22): **62 threads — Chetan 39, John Ellison 20, Stephan
Ledain 3**. Chetan's list is visibly dominated by agent close-gate reads — `what is the status of
AUDITFIX-4`, `what does the AUDITFIX-6 ruling say about sweeps and human curation`, `status of
task ENFB-3`, `status of task REVOKE-1` — none of which were typed into the dashboard. That is the
report this slice answers.

**Existing rows cannot be classified retroactively, and the spec does not pretend otherwise.**
`chat_turn_runs` is written only by the dashboard path (`createRun`, called from
`app/api/dashboard/query/route.ts`) and would be a perfect discriminator — except it shipped on
2026-08-16 (#559), so only **4 of the 62** rows have one. Inferring provenance from its absence
would relabel every pre-08-16 human thread as agent traffic, including all 20 of John's. So the
backfill value is `unknown`, and `unknown` stays VISIBLE.

## Outcomes

- A member opening the Query tab sees NEWLY created threads only from where they typed them; agent
  traffic created after this ships never appears. Threads that already exist are unaffected — see
  the backlog note below, which is a real limit of this slice, not a hidden one.
- Every conversation created from now on records which channel created it.
- No existing thread disappears from anyone's history when this ships.
- Agent queries keep being persisted and keep being attributed for cost — they are hidden from one
  reading surface, not discarded.

## Interface / integration points

- `postgres/schema.sql` — the `conversations` table (`id, team_id, member_id, title, created_at,
  updated_at, archived_at`) gains one column; mirrored for from-zero replay.
- `postgres/migrations/README.md` — the additive-delta convention this follows: editing a
  `create table if not exists` body is a no-op on a DB that already has the table, so the column
  must arrive as an `alter table … add column if not exists` migration AND be mirrored into
  `schema.sql`.
- `lib/chat/store.ts` — the SOLE writer of `conversations` (pinned by
  `test/guards/single-writer-chat.test.ts`). `createConversation` gains a required source argument;
  `listConversations` and `searchConversations` gain a required `visibleTo` argument. The filter is
  CALLER-SELECTED, never baked into the function — see the contract below for why.
- `app/api/dashboard/query/route.ts` — the session-authenticated write path (a human typing in the
  Query tab). Calls `createConversation` at one site.
- `app/api/v1/query/route.ts` — the API-key write path (`aios query`, and Telegram-via-Hermes).
  Calls `createConversation` at one site. Delegated `aiosd_` tokens are already stateless here and
  create nothing, which this slice must not change.
- `app/api/dashboard/conversations/route.ts` — the Query tab's list/search reader; the surface the
  report is about.
- `app/api/v1/conversations/route.ts` — the API's own list reader; passes `visibleTo: "all"` so the
  CLI/Hermes can still list and resume the threads they created. It calls the SAME
  `listConversations` as the dashboard, which is why the filter must be a parameter.
- `lib/api/auth.ts` — `authenticateApiKey` / `authenticateAgentToken` / `isAgentBearer`, which is
  what makes the two write paths distinguishable at all.
- `lib/query/turn-runs.ts` — `createRun`, the dashboard-only marker whose ship date (#559) is the
  evidence that retroactive classification is impossible.
- `docs/ARCHITECTURE.md` — the Chat-history row (~line 111) states the cross-interface promise this
  slice narrows; hand-maintained, NOT machine-guarded (see below), so updating it is on us.
- `docs/CHAT-CLIENTS.md` — states the same promise in its opening paragraph; must be amended.
- `scripts/check-docs-drift.mjs` — `deriveTables()` (line 50) extracts `create table` NAMES only, and
  the block's accept regex rejects a dotted `table.column`. So `check:docs` can NOT enforce a new
  COLUMN, and this spec does not pretend it can — an earlier draft claimed exactly that and the
  criterion built on it would have enforced nothing.

## New files to create

Every path below is created by this slice; none exists yet.

- new file: `postgres/migrations/20260822120000_conversations_source.sql` — adds the column.
- new file: `test/datamechanics/conversation-source.datamechanics.test.ts` — real-Postgres tier,
  persistence + the visibility filter in both directions.
- new file: `test/guards/conversation-source-writers.test.ts` — unit tier, the writer/reader guard.

## Contracts, named before implementation

```ts
/** The CHANNEL that created the conversation. Deliberately not a human/agent judgment. */
export type ConversationSource = "dashboard" | "api" | "unknown";

/** Sources the DASHBOARD Query tab renders. `unknown` is included: pre-migration rows are
 *  unclassifiable, and hiding them would delete visible history. */
export const HUMAN_VISIBLE_SOURCES: readonly ConversationSource[] = ["dashboard", "unknown"];

/** WHICH reader wants which set. Required, no default — a new reader must choose deliberately,
 *  and a compile error is the only thing that reliably makes that happen. */
export type ConversationVisibility = "human" | "all";

export async function createConversation(
  db: DbClient,
  owner: Owner,
  title: string,
  source: ConversationSource   // REQUIRED — no default, so a new call site cannot omit it
): Promise<{ id: string } | null>;

export async function listConversations(
  db: DbClient, owner: Owner, visibleTo: ConversationVisibility, limit?: number
): Promise<Conversation[]>;

export async function searchConversations(
  db: DbClient, owner: Owner, query: string, visibleTo: ConversationVisibility, limit?: number
): Promise<Conversation[]>;
```

**The filter is a PARAMETER, not a property of the store function — this is the defect that killed
the first draft.** `app/api/v1/conversations/route.ts` calls the same `listConversations` as the
dashboard. A filter baked into the function would have silently stripped every `api` thread from the
API's own list, so the CLI could no longer list the threads it just created — breaking the documented
resume flow while the spec claimed that reader was "deliberately left unfiltered". Both reviewers
caught it independently; it could not have been true as written.

Storage: `conversations.source text not null default 'unknown' check (source in ('dashboard','api','unknown'))`.

Text + `check` rather than a Postgres enum, matching the `teams.answering_provider` precedent in
`postgres/schema.sql`: the value set will grow (telegram, mcp, cron are all plausible), an enum
value can never be dropped, and this repo has been bitten twice by enum/constraint narrowing during
`pg:schema` replay.

**`source` records the channel, not an inference about who was typing.** The product rule is
narrow and honest: the Query tab shows what was typed INTO the Query tab.

**This DOES narrow a documented promise, and the narrowing is deliberate.** Three places state that
threads created via the API show up in the member's web sidebar — `lib/chat/store.ts` (the module
docstring: "the same history shows up across sessions and interfaces (web, mobile, CLI,
Telegram/Hermes)"), `docs/CHAT-CLIENTS.md` (opening paragraph), and `docs/ARCHITECTURE.md`. All
three are amended in this PR; leaving them would make the docs lie.

Why the narrowing is safe TODAY, measured rather than assumed:

- **Telegram-via-Hermes is not built.** `docs/CHAT-CLIENTS.md` says the server side is done and
  "what remains is the client side"; there is no Telegram implementation anywhere in this repo.
- **The CLI never resumes a thread.** `aios query` calls `streamQuery(question, null, …)` — it
  passes `null` for `conversation_id` on every call, so it has never continued a thread.
- **Nothing is exercising cross-interface resume.** 57 of the 62 prod conversations are single-turn;
  the 5 multi-turn ones are dashboard chats.

So the promise being narrowed has no live client. What this slice preserves is the MECHANISM:
`/api/v1/conversations` still returns `api` threads, so a future Telegram client can list and resume
them. What it loses is dashboard-sidebar visibility for those threads — which is precisely what was
reported as the bug.

**When Telegram does ship, the fix is one line**, and it is why `text + check` was chosen over an
enum: Hermes declares `source: "telegram"`, and `telegram` joins `HUMAN_VISIBLE_SOURCES`. Treating a
declared channel as a display tag is legitimate — visibility here is UX, not authorization, and a
lying client can only mislabel its own key-owner's list. The earlier draft dismissed that option on
a trust-boundary argument that does not apply, and that dismissal was wrong.

## Dependencies

Depends on: none. Self-contained in `aios-team-brain`; no AIOS CLI change, and `aios query` keeps
working byte-identically — its threads simply stop appearing in the dashboard list.

## Scope

**This is one reviewable PR.** One column, two write sites that set it, two read sites (list and
search) that filter on it, plus the schema/docs/tests that go with it.

**In:**

- `conversations.source` (migration + `schema.sql` mirror), defaulting to `unknown`.
- `createConversation` takes `source` as a REQUIRED argument; both call sites pass their channel.
- `listConversations` and `searchConversations` filter to `HUMAN_VISIBLE_SOURCES`.
- `docs/ARCHITECTURE.md` drift block updated in the same PR.

**Deferred** (each its own issue, none blocking):

- A UI affordance to SEE hidden agent threads (a toggle or an "Agent activity" view). This slice
  hides them from one list; it does not build the surface that shows them deliberately.
- **Cleaning up the ~30 pre-existing agent threads.** They backfill to `unknown` and stay visible,
  so the reported noise survives this slice. An earlier draft called retroactive classification
  impossible; that was overclaimed — it rules out AUTOMATIC classification, not a one-off curated
  pass over 62 rows (their titles are recognisable, and the member can already archive a thread from
  the UI). Deferred because it is a data mutation on production content owned by two other people,
  which is a decision, not a build step.
- Filtering `app/api/v1/conversations/route.ts`. Left unfiltered on purpose — it is the API's own
  view, and an agent listing threads has no reason to be shown a human-only subset. Revisit when
  something actually consumes it.
- The blank-thread defect: 9 of Chetan's 39 threads have a user message, no assistant message and
  no `chat_turn_runs` row, and render as an empty `TEAM BRAIN` bubble with no error state. Real,
  separate, and orthogonal — it affects dashboard threads too.
- Delegated agent tokens for CLI use. **This is the terminal fix, and it is worth stating what that
  makes this slice worth.** `aiosd_` tokens are ALREADY stateless on `app/api/v1/query/route.ts`:
  a delegated principal creates no conversation at all. So pointing agents at delegated tokens would
  solve the reported symptom for all future traffic with ZERO schema change. It is deferred by an
  explicit product call, not because it would not work. What this slice adds over simply waiting is
  therefore two things and no more: it covers the interim window, and it leaves a durable provenance
  RECORD that a token swap would not — which is what a future "Agent activity" view, and any
  per-channel analytics, would read.

**Fenced out:** this slice raises one blanket constraint — **no change to what
`app/api/v1/query/route.ts` persists, to `aios query`, or to cost/usage attribution.** Agent
queries must keep creating conversations and keep metering, so nothing that reads
`chat_messages`, `llm_usage` or `query_log` for attribution can regress. What the fence pushes out:
*stopping* API-path persistence entirely → the delegated-token issue above, which is the correct
mechanism for it; and any change to the Telegram-via-Hermes path → out of this epic, and untouched
because it keeps the `api` value it would already get.

## Acceptance criteria

Each is independently satisfiable; none constrains a file another one requires changing.

### Automated

- `npm test` exits 0, including new `test/guards/conversation-source-writers.test.ts`, which pins
  the ONE thing the compiler cannot: that the two DASHBOARD call sites (list and search in
  `app/api/dashboard/conversations/route.ts`) both pass `visibleTo: "human"`, and that
  `app/api/v1/conversations/route.ts` passes `"all"`. It deliberately does NOT assert that call
  sites pass a source argument — a required parameter makes that a `tsc` error, and re-asserting it
  in a grep guard is the ceremony CLAUDE.md §7 warns against.
- `npm run db:test:up && npm run test:datamechanics` exits 0, including new
  `test/datamechanics/conversation-source.datamechanics.test.ts`, which asserts against real
  Postgres, in BOTH directions so it cannot pass by returning nothing: a `dashboard` conversation
  IS listed and IS searchable; an `api` conversation is NOT listed and NOT searchable; an
  `unknown` conversation IS listed (the no-history-vanishes guarantee); a row inserted with no
  explicit source lands as `unknown`; and an out-of-domain value is rejected by the check
  constraint.
- `npm run test:migrate-from-existing` exits 0 — proves the additive migration exists and that
  `schema.sql` mirrors it. This replaces a `check:docs` criterion from an earlier draft that was
  VACUOUS: the drift guard extracts table names only and cannot see a new column at all.
- `npm run lint` exits 0 and `npx tsc --noEmit` is clean — the required `source` argument means a
  missed call site is a compile error, not a runtime surprise.
- `node scripts/mutate.mjs lib/chat/store.ts` reddens the intended test for each of: removing the
  filter from `listConversations`, removing it from `searchConversations`, and widening
  `HUMAN_VISIBLE_SOURCES` to include `api`.

### Manual

- `psql "$DATABASE_TEST_URL" -c "\d conversations"` shows `source text not null default 'unknown'`
  with the check constraint, after `npm run db:test:up` replays schema + migrations from zero.

### Visual

- The Query tab at `/t/<team>/query` does not show an agent thread created AFTER this ships (run
  `aios query "probe"` and confirm it is absent), while a pre-migration thread IS still present.
  Scoped to new threads deliberately: the ~30 existing agent threads backfill to `unknown` and stay
  visible, so the tab does not look clean on ship day.

## Build-with

Build-with: Fable 5, high effort. Small in line count, but it changes a shared write contract and a
tier-scoped read path, and a wrong default silently hides real user history.

## Tier safety

Brain surfaces are touched: a column on `conversations`, both query write paths, and the dashboard
list/search read path.

- **Ownership, not tiers, is the control here.** `conversations` is owner-scoped: every reader
  already filters `team_id` + `member_id` (`ownsConversation`, `listConversations`,
  `searchConversations`), so a member can only ever see their own threads. This slice narrows that
  set further and cannot widen it — the filter is added to existing queries, never replacing an
  owner predicate.
- **Fail-closed direction:** an unrecognised or NULL source must be treated as NOT
  human-visible-by-accident. The default is `unknown`, which IS visible — that is a deliberate
  product choice (do not delete history), not an oversight, and it is asserted explicitly rather
  than left implicit.
- **No new cross-member or cross-tier read path** is introduced; no API route gains a new
  parameter that could widen a result set.
- **Hidden is NOT an access boundary, and the name must not imply otherwise.** A hidden thread stays
  readable by its owner through the by-id detail routes (`app/api/dashboard/conversations/[id]`,
  `app/api/v1/conversations/[id]`), which is deliberate: this is sidebar curation, not permission.
  Owner scoping remains the only access control and is untouched.
- **Residual, named rather than hidden:** source is set at CREATION, so an agent that passes an
  existing `conversation_id` can still append turns to a `dashboard` thread
  (`app/api/v1/query/route.ts` adopts any owned id). Accepted for this slice — no client does it
  today (`aios query` always sends `null`) — and the durable fix is per-turn provenance or delegated
  tokens, both named as follow-ups.

## Risk / rollback

- **Forward:** `postgres/migrations/20260822120000_conversations_source.sql` runs
  `alter table conversations add column if not exists source text not null default 'unknown'`, then
  adds a NAMED constraint `conversations_source_check` inside a guarded `do $$ … if not exists
  (select 1 from pg_constraint where conname = …) … end $$` block — Postgres has no
  `ADD CONSTRAINT IF NOT EXISTS`, and an earlier draft specified exactly that non-existent syntax.
  The pattern is copied from `postgres/schema.sql` (the `teams_*_provider_check` block, ~line 186).
  When the value set later widens, BOTH `schema.sql` and this migration's named constraint must be
  updated together, or replay re-adds a constraint narrower than live data.
- **From-zero replay alone does not prove the migration exists.** `npm run db:test:up` loads
  `schema.sql` first, so a DB built from zero has the column whether or not the migration was
  written — deleting the migration would leave every from-zero check green while PRODUCTION lacked
  the column. `npm run test:migrate-from-existing` (`--mirror-check`) is the lane that catches it,
  and it is an acceptance criterion below.
- **Undo:** revert the app code and leave the column. A dropped column would lose the provenance
  already recorded; an unused one costs nothing. The column is nullable-safe by virtue of its
  default, so old code reading the table is unaffected.
- **The one real hazard is the filter, not the column:** if `HUMAN_VISIBLE_SOURCES` were wrong, a
  member's history would appear to vanish. That is why `unknown` is included and why the
  data-mechanics test asserts an `unknown` row IS listed — the assertion exists specifically to
  fail if someone later "tidies" the default to `api`.
- **Blast radius:** no row's content changes, nothing is deleted, and the 62 existing conversations
  keep rendering exactly as they do today until an agent creates a new one.
