---
eval_tier: deterministic
spec_gate: block
safety: false
type: issue-spec
---

# Admin → Agents — the surface that makes delegated tokens usable

## What / why

Delegated agent tokens are built, tested and enforced, and **no human can create one**.

`lib/access/agent-tokens.ts` mints, hashes, verifies and revokes them; `lib/access/enforce.ts`
attenuates every delegated read through a live triple intersection; `app/api/v1/query/route.ts` and
`app/api/v1/items/route.ts` honor them; `app/t/[team]/admin/agents/actions.ts` exposes admin-gated
`mintAgentTokenAction` / `revokeAgentTokenAction` server actions. What is missing is the page that
calls them: that directory contains `actions.ts` and **no `page.tsx`**, nothing else in `app/`
imports either action, no API route mints one, and **prod has 0 tokens ever minted**
(`select count(*) from agent_tokens` → 0, measured read-only 2026-08-22).

This is the same failure the Skills catalog had — a working, deployed capability with no way in.

The motivating case: agent `aios query` traffic is written into the launching member's dashboard
Query tab, because `/api/v1/query` creates a conversation for any member-scoped key. A delegated
principal is **conversation-stateless** on that route and creates no conversation at all, so the
noise disappears at the source.

**"Stateless" means conversations ONLY, and an earlier draft overstated it.** A delegated request
still writes: `last_used_at` plus an audit event at authentication (`lib/api/auth.ts`), a `query_log`
row before streaming and an update on completion, and cost metering via `recordLlmUsage`
(`app/api/v1/query/route.ts`). It also CONSUMES quota — the 10/min and 20/day buckets key on the
LAUNCHING member (`route.ts:47`), so a token minted against a human member burns that human's daily
allowance and can lock them out of their own dashboard. The page must therefore steer admins toward
minting against a dedicated agent member row rather than against themselves, and say why. That is why the provenance-column alternative (`docs/design/query-provenance-v1.md`,
QPROV-1) was declined after review: it filtered a symptom that two documented API calls could
reproduce.

**Measured constraint this page must state, because it decides whether a token is usable at all:
delegated tokens are READ-ONLY today.** `GET /api/v1/items` honors them
(`app/api/v1/items/route.ts:204` — "this is the ONE route that honors delegated agent tokens") and
so does `/api/v1/query`, but `POST /api/v1/items` authenticates with `authenticateApiKey` only, so
`aios push` presented with an `aiosd_` token gets 401. A query-only agent can switch today; an agent
that also pushes cannot.

**The CLI needs no change for reads.** It treats the credential as an opaque string and sends
`Authorization: Bearer ${apiKey}`; there is no key-format validation anywhere in it. So the whole
adoption step is: paste an `aiosd_` token where `AIOS_API_KEY` goes.

## Outcomes

- An admin can mint a delegated token from the dashboard and copy it once.
- The page states the read-only limitation where it is read, not in a doc nobody opens.
- Existing tokens are listable with their launcher, scope, expiry and last-used, and revocable.
- A minted token immediately works for `aios query` with no CLI change — while the page states
  plainly that the SAME agent's `aios push` will 401, so nobody swaps one credential and finds out
  by breaking their ticket flow.
- The page is REACHABLE — it appears in the admin tab bar, not only by typing the URL.

## Interface / integration points

- `app/t/[team]/admin/agents/actions.ts` — `mintAgentTokenAction(teamSlug, {memberId, onBehalfOf,
  projectScope, name, expiresAt})` and `revokeAgentTokenAction(teamSlug, tokenRowId)`. Both already
  call `requireAdmin`, validate UUID shape, and return `MintResult`. This slice adds a caller, and
  changes neither.
- `lib/access/agent-tokens.ts` — the single writer for `agent_tokens` (pinned by
  `test/guards/access-single-writer.test.ts`). `MintResult.token` is returned exactly once and never
  stored or logged; the page must honour that and not persist it.
- `app/t/[team]/admin/keys/page.tsx` — the pattern this follows exactly: a server component that
  lists credentials with a mint form and a revoke button.
- `components/admin/issue-key.tsx` — `IssueKey` / `RevokeKeyButton`, the show-once + revoke client
  components whose interaction shape is mirrored.
- `components/admin/admin-tabs.tsx` — the `TABS` array (line 6). A new admin page that is not added
  here is unreachable; `admin/access` is already in exactly that state and is NOT fixed by this
  slice.
- `app/t/[team]/admin/layout.tsx` — the admin shell, which already gates on `canAccessAdmin`.
- `postgres/schema.sql` — `agent_tokens` already exists with every column this page reads
  (`member_id, on_behalf_of, project_scope, name, expires_at, last_used_at, revoked_at`). **No
  schema change, no migration.**
- `components/format.ts` — `timeAgo`, used by the keys page for the same columns.
- `lib/db/pg/relationships.ts` — the adapter's embedded-select relationship map. It has **no
  `agent_tokens` entry**, and the table has TWO distinct member legs (`member_id`, `on_behalf_of`),
  so the keys page's `members(...)` embedded select CANNOT be copied verbatim — it would fail at
  runtime. The page resolves display names with a separate, team-scoped `members` read and joins in
  memory. Found while scoping; this is the one place the "thin copy of the keys page" framing breaks.

## New files to create

Every path below is created by this slice; none exists yet.

- new file: `app/t/[team]/admin/agents/page.tsx` — the server component: list + mint form.
- new file: `components/admin/mint-agent-token.tsx` — the client component (form, show-once panel,
  revoke button).
- new file: `test/guards/admin-tabs-reachability.test.ts` — unit tier, the reachability pin.
- new file: `test/datamechanics/agent-token-admin.datamechanics.test.ts` — real-Postgres tier, the
  mint/revoke outcomes through the actions' own module boundary.

## Contracts, named before implementation

The page is a thin caller; the contract it must not break is the one the actions already define.

```ts
// Rendered per row. Read from agent_tokens, joined to members for display names.
// NOTE: `token_hash` is deliberately absent — the page must not select it. The keys page it copies
// selects `key_id`, not `key_hash`; an earlier draft of this spec deviated from that for a test's
// convenience, which would have put hash material one careless prop-pass from the RSC payload.
type AgentTokenRow = {
  id: string;
  name: string;
  launcher: string;            // members.display_name for member_id
  actingAs: string | null;     // members.display_name for on_behalf_of, null = self
  scope: { kind: "inherit" } | { kind: "none" } | { kind: "restrict"; projectNames: string[] };
  // Rendered as NAMES, not a count: an admin auditing a token must be able to see what it grants
  // without dropping to SQL. `none` (the `[]` case) is rendered distinctly from `inherit`.
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
};
```

**`project_scope` has three states and the UI must not collapse them** — `null` is unattenuated
(inherits the launcher's projects), `[]` sees NOTHING, and a populated array is a real scope.

**The form must never DERIVE which of the three from an untouched control.** An earlier draft said
"send `null` when nothing is picked", which is the fail-OPEN direction and both reviewers flagged it:
the two failure modes are not symmetric. A `[]` token fails loud and closed — the agent reads
nothing and someone notices in minutes. A `null` token minted because an admin meant to scope and
forgot fails silent and open: it works everywhere, which looks exactly like success. So the form
presents an EXPLICIT choice and has no default:

```ts
type ScopeChoice =
  | { kind: "inherit" }                    // → projectScope: null, chosen deliberately
  | { kind: "restrict"; projectIds: string[] };  // → projectScope: array, ≥1 required

// Submit is DISABLED until a ScopeChoice exists. If the project list fails to load, the "restrict"
// branch is unavailable but an EXPLICITLY confirmed "inherit" still mints: blocking every mint on a
// transient read failure pushes an operator toward an ordinary API key, which is strictly worse
// (write authority AND conversation persistence). Fail-closed applies to UNTOUCHED input, not to a
// deliberate choice that needs no project list.
```

**Expiry is REQUIRED, bounded, and defaulted.** `mintAgentToken` stores `args.expiresAt ?? null`
and a null expiry never expires (`lib/access/agent-tokens.ts:103`), while the action validates only
that the string parses — so a past date mints an already-dead token. The form therefore: defaults to
**90 days**, caps at **365**, refuses a past date, and does not offer "never".

**`on_behalf_of` is NOT exposed in v1.** The action accepts it and the enforcement is sound (both
legs intersect live), but it is impersonation-shaped: a delegated query answers in the represented
person's first-person identity while quota, cost and audit attribute to the launcher, and there is
no owner→agent authorization or represented-person consent model anywhere in the system. Shipping a
dropdown for it would create that policy by accident. The mint form is self-only; the list still
renders `actingAs` so a token minted by any other path is visible rather than hidden.

### The server boundary — where the rules actually live

`app/t/[team]/admin/agents/actions.ts` already validates shape (UUIDs, parseable date) in exactly
this style; these are three more checks in the same file, applied to every caller:

```ts
// mintAgentTokenAction, after the existing UUID checks:
if (input.onBehalfOf != null) return { ok: false, error: "acting-as is not available" };
// ^ v1 mints self-only. Rejected server-side rather than merely omitted from the form, because
//   "the UI doesn't offer it" is not a constraint on an HTTP endpoint.

if (!input.expiresAt) return { ok: false, error: "expiresAt is required" };
// ^ mintAgentToken stores `expiresAt ?? null` and a null expiry NEVER expires
//   (lib/access/agent-tokens.ts). Absent must be refused, not defaulted silently.

const ms = Date.parse(input.expiresAt);
if (ms <= Date.now()) return { ok: false, error: "expiresAt must be in the future" };
if (ms > Date.now() + MAX_TOKEN_LIFETIME_MS) return { ok: false, error: "expiresAt is beyond the 365-day maximum" };

if (input.projectScope != null && input.projectScope.length === 0) {
  return { ok: false, error: "projectScope must name at least one project, or be omitted to inherit" };
}
// ^ `[]` means "sees nothing" — a legal DB state, but never a legal REQUEST: it is only ever
//   reachable by an empty multi-select, i.e. an accident. `null` (inherit) stays legal and explicit.
```

`MAX_TOKEN_LIFETIME_MS` is exported so the form and the action cannot disagree about the cap — one
constant, two readers. The form's job is unchanged; it now simply cannot ask for something the action
would refuse.

## Dependencies

Depends on: none. The token core, the actions, the table and the enforcement all shipped with PCCA
Phase A. No AIOS CLI change is required for the read paths.

## Scope

**This is one reviewable PR.** One admin page, one client component, one tab entry, two tests. No
schema change, no API route, no change to any existing enforcement path.

**In:**

- `app/t/[team]/admin/agents/page.tsx` listing the team's tokens and offering the mint form.
- `components/admin/mint-agent-token.tsx` with the show-once reveal and copy.
- `agents` added to `TABS` in `components/admin/admin-tabs.tsx`.
- The read-only limitation stated on the page itself.
- Tests: a reachability guard and a real-Postgres mint/revoke outcome test.

**Deferred** (each its own issue, none blocking):

- Extending delegated tokens to WRITE routes (`POST /api/v1/items`), which is what a push-capable
  agent would need. A real limit, deliberately not widened here: widening an auth surface is its own
  slice with its own review.
- An `admin/access` page for groups and project grants — the sibling orphan found while scoping.
- A per-member "my agents" view; this is admin-only, matching the actions' own gate.
- Creating dedicated agent member rows from the admin UI, which is the prerequisite for the
  quota-isolation advice above to be actionable at all.
- Exposing `on_behalf_of` in the mint form. Deferred because it needs an owner→agent authorization
  model and represented-person consent that do not exist anywhere yet — one reviewer declined the
  whole slice over precisely this, and omitting the control from v1 is what makes building the rest
  safe rather than deciding that policy by accident.
- Any CLI change. None is needed for reads, and the write gap is the deferred item above.

**Fenced out:** this slice raises one blanket constraint — **no change to
`lib/access/agent-tokens.ts` or to any route that honors a delegated token.** The mint/hash/verify
core and the enforcement paths are reviewed and tested; a UI slice must not edit them.

**The fence deliberately does NOT cover `app/t/[team]/admin/agents/actions.ts`, and an earlier draft
that fenced it out was wrong.** Round 2 of the spec review put it plainly: with the action excluded,
every safety property in this spec lived only in a React form — and a server action is a public HTTP
endpoint, so the form is a suggestion, not a boundary. `mintAgentTokenAction` would still have
accepted `onBehalfOf`, a null (never-expiring) expiry, and any scope, from any caller who skipped the
page. That is the "spec ruling silently unimplemented" failure by name. The rules therefore go where
they hold: in the action, with the form as the ergonomic front end that makes the legal choices easy.

What the fence still pushes out: the write-route gap (`POST /api/v1/items`) → its own slice; changes
to scope SEMANTICS or to how a token is verified → out of scope entirely, this slice only constrains
what may be REQUESTED, never what an existing token can do.

## Acceptance criteria

Each is independently satisfiable; none constrains a file another one requires changing.

### Automated

- `npm test` exits 0, including new `test/guards/admin-tabs-reachability.test.ts`, which pins BOTH
  directions, because the page→tab direction alone is blind to the failure that motivated this slice:
  (a) every admin directory with a `page.tsx` has a `TABS` entry, and (b) every admin directory with
  an `actions.ts` has a caller — an orphaned capability is the actual repeated bug (Skills catalog,
  `admin/agents` itself, `admin/access`). Direction (b) carries an explicit allowlist containing
  the known orphans ONLY, so that debt is documented rather than invisible and a NEW orphan fails the
  build. An earlier draft asserted only (a) and would not have caught its own motivating case.
- `npm run test:datamechanics` exits 0 for coverage of the SERVER boundary in
  `app/t/[team]/admin/agents/actions.ts`, calling the action directly (not through the form) and
  asserting each refusal writes NO row: `onBehalfOf` set → refused; `expiresAt` absent → refused;
  `expiresAt` in the past → refused; `expiresAt` beyond 365 days → refused; `projectScope: []` →
  refused; and the legal cases (`projectScope: null`, and a populated array with a valid future
  expiry) → accepted. These are the fail-open directions: each asserts the request is REJECTED, so a
  removed check reddens rather than silently widening what can be minted.
- `npm run db:test:up && npm run test:datamechanics` exits 0, including new
  `test/datamechanics/agent-token-admin.datamechanics.test.ts`, which asserts against real Postgres:
  minting writes exactly one `agent_tokens` row whose `token_hash` is not the returned token;
  `project_scope` persists as NULL when no restriction is sent, and a populated array persists as
  that array — an empty array is REFUSED by policy and therefore never written, so an earlier
  draft's "persists as `{}`" asked for a row the design deliberately makes unreachable; a scope
  naming a project the admin cannot see is refused AND writes no row; a revoked token sets
  `revoked_at` and `verifyAgentToken` then returns null; and a non-admin caller mints nothing.
- `npm test` exits 0, including unit coverage of the form's scope+expiry contract: an untouched
  scope control yields NO submittable payload (not `null`, not `[]`); choosing "inherit" yields
  `projectScope: null`; choosing "restrict" with zero projects is not submittable; the expiry
  default is 90 days; a past expiry is refused; and there is no "never" option. These are the
  fail-open directions both spec reviewers flagged, so each is asserted in the direction that would
  silently mint an over-privileged credential.
- `npx tsc --noEmit` is clean and `npm run lint` exits 0.
- `npm test` exits 0 for a regression test asserting the page's `agent_tokens` select list does NOT
  include `token_hash`, and that mint and revoke both call `revalidatePath` — the agents actions
  currently have ZERO such calls while the keys actions have TWO (`app/t/[team]/admin/actions.ts:223`
  and `:241`), so without it the list renders stale immediately after the action the admin just took.
  (An earlier draft said "four" — that was a grep count including the import line, corrected here
  rather than left as a plausible-looking number.)
- `node scripts/mutate.mjs components/admin/admin-tabs.tsx` reddens the reachability guard when the
  `agents` TABS entry is removed.
- `node scripts/mutate.mjs app/t/[team]/admin/agents/actions.ts` reddens the INTENDED test for each
  server-boundary check removed in turn — the acting-as refusal, the expiry-required refusal, the
  max-lifetime refusal, and the empty-scope refusal. A check that survives its mutation is
  decoration, and for this file that means an unenforced credential rule.

### Manual

- `psql "$DATABASE_TEST_URL" -c "select token_hash, project_scope from agent_tokens"` after a mint
  shows a hash that does not equal the token string shown in the UI.

### Visual

- `/t/<team>/admin/agents` renders in the admin tab bar, lists existing tokens, and after minting
  shows the token exactly once with a copy control and a warning that it will not be shown again.

## Build-with

Build-with: Fable 5, high effort. Small and UI-shaped, but it is the human interface to a security
credential: a form that mis-sends `[]` for `null` mints a dead token, and one that logs or re-renders
the secret breaks the show-once contract the token core is built on.

## Tier safety

Brain surfaces are touched: a new admin page reading `agent_tokens`, and a client component that
handles a bearer secret.

- **The PAGE must gate itself; the layout is not sufficient.** An earlier draft called this
  "admin-gated twice" and that was wrong for the list read. Next's own guidance (see
  `node_modules/next/dist/docs/`, the authentication guide) is explicit that a child page can execute
  and land in the RSC payload despite a layout check — and with no RLS there is no backstop. So
  `app/t/[team]/admin/agents/page.tsx` calls the admin gate itself and derives `teamId` from that
  result, rather than trusting `app/t/[team]/admin/layout.tsx`. The MUTATIONS are separately safe:
  both actions call the gate independently, which is the authoritative check for mint and revoke.
- **The secret is show-once.** `MintResult.token` is rendered in component state and never written
  to the DB, a log, an analytics call, or the URL. The list query selects `token_hash` for the test's
  benefit only and must never render it.
- **Team scoping.** Every read filters `team_id`; `agent_tokens` has composite FKs to
  `members (team_id, id)` for both legs, so a cross-team row cannot exist to be listed.
- **No widening.** This slice adds no route, no parameter, and no new principal type; it calls two
  existing admin-gated actions. Enforcement of what a token can SEE is unchanged and remains the
  oracle's live triple intersection.

## Risk / rollback

- **No schema change.** `agent_tokens` already exists in `postgres/schema.sql` with every column
  used, so there is no migration, no replay risk, and nothing to undo in the database.
- **Rollback is deleting the page** and removing one `TABS` entry. Any tokens minted before a
  revert keep working — they are enforced server-side, independently of this UI — which is the
  correct behaviour but worth stating: reverting the page does NOT revoke outstanding tokens, and
  revocation would have to be done in SQL until the page returns.
- **The irreversible act is minting**, not deploying. A minted token is a live credential until it
  expires or is revoked; the page mitigates with a REQUIRED 90-day-default expiry (max 365, no
  "never") and a one-click revoke on every row.
- **Revocation takes effect on the NEXT request, not in-flight.** Verification happens once at
  request start (`app/api/v1/query/route.ts`), so a streaming answer already running completes after
  revoke. The page says so rather than implying a kill switch.
- **The secret's exposure is wider than "show once" suggests.** Show-once describes BACKEND
  retrievability — it is never stored or re-servable. It still crosses the wire in the Server Action
  response, sits in React state until navigation, and is visible in network and React devtools and to
  browser extensions; copying it puts it in clipboard history. The page therefore must not put it in
  an `<input>` (autofill/password-manager capture) and must never attach it to an error — the admin
  error boundary reports to Sentry. These are inherited properties of the pattern being copied, named
  here rather than discovered later.
- **Blast radius:** read-only against every existing surface. The one new write is an
  `agent_tokens` insert through an already-tested single writer.
