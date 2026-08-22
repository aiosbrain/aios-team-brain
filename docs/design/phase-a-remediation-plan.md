# Phase A remediation — the plan after re-deriving all sixteen

**Status:** plan of record, 2026-08-22. Supersedes the per-slice deferral lists scattered across
`docs/design/auditfix*.md`. Every entry below was re-derived against the code, read-only, in three
parallel lanes; the working notes are in `.context/rederive/lane-{a,b,c}.md`.

## Why this pass happened

Four of the five audit tickets that were actually worked had a premise that was **false or badly
mis-sized**:

| ticket | what the ticket said | what was true |
|---|---|---|
| AUDITFIX-1 | a token reads every hand-entered row | **matched.** The only one that did |
| AUDITFIX-2 | connector content invisible 30-72 min | both premises false; the lag was already fixed by TICKSTALL-2 |
| AUDITFIX-3 | "fix is one conditional" | four enforcement points |
| AUDITFIX-4 | a swallowed read error | a concurrency problem; shipped at a fraction of scope after six rounds |
| AUDITFIX-15 | schedule an existing detector | **the detector was itself wrong** |

Most of the elapsed time in this program was spent discovering a ticket was wrong *after* writing a
spec for it. This pass front-loads that discovery for the remaining sixteen.

## The result

**Three items are effectively deleted, two merge, and four shrink.**

| # | ticket said | re-derived | disposition |
|---|---|---|---|
| **10** | "~24 more swallowed reads on the access path" | 52 sites enumerated: **33 fail-closed · 10 cosmetic · 6 dead code · 1 handled · 2 fail-open.** One fail-open dies with TIERRET-1 | **CLOSE.** Fold 2 lines into -3 |
| **12** | "~293 lines rewritten as raw SQL" | figure not derivable at any commit; **has no file of its own** | **MERGE into -13** |
| **11** | drain reports success while an item lacks a membership | the skip needs a row that has since cascade-deleted — harm near-vacuous | **SHRINK** to a skip counter |
| **15C** | the banner copy must broaden | **LLMOBS-1 already ruled this exact trade** — a leg the ingestion sentence can't describe moves OFF that banner | **MOOT** |
| **15B** | the health check never runs | narrower: the unpartitioned arm is already proxied by the `context_backfill` leg. The uncovered arm is the **blind-human** check. And the CLI already exits non-zero — what is missing is a *caller*, not a surface | **SHRINK** to ~0 repo files |
| **14** | needs item ids threaded through four importers | **false.** `backfillTeamContext(…, {createdBefore})` needs no ids and is candidate-only since TICKSTALL-2 | **SHRINK** to small |
| **17** | unbounded per-request loop | the scanner caps at 20 (`codebase.py:159`). Real exposure is a team-tier key bypassing it, **plus** a content-length header assertion that chunked encoding walks past | **RESHAPE** |
| **18** | needs a whole-program call graph | **false.** Reverse import closure to a fixpoint over-approximates, fails closed, and reuses the existing controls | **SHRINK** to medium |
| **13** | ingest rewrites `items.access` without coordinating | real, but it fails toward **denial**. The correct justification: `noWideningGate` is the concurrency backstop and **TIERRET-1 deletes it** | **RE-JUSTIFY** |
| **3** | hands outsiders the corpus | severity is **irreversibility**, not disclosure — and the accidental path (bootstrap adopting a legitimately-named `general`) is the real one | **RE-FRAME** |
| **7** | the row "cannot be tested against scope" | **false** — hand-entered rows carry `project_id`, and the token path computes the project set then discards it | **NEEDS RULING** |

## The ordering correction that matters

**TIERRET-1 does not shrink everything. It ENLARGES AUDITFIX-3.**

The tier filter is already gone from the item primitive (`lib/access/enforce.ts:9-12,69-89`), so a
mis-granted group already reads the whole General corpus today. What still partially masks a bad grant
are the `audience` conjuncts TIERRET-1 removes. **Schedule -3 before or with TIERRET-1.**

## Sequence

**Wave 0 — decide (blocks nothing, unblocks two).** The AUDITFIX-7 ruling, because TIERRET-1 rewrites
the same predicate and it should be rewritten once.

**Wave 1 — three parallel lanes, disjoint files.**
- **Lane A:** `13 + 12` merged — the serialization protocol, via an **executor seam** rather than a raw-SQL
  rewrite, so the EXCLSHADOW-1/CLOSEMODE-1 rulings are never retyped.
- **Lane B:** `17 → 14 → 18` in that order. -17 first (independent, cross-repo contract seam). -14 next
  (small, live defect, stabilises the tree). -18 last — it **subsumes -14's detection half**, so landing
  -14 first makes -18's inventory a checkable fact rather than a discovery.
- **Lane C:** `3` (with -10's two lines folded in) + `11` + `15B`.

**Wave 2 — TIERRET-1**, after Lane A and -3. It then deletes `noWideningGate`, one of -10's fail-opens,
and part of -7's predicate.

**Wave 3 — re-triage** `5`, `6`, `16` against the smaller codebase.

## Standing rules this pass produced

1. **A ticket premise is a hypothesis.** Re-derive before speccing. 4-of-5 were wrong.
2. **A deferral reason is also a hypothesis.** Two of the deferral reasons in this program's own docs
   (-14's "needs id threading", -18's "needs a call graph") were false, and both made an easy fix look
   expensive for weeks.
3. **A criterion that lives only in prose pins nothing.** AC5, then AC9/AC10, in one slice.
4. **Check for a precedent before designing.** 15C dissolved into a ruling already in the tree.
