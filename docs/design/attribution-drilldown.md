# Per-person attribution drill-down — from counts to the actual pieces

**Status:** BUILT (this PR). **Grounds:** gap #2 — "did we build a view to see who's associated with what pieces of
context?" Today the Admin → Attribution dashboard (`#320`) shows per-person **counts** by source
(`getMemberAttribution` → "Chetan: 152 git · 14 granola"), but you can't click through to *which* items,
or see *why* something is attributed to someone. This adds that.

## What exists
- `lib/attribution/health.getMemberAttribution(teamId)` → `[{ memberId, displayName, total, bySource:[{source,items}] }]`.
- Admin → Attribution renders those as non-clickable chips (`components/admin/attribution-health-view.tsx`).
- `/t/[team]/library/[id]` is the item-detail page — the link target for a piece of context.
- `items.member_id_locked` (`#333`) records whether attribution was a deliberate correction.

## Design (corrected per Fable design review — reuse canon, don't paraphrase)

**1. A read — `getMemberItems(teamId, memberId, opts)`** (`lib/attribution/health.ts`, admin-only like the
rest of that module). `memberId: string | null` — **`null` = the unattributed bucket** (the biggest triage
target: Plane 100% / Linear 78% unattributed), one `where member_id is null` branch, included now.
```
{ id, path, title, kind, source, updatedAt, locked, signal }[]
```
- `source` = **the shared `SOURCE_EXPR` constant verbatim** (`coalesce(nullif(trim(lower(frontmatter->>'source')),''), kind::text)`),
  in BOTH the select and the `source` filter — so drill-down totals reconcile with the chips (a paraphrase
  splits `Granola`/`granola` and lists 11 of 14). The reconciliation data-mechanics test guards this.
- `title` = frontmatter `title` → first `#` heading (fetch `left(body,500)`, not full bodies) → path tail.
- `locked` = `member_id_locked` → a **"manual"** badge. On a locked row the signal is irrelevant (the
  override supersedes it) — **suppress/de-emphasize `signal` when locked**.
- `signal` (the "why is this theirs?") = **NOT a SQL expression.** Fetch `frontmatter`, run
  `parseAuthorRefs(fm)` and take the role-ranked primary, rendered via the resolver's own `describe()`
  helper (export it from `resolve-authors`) — so the shown "why" is *definitionally* what the resolver sees
  (a Linear `assignee_id`-attributed item has none of the naive keys → would show blank exactly on the
  low-attribution sources this page triages). **Honesty caveat (state in the doc):** this shows what
  resolves NOW from current frontmatter, not what resolved at ingest (aligned with the deferred
  which-mapping provenance).
- **Order `updated_at desc` (labeled "updated"), keyset cursor on `(updated_at, id)`** — NOT
  "newest-work-first": `items` has no work-time column; `source_ts` is an unvalidated frontmatter string
  (a garbage value would 500 a `::timestamptz` cast). Work-time ordering is a follow-up aligned with
  `arcs-work-time-chronology.md`. (`limit` ~100.)
- **Errors THROW** (deliberately deviating from the module's best-effort-`[]` convention): a chip says "14"
  but the expand erroring to `[]` would make the dashboard contradict itself. The action returns `{ok,error}`.

**2. UI — expand a person → their items** (`attribution-health-view` + a small client wrapper):
- Each per-person row becomes expandable (a disclosure). Expanding calls a server action
  `getMemberItemsAction(teamSlug, memberId, source?)` (admin-gated via `requireTeamAdmin`) and lists the
  items: source icon · title (linking to `/library/[id]`) · kind · updated · a **manual** badge when locked.
- The per-source chips become filters: clicking "granola 14" expands to just that person's granola items —
  so "why does Chetan own 14 meeting transcripts?" is one click to the actual 14, each linkable.
- Each item row gets a **"correct"** affordance. NOT a path-prefix NL prefill (a `pathPrefix` is a PREFIX
  match, and `unique(team_id, project_id, path)` means the same path can exist in multiple projects → could
  touch N items). Instead: add optional **`itemId: z.string().uuid()`** to the correction `match` schema
  (+ its scoped-`refine` set + `matchItems`), and the affordance builds the `CorrectionPlan` **directly**
  (skips the LLM parse) — still routed through the SAME `previewCorrection` → `applyAttributionCorrectionAction`
  path, so it inherits the closed-schema re-validation, preview, TOCTOU `expectedCount`, audit, and the lock.
- On apply-success the expanded list + chips must **refetch** (the client wrapper refetches; `revalidatePath`
  alone won't refresh a client-fetched expansion).

**3. Why-attributed, honestly scoped.** MVP shows the *signal* (the email/handle/provider-id in frontmatter)
+ the *locked* flag (manual vs auto). It does NOT yet show *which mapping row* resolved the signal — that's
a deeper join (`member_emails`/`member_identities`) and a fair follow-up; the signal + locked flag already
answers "is this right, and was it deliberate?" for triage.

## Authz / tier
`getMemberItems` is team-scoped (`team_id = $1 and member_id = $2` or `is null`) and lives in
`lib/attribution/health`, so the `attribution-health-admin-only` guard covers its import location. **But be
honest:** that guard only checks *where* it's imported — a Next server action is a globally-invokable HTTP
endpoint regardless of directory, so **`requireTeamAdmin` inside `getMemberItemsAction` is the real gate**,
and it must have its own **spec-first non-admin-denial test** (the guard doesn't cover it). Zod-validate the
action inputs (`memberId` uuid-or-null, optional `source`).

## Verification
- **data-mechanics:** seed a member with items across sources (some locked); `getMemberItems` returns only
  that member's items, correct `source`/`locked`/`signal`, honors the `source` filter, and its per-source
  counts reconcile with `getMemberAttribution`.
- **unit:** the title/source derivation is a pure helper — test the fallback ladder (frontmatter title →
  heading → path tail).
- The UI component is untested (server-rendered/interactive) — acceptable; the read is the tested surface.

## Out of scope (follow-ups)
- The which-mapping-resolved-it join (full provenance).
- An item-centric view (`/library/[id]` → "attributed to X because Y") — the inverse direction.
