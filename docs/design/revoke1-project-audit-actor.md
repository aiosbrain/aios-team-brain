---
access: team
---

# REVOKE-1 — the revoke-project verb + the audit-actor story (the enforcement program's last recorded loose thread)

## 0. What and why

**What:** a `revoke-project` CLI verb that completes the grant lifecycle the enforcement
program (ENFB-1..4) built its whole repair story on — with the AUDIT-ACTOR question answered
rather than papered over, and the substrate protected from the one revoke that would break it.

**Why:** every ENFB slice's stranded-row story says "repair = the grant path", and three
consecutive slice docs (ENFB-2 §0b, ENFB-3 §out-of-scope, ENFB-4 §4) defer the revoke half
with the same recorded reason (verbatim at `scripts/admin.ts:306-308`): *"`revokeProjectFromGroup`
requires a real member actor for its audit row, and the CLI runs as an operator, not a member —
a revoke verb waits for an actor story rather than widening the sole-writer's audit contract."*
Without it, membership is a RATCHET: an operator can curate content INTO a restricted
initiative and grant visibility, but a wrong grant is permanent short of raw SQL — which is
both the worst repair path in the codebase and invisible to the audit trail.

**Measured terrain (prod, read-only, 2026-08-19):**
- `project_groups`: **3 rows, ALL on `kind='system'` projects** (the general/external-shared
  substrate wiring). ZERO initiative grants exist yet — so the verb retro-revokes nothing, and
  the sharpest live risk is the opposite one: a careless revoke against a SYSTEM project would
  sever the substrate every enforced read hangs on.
- `audit_log` `access.project_granted`: 3 rows, all `actor_kind='system'` (the null-actor CLI
  grants — `auditWrite` maps null → `system`, groups.ts:74-84, so the contract already
  REPRESENTS operator writes; the open question was never representability, it was whether a
  DESTRUCTIVE narrowing may be attributed to nobody).
- Active admins on the prod team: 4 (an `--actor` requirement is satisfiable).
- `revokeProjectFromGroup` (groups.ts:493-508): exists, **zero callers repo-wide** — its
  signature and return shape can move without breaking anything.
- Cache/enforcement coupling: `visibilityHash` = sha256 of the SORTED effective project set
  (enforce.ts:170), and every cache variant keys on it (timeline-cache.ts:44) — so a revoke
  changes the hash and takes effect on the next read with NO stored state to repair. The
  computed-gate precedent is ENFB-4 §0b (the same reason no social cascade was built).

**NOT measured:** nothing relevant — no request-volume or corpus question exists (one CLI verb,
one single-writer lib file).

**Ticketing:** row `REVOKE-1`; PR carries `AIOS-Work: REVOKE-1`.
**Governing spec:** `docs/specs/project-context-classification-v1.md` §5.7 (membership is the
access model; grants are deliberate, audited acts) via the ENFB-2 D1 grant story. **Deps:**
ENFB-4 (#615) merged. **Schema: NONE.**
**Build with:** fable / high.

## 0b. Decidables — defaults stated for the design review to attack

- **D1 — the actor story (REVISED at design round 1's BLOCKER — the draft LAUNDERED
  authority): a CLI revoke is audited as what it IS — an operator-run act with a named
  authorizer — never as the named admin's own act.** The draft had `--actor <email>` writing
  `actor_kind='member'` + that id, i.e. the audit would record an admin as having performed a
  destructive act they may never have seen (`auditWrite` maps ANY non-null id → `member`,
  groups.ts:74-84; the same class already live at `add/remove-group-member`, admin.ts:271 —
  recorded, out of scope). The honest contract records BOTH truths: the writer takes a
  discriminated actor —
  `{ kind: "member", memberId }` (the member themselves performed it — reserved for a future
  UI action) or `{ kind: "operator", authorizedByMemberId, via }` (the CLI: the operator ran it on
  a named active admin's authority). An operator revoke audits `actor_kind='system'` with
  `meta.authorizedByMemberId` + `meta.via` (the caller-declared transport — "cli" from the verb). `--actor <admin-email>` stays REQUIRED on
  the verb (a destructive narrowing still may not be attributed to nobody); no `--actor` →
  usage die BEFORE any read; unknown/inactive/non-admin email → die, named, no partial work.
- **D1b — grant-project gains OPTIONAL `--actor <admin-email>`, recorded in META ONLY
  (REVISED with the BLOCKER): the flag writes `meta.authorizedByMemberId` on the grant's audit
  row — it does NOT become the audit actor and does NOT go into the edge's `added_by` column**
  (both would be the same laundering: a name in an actor field for an act the operator
  performed). Absent → today's null/system behavior stands unchanged. The validation arm
  (active admin) applies when the flag is present.
- **D2 — SYSTEM projects are unrevokable, enforced IN THE WRITER (REVISED at round 1 H1):**
  `revokeProjectFromGroup` itself refuses `projects.kind='system'` with a named error before
  any write — the single-writer guard exists so invariants live in `lib/access/groups.ts`,
  and a CLI-only check would leave any future lib caller able to sever general/external-shared
  (prod's ONLY current edges, measured above; bootstrap re-grants idempotently but the window
  is a full substrate outage). The CLI additionally preflights for a friendlier message.
  Round 1 verified: no materializer/bootstrap flow ever legitimately deletes a system edge.
- **D2b — the writer validates the principal (round 1 H2; SHARPENED at round 2's BLOCKER 2 —
  role alone is NOT the app's admin predicate): whichever actor kind arrives, the referenced
  member must pass the SAME admin test the app applies — `role='admin'` AND `status='active'`
  AND unrestricted (non-external) POSTURE, i.e. the `canAccessAdmin` predicate on the same
  resolved posture the admin layout and `requireTeamAdmin` use** (admin-access.ts:6-12
  explicitly denies the representable `role='admin', external`-posture principal; a role-only
  writer check would accept a principal every app gate rejects). Checked inside
  `revokeProjectFromGroup` with bounded reads via the existing resolution helpers. Revoke can
  hold this invariant globally precisely because it has zero callers; grant cannot (the
  creator self-grant is a non-admin member by design, app/actions/projects.ts:98 — the
  asymmetry is stated, not accidental).
- **D2c — CHECK ORDER is part of the contract (round 2 HIGH — an unordered writer turns
  invalid principals into an existence oracle):** (1) project resolution + `kind='system'`
  refusal, (2) principal validation, (3) the edge existence probe, (4) delete + audit. An
  invalid/non-admin principal therefore receives the SAME refusal whether the edge exists or
  not — the no-op `{ revoked: false }` outcome is reachable ONLY by an authorized principal
  against a non-system project (pinned both directions in the ACs).
- **D3b — the audit write is BEST-EFFORT, stated (round 2's BLOCKER 1 corrected the draft's
  over-promise):** `audit()` never throws and swallows insert failures BY DESIGN
  (lib/api/audit.ts:16-30) — the repo-wide contract that an audit outage must not break the
  product act. The draft's "nothing partially applied" claim is therefore SCOPED to the edge
  write (the one destructive statement); a revoke whose audit insert fails still revokes, in
  the same failure direction as every audited write in this codebase (act over trail —
  reversing that tradeoff, or adding a transaction surface, is the recorded F3 adapter work,
  not this slice). The ACs pin the happy-path trail exactly and this limitation is named in
  the PR body.
- **D3c — human-readable attribution (round 2 M, stated):** the admin audit page renders
  `actor_kind` only (audit/page.tsx:48) — an operator revoke shows "system" in the Actor
  column, with the authorizing admin in the meta JSON the page already renders. Meta
  attribution is the MACHINE-READABLE record; surfacing `authorizedBy` as a first-class
  column is the audit-UI phase's work, named out of scope.
- **D3 — no-op revokes do not audit.** `revokeProjectFromGroup` today deletes blindly and
  audits UNCONDITIONALLY — revoking a non-existent edge would write an `access.project_revoked`
  row for a revocation that revoked nothing (an over-reporting trail is a lying trail). The
  function gains a probe-first shape (the same existence-probe idiom `grantProjectToGroup`
  uses, groups.ts:475-482) and returns `{ ok: true, revoked: false }` with NO audit row when
  the edge is absent; `revoked: true` + the audit row only for a real deletion. Zero callers
  today — the return-shape move is free. The bounded probe/act race mirrors the grant's
  recorded one (two concurrent revokes can both probe-hit and both audit — the trail
  over-reports the same ms-apart act, never under-reports; deferred with the same F3 reason).
- **D4 — effect and repair story, stated PER MECHANISM (round 1 M corrected the draft's
  false "every cache keys on visibilityHash" claim):** revocation is COMPUTED into effect on
  the next read through two distinct mechanisms — the timeline/vis-variant caches key on
  `visibilityHash` (sha256 of the sorted effective project set, enforce.ts:170;
  timeline-cache.ts:289/326), which a revoke changes; the ARC/graph reads do NOT use that hash
  — they resolve the member's `visibleProjectIds` into graph partition groups per read
  (partition-read.ts:183 → arc-fusion.ts:97), so a revoke shrinks the partition list BEFORE
  fusion. Both fail toward less visibility; no cascade, no sweep, nothing stored to repair
  (the ENFB-4 precedent). Content already curated into the revoked project stays where it is;
  members holding it through ANOTHER group keep seeing it (set semantics, no precedence
  question). A wrong revoke is repaired by `grant-project` — the two verbs now form the
  closed loop the program promised.

## 1. The surface table

| Surface | Today (file:line) | This slice |
|---|---|---|
| `revoke-project` CLI verb | ABSENT — `scripts/admin.ts:306-308` records the deferral + reason | `revoke-project <group-slug> <project-slug> --actor <admin-email> [--team …]`: resolve team → group → project (existing die-with-usage shapes), preflight the system-kind refusal for a friendly message (the WRITER holds the invariant, D2), resolve the authorizer, call the sole writer with `{ kind: "operator", authorizedByMemberId, via }`, report `revoked`/`no grant to revoke` |
| `revokeProjectFromGroup` (lib/access/groups.ts:493-508) | blind delete + UNCONDITIONAL audit; zero callers | takes the discriminated actor (D1); refuses `kind='system'` projects (D2) and non-active-admin principals (D2b) INSIDE the writer; probe-first: absent edge → `{ ok: true, revoked: false }`, no audit (D3); present → delete + audit (`system` actor + `meta.authorizedByMemberId` + `meta.via` for operator revokes; `member` actor for the future UI kind) |
| `grant-project` CLI verb (scripts/admin.ts:285-313) | hardcodes `null` actor → `actor_kind='system'` audit rows (3 in prod) | optional `--actor <admin-email>` recorded in the audit META only (D1b — never the actor field, never `added_by`); absent → unchanged null path |
| audit trail (`audit_log` via `auditWrite`) | grants: `system` actor; revokes: none exist | operator revokes: `actor_kind='system'` + `meta.authorizedByMemberId` + `meta.via='cli'` + `meta.groupId`; no row for no-op revokes; the member kind (future UI) audits as `member` |
| enforcement/caches | timeline keys on `visibilityHash`; arcs resolve partition groups per read | UNCHANGED — both computed mechanisms narrow on next read; stated per mechanism, not built (D4) |

## 2. Mechanism notes

- **One writer, one file, invariants IN the writer (round 1 H1/H2).** All edge writes stay in
  `lib/access/groups.ts` (the access-chain single-writer guard,
  `test/guards/access-single-writer.test.ts`, keeps every other file refusable), and so do the
  system-kind refusal and the active-admin principal validation — a CLI-only check would bind
  the invariant to one caller. The CLI verb only resolves names → ids, preflights for message
  quality, and calls the writer.
- **The discriminated actor** (`{ kind: "member", memberId } | { kind: "operator",
  authorizedByMemberId, via }`) keeps the future UI path honest by construction: when an admin
  clicks revoke themselves, THEIR action audits as `member`; the CLI can never produce that
  shape. Resolution stays in the CLI (`memberIdByEmail`, admin.ts:103); validation lives in
  the writer (D2b).
- **Fail directions:** unknown team/group/project/email → die before any read of the writer
  (existing shapes); non-admin/inactive/external-posture principal and system project → the
  WRITER refuses in the D2c order, named errors (the CLI surfaces them; its preflight only
  improves wording); DB error on the delete → the writer returns it, nothing deleted. The
  no-partial-work claim covers the EDGE write; the audit insert is best-effort by the
  repo-wide contract (D3b).
- **`meta.authorizedByMemberId` / `meta.via`** ride the existing `meta` argument of
  `auditWrite` — no contract change to the audit writer itself.

## 3. Acceptance criteria (spec-first; exact commands)

1. `npm run test:datamechanics:iso test/datamechanics/revoke-project.datamechanics.test.ts`
   exits 0 — the OBSERVABLE outcome: a member holding a restricted project's item ONLY through
   a granted group loses it from `visibleItemIds` after `revokeProjectFromGroup` (grant →
   visible → revoke → gone; both directions, real Postgres); a member holding the same item
   through a SECOND granted group still sees it after one group's revoke (set semantics, D4);
   the audit arm (D1): an operator revoke writes exactly one `audit_log` row with
   `action='access.project_revoked'`, `actor_kind='system'`, `member_id` NULL,
   `meta.authorizedByMemberId` = the named admin, `meta.via='cli'`, `meta.groupId` — and a
   `{ kind: "member" }` revoke writes `actor_kind='member'` with that id (both kinds pinned);
   the no-op arm (D3): revoking an absent edge returns `{ ok: true, revoked: false }` and
   writes NO audit row (count pinned before/after); the double-revoke arm: revoke twice →
   exactly one audit row.
2. Same file — the WRITER's refusals (D2/D2b/D2c), each with the edge PROVEN INTACT after
   the refusal (the not-invoked pin, round 1 L): revoking a `kind='system'` project refuses
   with the named error and the edge survives; an operator revoke authorized by a NON-admin,
   an INACTIVE admin, an EXTERNAL-POSTURE admin (round 2 B2 — the representable
   role-admin/external principal every app gate denies), and an unknown member id each
   refuse and the edge survives; the `{ kind: "member" }` shape with a non-admin refuses
   identically; the ORACLE arm (D2c): an invalid principal receives the SAME refusal
   whether the edge exists or not (both directions — the no-op shape is unreachable without
   authority). GRANT META (D1b):
   `grantProjectToGroup` with `authorizedByMemberId` writes it into the grant audit row's meta
   while the audit actor stays `system` and the edge's `added_by` stays NULL (the
   no-laundering pin, all three asserted); without the option, a grant still writes the
   existing shape — `system` actor, no `authorizedByMemberId` key in meta, NULL `added_by`
   (all three pinned, so the flag's absence is proven to change nothing).
3. `npx vitest run test/admin-cli-revoke.test.ts` exits 0 — the CLI verb's pure decision
   layer, extracted as a testable helper: missing `--actor` usage refusal (D1) and the
   slug/email resolution failures each die with a distinct message BEFORE any writer call
   (pinned with a spy/thrown-sentinel writer — the not-invoked half of round 1 L); the
   system-kind preflight message names the substrate (the admin.ts case-arm stays thin wiring
   like every other verb).
4. Mutations, verdicts verbatim in the PR: (a) delete the WRITER's system-kind refusal → the
   dm refusal arm reddens (the edge is severed); (b) delete the D3 probe (restore the blind
   audit) → the no-op dm arm reddens; (c) delete the revoke's `.delete()` leg → the
   enforcement dm arm reddens (the edge survives and visibility never narrows); (d) delete
   the WRITER's admin validation → the non-admin dm arm reddens.
5. Full tiers green: `npm test` · dm iso (sole tolerated reds: the pre-named TZ artifact +
   the known 5s-timeout flake class on heavy-seed suites, both probed green standalone) ·
   `npm run check:docs` · lint · tsc. ARCHITECTURE's access rows name the revoke verb + the
   no-op-no-audit rule; the admin skill/usage text gains the verb.

## 4. Out of scope, named

The dashboard grant/revoke UI (the access-UI phase, recorded at pret6-retirement.md §221 —
the CLI is the operator surface until that phase is scheduled; the `{ kind: "member" }` actor
shape is its ready seam); revoking builtin GROUP membership or system-project wiring (the
materializer owns those; the WRITER refuses); a `revoke-project --force` for system projects
(raw SQL remains the deliberate barrier); group deletion lifecycle; repairing the SAME
actor-laundering class in the pre-existing `add/remove-group-member` verbs (recorded by round
1 as live at admin.ts:271 — a follow-up row, not this slice); the EXCLSHADOW-1
exclude-shadow repair and the TICKSTALL-2 github-stage budget (the scout's other ranked
candidates — each its own slice); the transactional INSERT…RETURNING form for the probe/act
races (the recorded F3 deferral, unchanged); a transactional delete+audit pair (the audit
layer is best-effort by repo-wide design, D3b — reversing that is the adapter's transaction
surface, F3 again); surfacing `meta.authorizedBy` as a first-class Actor column in the admin
audit page (the audit-UI phase, D3c).
