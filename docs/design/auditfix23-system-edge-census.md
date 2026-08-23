# A forbidden system-project grant is FOUND without an operator asking — AUDITFIX-23

**Status:** spec, round 0. No code written. Split out of AUDITFIX-22 at its round 2; this is the
CENSUS + operator-surface half.

**Build with:** opus / high — it changes what an operator's health verdict means, and a detector that
reports green while broken is worse than none.

**Deps:** **AUDITFIX-22 (merged 909fa8d7)** — a census reported through a masked leg is invisible, which
is why the ledger shipped first. **AUDITFIX-3 (merged 3757aa4c)** — this consumes its
`isSanctionedSystemEdge` predicate. Repair is AUDITFIX-21 and is NOT required first (§3).

---

## What and why

**What:** every scheduler tick censuses each team's `kind='system'` projects for edges the writer
would refuse, reports them as that team's failure, and `assessAccessHealth` gains the same assertion
for the operator-asks path.

**Why:** AUDITFIX-3 closed the door on NEW forbidden edges. Nothing looks for one that already exists —
and `revokeProjectFromGroup` still refuses every `kind='system'` revocation, so such an edge is
invisible AND unrepairable. This slice makes it visible. It stays unrepairable until AUDITFIX-21 (§6).

## 0. Terrain, measured before designing

### 0a. Production, read-only, 2026-08-23 UTC

| | |
|---|---|
| `kind='system'` projects | **2** — `general`, `external-shared`. **Zero** non-reserved ones |
| edges on them | **3**, all sanctioned |
| forbidden edges | **0 — the defect is LATENT**, exactly as at AUDITFIX-3 |
| teams | **1** |

So this slice changes nothing on this fleet. Its value is a self-hosted instance whose state nobody
has audited, and this fleet's own future.

### 0b. ⚠️ The channel this slice depends on is deployed but NOT yet exercised

AUDITFIX-22 merged and deployed at **18:37 UTC**; the newest `access_bootstrap` row is **18:05 UTC**,
i.e. the last tick of the OLD code. No tick has yet run under the per-team ledger, so *"a per-team
failure is loud on that team's card"* is **proven in the dm tier and not yet observed in production.**

That is stated rather than assumed because this slice's whole output flows through that channel. The
build should re-check prod once a tick has run; if the ledger did not take effect, this slice reports
into a masked leg and its value is zero until that is fixed.

### 0c. What the writer already refuses, which the census must MATCH

`isProtectedProject` is `kind === 'system' || (kind === 'source' && reserved slug)` and
`isSanctionedSystemEdge` keys on the **project slug** (`lib/access/system-projects.ts`). Read together
for a `kind='system'` project with a **non-reserved** slug — say `legacy-system` — **no edge is ever
sanctioned**, so the writer refuses every grant to it. That is shipped behaviour today.

**The census must therefore report every edge on such a project**, or detection is narrower than the
prevention it exists to observe. §2b says why that is the right reading rather than a bug to work
around.

### 0d. What is NOT measured

Nothing here observes a fleet with more than one team, or a non-reserved `kind='system'` project,
because prod has neither. Both are proven in the dm tier with seeded fixtures only.

## 1. The rule

> **Every tick, for every team, every edge on every `kind='system'` project that the writer would
> refuse is reported as that team's failure — and neither the census nor the health check may report
> healthy from a read it could not complete.**

## 2. The design

### 2a. The census runs in the all-teams wrapper, after each team's convergence ATTEMPT

`ensureAccessBootstrapAllTeams` (`lib/access/bootstrap.ts`) gains a per-team census after the
convergence attempt, and its result is folded into that team's `TeamBootstrapOutcome` — so
AUDITFIX-22's ledger records it as that team's `ok:false` row with no further plumbing.

⚠️ **It runs REGARDLESS of the convergence result, including the THROW path.** `ensureAccessBootstrap`
has six early returns, so a census at the END of it never runs on a wedged team: General wedged by a
reserved-slug initiative means every tick returns at the General leg, and a forbidden edge on an
already-system `external-shared` is **never named, on any tick, forever**. And a `catch … continue`
that skips the census on a throw satisfies a criterion written only against a returned failure, so the
criteria must force a throw too.

**A post-attempt census is still safe on the converge-first rule** AUDITFIX-3's round 2 established:
convergence is attempted first, so a missing sanctioned edge is restored before the census reports.
The census is **read-only**, so it can never be the reason a sanctioned edge stays missing.

**Both errors are aggregated into one outcome**, so a convergence failure and a census finding on the
same team hide neither.

**Fails closed:** a census read error is that team's failure, never "no forbidden edges".

### 2b. Scope: every `kind='system'` project, and every edge on a non-reserved one

The census reads every `kind='system'` row for the team, joined to its `project_groups` edges and
their groups in ONE statement — the shape AUDITFIX-3 established for
`censusUnsanctionedSystemEdges`, whose per-project form this generalises. An unresolved group is
**unsanctioned, never absent**.

⚠️ **For a non-reserved system project, EVERY edge is reported, and that is deliberate.** The
alternative — treat an unknown system slug as "anything goes" — would make the census disagree with
the writer, which refuses all of them (§0c). The census's job is to find what the writer would refuse;
a detector that disagrees with the thing it observes is worse than none. Such a project can only exist
out of band, which is precisely the population this slice is for.

### 2c. The operator-asks path, and the CLI's own words

`assessAccessHealth` gains the same assertion.

⚠️ **It must read `projects.kind`.** Its project read selects `id, slug` and filters to the two
reserved slugs (`lib/admin/access-health.ts:68-72`). A slug-keyed census would flag the **legitimate
creator grant** on a reserved-slug `kind='initiative'` project — reversing the exact AUDITFIX-3 ruling
that such a project stays grantable to its creator. And filtering to two slugs would miss the
non-reserved system project entirely (§0c).

⚠️ **Widening `blockers` changes what the CLI PRINTS, and leaving that alone ships false operator
output.** Today the field means lock-OUT and `printHealth` renders `health: LOCKOUTS`
(`scripts/admin.ts:99`). A team with no lockout but one forbidden edge would print `LOCKOUTS`, which is
untrue. So `blockers` becomes *"a human locked OUT, or a group let IN that the substrate never
sanctioned"*, and **all four** places that say lockout change with it: the interface doc
(`lib/admin/access-health.ts:30`), the module header (`:14`), the CLI help (`scripts/admin.ts:83`), and
the verdict itself (`:99` → `ACCESS VIOLATIONS`). Filing it under `warnings` is not an option: warnings
are non-fatal, so `healthy` would stay `true` — the report-green-while-broken failure this slice exists
to prevent.

## 3. Scope

**In:** `lib/access/bootstrap.ts` (the per-team census + its placement) · `lib/access/groups.ts` (the
team-wide census read, which must live in the single-writer file for the same coarse-net reason
AUDITFIX-3 recorded) · `lib/admin/access-health.ts` · `scripts/admin.ts` · `docs/ARCHITECTURE.md`.

**Out:**
- **Repair — AUDITFIX-21.** This slice REPORTS; it never deletes. A fail-open destructive repair is
  worse than a reported hole (inherited from AUDITFIX-3 §3).
- **The staleness-beat fossil — AUDITFIX-24**, accepted and pinned by AUDITFIX-22.
- **Any change to the ledger** — AUDITFIX-22 shipped it; this slice only feeds it.

## 4. Acceptance

⚠️ **Two shapes are pre-empted rather than rediscovered:** every fixture precondition is asserted, and
every BOOTSTRAP-fault injector fails **reads only**. AUDITFIX-3 shipped five criteria that were green
while testing nothing; AUDITFIX-22 shipped two more, one of which was a **race that could pass its own
mutation by scheduling luck**. No criterion here may depend on timing.

- **AC1 — a forbidden edge on a RESERVED-slug system project is reported (dm):** plant `general→vendors`
  out of band; `ensureAccessBootstrapAllTeams` returns that team failed and the error names the edge.
- **AC2 — and on a NON-reserved `kind='system'` project (dm):** `slug='legacy-system'` granted to
  `vendors`. *§0c — a two-slug census satisfies AC1 while this stays invisible to both surfaces.*
- **AC3 — the census runs when CONVERGENCE RETURNED a failure (dm):** wedge General with a
  reserved-slug initiative **and** plant a forbidden edge on an already-system `external-shared`; the
  team's single outcome names **both**.
- **AC4 — and when convergence THREW (dm):** same fixture with the convergence made to throw; the
  outcome still names the census finding. *A `catch … continue` that skips the census passes AC3.*
- **AC5 — convergence still happens BEFORE the census (dm):** seed a forbidden edge **and** remove the
  LAST of the three sanctioned edges; the call reports the forbidden edge **and** the sanctioned edge
  is restored. *The three grants are sequential, so removing whichever is granted first would pass
  while a census wedged between grants still blocks the others.*
- **AC6 — the census FAILS CLOSED (dm):** with the edge read faulted, that team is reported failed; it
  never reports "no forbidden edges" from a read it could not complete.
- **AC7 — a legitimate reserved-slug INITIATIVE is NOT reported (dm):** with its creator grant present,
  neither the census nor `assessAccessHealth` flags it. *Round 1 of AUDITFIX-22 — a kind-blind
  implementation reverses AUDITFIX-3's ruling.*
- **AC8 — a clean team is not reported (dm):** returned unfailed. *Without it, a census that always
  failed would pass AC1-AC6.*
- **AC9 — the finding reaches the TEAM'S CARD through AUDITFIX-22's ledger (dm):** with a forbidden
  edge planted, two ticks of the real leg put `access_bootstrap` in `failing` with `failureClass`
  `confirmed` and `healthy === false` for that team, and another team stays green. *The end-to-end
  claim; asserted at the confirmed threshold, because a lone failure never enters `failing`.*
- **AC10 — `assessAccessHealth` reports a forbidden edge on BOTH project shapes and goes
  `healthy:false` (dm):** reserved-slug and non-reserved, each with the blocker naming project and
  group. *Two fixtures, or an implementation censuses everything in the scheduler path and only two
  slugs here.*
- **AC11 — `assessAccessHealth` stays healthy on a clean team (dm):** the inverse control.
- **AC12 — `assessAccessHealth` FAILS CLOSED (dm):** with its edge read faulted, it does not certify
  `healthy:true`.
- **AC13 — the CLI PRINTS the widened meaning (unit):** `printHealth` on a health object whose only
  blocker is an over-exposure renders **`ACCESS VIOLATIONS`**, not `LOCKOUTS`. *Asserting only the
  returned object leaves the operator reading a false word.*

**Mutation coverage, one per enforcement point, each reddening ITS OWN criterion:**

| # | mutation | must redden |
|---|---|---|
| 1 | census only the two reserved slugs | AC2 |
| 2 | census only `general`, not every system project | AC1 |
| 3 | skip the census when that team's convergence returned a failure | AC3 |
| 4 | skip the census on the throw path | AC4 |
| 5 | run the census BEFORE the three sanctioned grants | AC5 |
| 6 | run the census BETWEEN the first and second grant | AC5 |
| 7 | swallow the census read error | AC6 |
| 8 | drop the `kind` conjunct so reserved SLUGS are censused regardless of kind | AC7 |
| 9 | delete the census's unsanctioned-edge check | AC1 |
| 10 | drop `assessAccessHealth`'s new blocker | AC10 |
| 11 | make `assessAccessHealth` census only the two reserved slugs | AC10 |
| 12 | swallow `assessAccessHealth`'s edge-read error | AC12 |
| 13 | keep the CLI verdict text as `LOCKOUTS` | AC13 |
| 14 | report the census finding without failing the outcome | AC9 |

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| The census never runs on the team that most needs it | the loudest case is the silent one | AC3 + AC4, mutations 3 and 4 |
| Detection narrower than the prevention it observes | a forbidden edge the writer refuses stays invisible | AC2 + AC10, mutations 1, 2, 11 |
| A kind-blind census flags a legitimate initiative grant | AUDITFIX-3's ruling reversed, a creator stranded | AC7, mutation 8 |
| The census fires before convergence and leaves a team half-wired | the detector CAUSES the damage | AC5, mutations 5 and 6 |
| The CLI keeps printing `LOCKOUTS` for an exposure | false operator output | AC13, mutation 13 |
| The finding is reported but never reaches a surface | a detector nobody hears | AC9, mutation 14 |
| Someone reads the merge as making the edge repairable | wasted expectation | §6 |

## 6. What this slice does NOT prove

A detected edge is still **not repairable** through the sanctioned path: `revokeProjectFromGroup`
refuses every `kind='system'` revocation, and `lib/access/revoke-verb.ts` refuses again before the writer is
reached. Until **AUDITFIX-21**, repair is raw SQL. A merge here means *"you will now be told"*, not
*"it is now fixable"*.

**Nothing is built. No code exists for this slice.**
