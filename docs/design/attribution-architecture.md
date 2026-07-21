# Attribution architecture — getting "whose work is this?" right across every data stream

**Status:** design (Phase B). **Owner:** Chetan. **Grounds:** the narrative-arcs work — arcs are only
as good as `items.member_id`, and attribution today is bespoke per source and silently wrong for whole
classes of input. Measured on prod 2026-07-21 (see §1).

> **This subsumes the earlier "Phase B substrate" plan.** That plan (full commit bodies, per-PR
> narrative ingestion, reference-doc down-weighting, speaker-aware attribution) turns out to be the
> *same problem viewed from two angles*: **what is this content, and whose is it.** Substrate richness
> and correct attribution are one funnel. The pieces below carry the old Phase B forward inside a
> general attribution architecture rather than as a separate track.

## 1. The problem, measured (prod, team `aios`)

Attribution is resolved **per source**, at ingest, by bespoke code. Only four paths resolve a human;
the generic document path resolves nobody.

Per-source human-attribution rate (share of items pointing at a real human vs. connector/unattributed):

| Source | items | % → real human | failure mode |
|---|---|---|---|
| github (files/issues) | 391 | **99%** | ✅ git email resolves |
| git (commits) | 385 | **97%** | ✅ git email resolves |
| slack | 13 | 77% | user-id resolves; gaps are non-roster users |
| linear | 338 | **22%** | 263 unattributed — creator/assignee not resolved |
| plane | 44 | **0%** | assignee-only; all unassigned → nobody |
| granola (meetings) | 22 | "100%" | **wrong kind of 100%** — see §3 |

**The looming gap:** Notion, Google Docs, Confluence, web, email — everything ingested via the sidecar's
`POST /api/v1/items` — carries only a free-text `actor` (`itemPayloadSchema`, `lib/api/schemas.ts:54`)
and the route calls `ingestItem` with **no author override** (`app/api/v1/items/route.ts:64`) →
`member_id = auth.memberId` = the **connector account** (`lib/ingest/index.ts:116`). So every Notion
page and Google Doc will land like Plane: **0% attributed to the person who wrote it.** We must build
attribution for them *before* connecting them.

## 2. The core architecture — attribution as a first-class, source-agnostic contract

Principle (push to the lowest shared layer): **every ingestion path emits a structured author identity,
resolves it through the ONE shared resolver at ingest, and records the outcome + a confidence. No source
may silently fall back to the connector.**

1. **Contract change — `authors[]` replaces free-text `actor`** on the item push:
   ```
   authors: [{ role: author|editor|creator|assignee|reviewer|speaker|commenter,
               email?, handle?, provider?, external_id?, display_name? }]
   ```
   Multi-author because most knowledge sources have several contributors. A **primary** is chosen by
   role precedence (author > creator > editor …); the full set is retained for multi-participant credit.
2. **One resolution choke-point at ingest** — the route resolves each author via `resolveMember` /
   `resolveByProviderId` (`lib/identity/resolve.ts`), sets `member_id` (primary), persists the resolved
   contributor set, and records the **resolution method** as confidence: `exact` (email/provider-id) =
   high · `heuristic` (domain-handle) = medium · `unresolved` = none. **Never the connector.**
3. **Per-source normalizers** map native author metadata → the contract (one small mapper per source,
   like `slack-identity.ts`), never a monolith.
4. **Confidence is stored on the item** (frontmatter/column) so the observability layer (§5) can flag
   the shaky ones and surface the unresolved for one-click mapping.

## 3. Content classes matter more than the source list

Attribution *shape*, not source, is the real robustness axis:

- **Single-author artifact** (commit, email, chat message) → one clear author. Solved for code.
- **Multi-author document** (Notion, Google Doc, Confluence, Figma) → `authors[]` with roles; a big
  shared doc must not credit only its last editor — and must not credit its author for the *system's*
  content (the `ARCHITECTURE.md` lesson: authorship ≠ narrative — down-weight reference docs).
- **Multi-participant SIGNAL** (meeting transcripts, calendar events, Slack threads) → **NOT work
  attributed to one person.** These are *evidence about who is doing what.* A Granola note is not the
  attendee's deliverable; it's a clue that helps attribute *other* work and understand the storyline.
  **Design:** signal sources feed a `mentions`/`participants` + extracted "who is doing what" layer that
  *informs* attribution and arc synthesis, and are **excluded from "this person's output" counts.** This
  is why the 14 Granola notes mis-credited to Chetan polluted his arcs.

## 4. Data-stream inventory (author signal + wrinkle per source)

**Code/dev:** git commits (author email ✅) · pull/merge requests (author + reviewers) · GitHub/GitLab/
Bitbucket issues (creator vs assignee) · review comments (commenter).
**Docs/knowledge:** Notion (`created_by`+`last_edited_by` user-ids) · Google Docs/Drive (owner + revision
authors + comment authors) · Confluence (author + version contributors) · Coda/Paper/Quip · local md
(frontmatter author / git blame).
**Comms:** Slack (user-id ✅) · MS Teams · Discord · Email Gmail/Outlook (From — cleanest) · WhatsApp/
LINE/Telegram.
**PM:** Linear · Plane · Jira · Asana · Trello · Monday · ClickUp · GitHub Projects (creator ≠ assignee ≠
commenter).
**Meetings/calls (SIGNAL, §3):** Granola · Zoom/Meet/Teams transcripts (speaker diarization → per-speaker)
· Otter/Fireflies/Fathom · calendar events (organizer + attendees).
**Design/product:** Figma (last-edited-by + comments) · Miro.
**Support/CRM:** Zendesk/Intercom (agent) · HubSpot/Salesforce (record owner + activity author).

## 5. Observability — review what we import, percolate errors up

Reuse the pipeline-health mechanism (`lib/ingest/pipeline-health.ts`) with an **attribution-health**
dimension:

1. **Per-source attribution rate** — % human vs connector/unattributed over a window; a source below
   threshold raises the banner (*"notion: 88% of imports couldn't be attributed to a person"*).
2. **Unparseable-stream alert** — a source whose payloads carry *no* recognizable author signal fires a
   distinct, louder alert (*"gdrive: 40 items, no author field — connector can't attribute"*). The "data
   stream we can't make sense of" case.
3. **Unresolved-identity queue** — distinct author identities seen but unmapped (a Notion user-id, a git
   email with no member), surfaced in Admin → add the mapping once → re-attribution back-fills.
4. **Low-confidence review list** — attributions made via heuristic rather than exact match.

## 6. Dashboard — per-person attribution visual (troubleshooting)

A per-person breakdown (what *kinds/sources* of things are attributed to each member) so misattribution
is visible at a glance — e.g. "why does Chetan own 14 meeting transcripts?" jumps out. Reads the same
attribution-health data layer (§5); no bespoke per-view computation.

> **AUTHZ (required when wiring this up):** the attribution-health read spans ALL access tiers (per-member
> names + counts of team/admin-tier content) and there is no RLS backstop (CLAUDE §5). Any surface built
> on it MUST be **admin-gated** (or filtered through `lib/auth/visibility`) and carry a tier-filter guard
> test — never exposed to an `external`-tier principal. The `lib/attribution/health` module documents this.

## 7. Natural-language correction box

An LLM-assisted correction surface: describe a fix in plain language ("the Notion pages under 'Design
System' are Fatma's, not the connector"; "meeting notes aren't anyone's deliverable") → the system
proposes the concrete re-attribution / rule (a `member_emails` alias, a `member_identities` mapping, a
source-level rule, or a content-class reclassification), shows the diff, applies on confirm, and
re-attributes affected items. Sits on top of the existing reattribution engine (`lib/ingest/reattribute.ts`).

## 8. Build order

1. ✅ **Attribution-health data layer + read** (no contract change) — durable version of the §1
   measurement: per-source + per-person breakdown, confidence, unresolved identities. Backs §5 + §6.
   *(Shipped: `lib/attribution/health.ts`, PR #316.)*
2. ✅ **Per-person dashboard visual** (§6) on that read — **Admin → Attribution**
   (`app/t/[team]/admin/attribution`), per-source health bars + per-person source breakdown; admin-gated
   by the admin layout, enforced by `test/guards/attribution-health-admin-only`.
3. ✅ **Resolve-at-ingest choke-point** (§2) — `lib/attribution/resolve-authors.attributeIncomingItem`
   resolves an incoming push's author from its frontmatter at ingest and passes the real member through
   (unresolved ⇒ `null`, **never the connector**); the same resolver replaced the per-source `switch` in
   `lib/ingest/reattribute`, so live + batch can't drift. **Decision: attribution is carried in
   `frontmatter` (structured `authors[]` + source-specific keys), NOT a new wire field** — the wire
   contract's prose source (`brain-api.md`) lives in the `aios-workspace` repo, so a first-class wire
   `authors[]` would need a coordinated cross-repo `brain-api.md` + `BRAIN_API_VERSION` bump. Frontmatter
   is already free-form on the wire, so this delivers the same outcome with no guarded-seam change.
   First-classing `authors[]` on the wire (validation/discoverability) remains a future coordinated bump.
4. **Per-source normalizers** — each connector populates `frontmatter.authors[]`. Sequenced to rollout:
   **Notion → Google Docs** first (per Chetan). (The resolver already accepts them; this is the sidecar
   work to emit the author signal.)
5. **Signal-source reclassification** (§3): meetings/calendar stop counting as one person's output; feed
   the who-is-doing-what layer instead. (Carries forward old B4 speaker-attribution + reference-doc
   down-weighting.)
6. **Unresolved-identity + unparseable-stream alerts** (§5).
7. ✅ **NL correction box** (§7) — **Admin → Attribution** box: an admin describes a fix in plain
   language → the team LLM (`completeTextOrNull`) parses it into a closed, scoped `CorrectionPlan`
   (`lib/attribution/correction`) → read-only preview of the exact items → apply through the audited
   single-writer (`lib/ingest/attribution-correction`). MVP = `reassign` (scoped match → member, or clear
   to nobody); markSignal/identity-mapping corrections are future kinds on the same union.

Substrate items from the earlier plan folded in: full commit bodies + per-PR narrative ingestion land as
part of step 4's code-source normalizers; reference-doc down-weighting lands with step 5.
