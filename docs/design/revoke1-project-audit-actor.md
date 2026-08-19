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

- **D1 — the actor story: `--actor <member-email>` is REQUIRED on `revoke-project`, and must
  resolve to an ACTIVE member with `role='admin'` on the target team.** The operator names the
  human who authorized the narrowing; the audit row carries `actor_kind='member'` + that real
  member id (+ `meta.via='cli'` so the transport is not laundered). No `--actor` → usage die
  BEFORE any read (fail closed; the verb never fabricates or nulls an actor). Rationale: the
  recorded objection was to a destructive act attributed to nobody — the answer is to supply
  the real principal, not to widen `revokeProjectFromGroup`'s non-nullable contract. A
  non-admin or inactive or unknown email dies with a distinct message (no partial work).
- **D1b — grant-project gains OPTIONAL `--actor <member-email>` symmetry** (same resolution,
  same admin requirement when provided): the grant trail's `actor_kind='system'` rows are a
  recorded weakness of the ENFB-2 verb; when the operator knows the authorizing human they can
  now record them. Absent → today's null/system behavior stands (grants are additive — the
  contract question was only ever about the destructive direction). The usage line drops its
  "(null CLI actor)" claim only for the flagged path.
- **D2 — SYSTEM projects are unrevokable through this verb.** `kind='system'` project →
  refuse with a named error before any write. Prod's ONLY current edges are the system wiring
  (measured above); the builtin materializer owns them, and severing general/external-shared
  from Everyone/External breaks every enforced read at once. An operator who genuinely needs
  that surgery is doing something this verb should not make easy.
- **D3 — no-op revokes do not audit.** `revokeProjectFromGroup` today deletes blindly and
  audits UNCONDITIONALLY — revoking a non-existent edge would write an `access.project_revoked`
  row for a revocation that revoked nothing (an over-reporting trail is a lying trail). The
  function gains a probe-first shape (the same existence-probe idiom `grantProjectToGroup`
  uses, groups.ts:475-482) and returns `{ ok: true, revoked: false }` with NO audit row when
  the edge is absent; `revoked: true` + the audit row only for a real deletion. Zero callers
  today — the return-shape move is free. The bounded probe/act race mirrors the grant's
  recorded one (two concurrent revokes can both probe-hit and both audit — the trail
  over-reports the same ms-apart act, never under-reports; deferred with the same F3 reason).
- **D4 — effect and repair story, stated:** revocation is COMPUTED into effect on the next
  read (`visibilityHash` changes → every cache variant re-keys; no cascade, no sweep, nothing
  stored to repair — the ENFB-4 precedent). Content already curated into the revoked project
  stays where it is; members holding it through ANOTHER group keep seeing it (set semantics,
  no precedence question). A wrong revoke is repaired by `grant-project` — the two verbs now
  form the closed loop the program promised.

## 1. The surface table

| Surface | Today (file:line) | This slice |
|---|---|---|
| `revoke-project` CLI verb | ABSENT — `scripts/admin.ts:306-308` records the deferral + reason | `revoke-project <group-slug> <project-slug> --actor <admin-email> [--team …]`: resolve team → group → project (existing die-with-usage shapes), REFUSE `kind='system'` (D2), resolve + validate the actor (D1), call the sole writer, report `revoked`/`no grant to revoke` |
| `revokeProjectFromGroup` (lib/access/groups.ts:493-508) | blind delete + UNCONDITIONAL audit; zero callers | probe-first: absent edge → `{ ok: true, revoked: false }`, no audit; present → delete + audit with the real actor (D3). Signature keeps `actorMemberId: string` (non-nullable — the point) |
| `grant-project` CLI verb (scripts/admin.ts:285-313) | hardcodes `null` actor → `actor_kind='system'` audit rows (3 in prod) | optional `--actor <admin-email>` (D1b); absent → unchanged null path |
| audit trail (`audit_log` via `auditWrite`) | grants: `system` actor; revokes: none exist | revokes always `actor_kind='member'` with a real admin id + `meta.via='cli'` + `{ groupId }`; no row for no-op revokes |
| enforcement/caches | `visibilityHash` from the sorted project set (enforce.ts:170) | UNCHANGED — the computed gate is the mechanism; stated, not built (D4) |

## 2. Mechanism notes

- **One writer, one file.** All edge writes stay in `lib/access/groups.ts` (the
  access-chain single-writer guard, `test/guards/access-single-writer.test.ts`, keeps every
  other file refusable). The CLI verb only resolves names → ids and calls the writer.
- **Actor resolution in the CLI, validation at the seam:** the verb resolves the email via the
  existing `memberIdByEmail` helper (admin.ts:103) and then validates role+status with one
  bounded read; the writer keeps trusting its non-nullable `actorMemberId` (its contract —
  callers supply a real principal — is exactly what D1 preserves).
- **Fail directions:** unknown team/group/project/email → die before any write (existing
  shapes); non-admin/inactive actor → die, named; system project → die, named; DB error from
  the writer → die with the writer's error. Nothing partially applied — the only write is the
  single delete+audit pair.
- **`meta.via='cli'`** rides the existing `meta` argument of `auditWrite` — no contract change.

## 3. Acceptance criteria (spec-first; exact commands)

1. `npm run test:datamechanics:iso test/datamechanics/revoke-project.datamechanics.test.ts`
   exits 0 — the OBSERVABLE outcome: a member holding a restricted project's item ONLY through
   a granted group loses it from `visibleItemIds` after `revokeProjectFromGroup` (grant →
   visible → revoke → gone; both directions, real Postgres); a member holding the same item
   through a SECOND granted group still sees it after one group's revoke (set semantics, D4);
   the audit arm: the revoke writes exactly one `audit_log` row with `action='access.project_revoked'`,
   `actor_kind='member'`, the real actor id, and `meta.groupId`; the no-op arm (D3): revoking
   an absent edge returns `{ ok: true, revoked: false }` and writes NO audit row (count
   pinned before/after); the double-revoke arm: revoke twice → exactly one audit row.
2. Same file — `grantProjectToGroup` with a real actor writes `actor_kind='member'` (D1b's
   lib half is already true — pinned so the CLI flag has a contract to ride); with null it
   stays `system` (the existing contract, both directions).
3. `npx vitest run test/admin-cli-revoke.test.ts` exits 0 — the CLI verb's pure decision
   layer, extracted as a testable helper: system-project refusal (D2), missing `--actor`
   usage refusal (D1), non-admin/inactive/unknown actor refusals — each a distinct message,
   asserted by shape (the admin.ts case-arm stays thin wiring like every other verb).
4. Mutations, verdicts verbatim in the PR: (a) delete the D2 system-kind refusal → the unit
   suite reddens; (b) delete the D3 probe (restore the blind audit) → the no-op dm arm
   reddens; (c) delete the revoke's `.delete()` leg → the enforcement dm arm reddens (the
   edge survives and visibility never narrows).
5. Full tiers green: `npm test` · dm iso (sole tolerated reds: the pre-named TZ artifact +
   the known 5s-timeout flake class on heavy-seed suites, both probed green standalone) ·
   `npm run check:docs` · lint · tsc. ARCHITECTURE's access rows name the revoke verb + the
   no-op-no-audit rule; the admin skill/usage text gains the verb.

## 4. Out of scope, named

The dashboard grant/revoke UI (the access-UI phase, recorded at pret6-retirement.md §221 —
the CLI is the operator surface until that phase is scheduled); revoking builtin GROUP
membership or system-project wiring (the materializer owns those; D2 refuses); a
`revoke-project --force` for system projects (raw SQL remains the deliberate barrier);
group deletion lifecycle; the EXCLSHADOW-1 exclude-shadow repair and the TICKSTALL-2
github-stage budget (the scout's other ranked candidates — each its own slice); the
transactional INSERT…RETURNING form for the probe/act races (the recorded F3 deferral,
unchanged).
