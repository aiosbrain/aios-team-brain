# STAGINGMARK-4 — a value on a boolean admin flag is refused, not coerced

Status: spec, **rounds 1 (design) and 2 (diff) folded** (Fable CLEAR-WITH-CONDITIONS — 3 HIGH + 3 MEDIUM + 3 LOW, all
re-derived and confirmed by measurement; one severity claim of mine corrected down). Written by
`gpt-6-astra` (reasoning effort `low`); folded by the orchestrator. No code written.
· Task: `STAGINGMARK-4` · Owner: chetan · Tier build-with: unit — this is argument parsing; there is
no persistence or HTTP surface, and the writers it gates are unchanged.

## Deps

None to deploy. Baseline HEAD `1807f074`. STAGINGMARK-1's shipped `parseConfirmFlags` is the
precedent this generalises, not a dependency.

## Increment

ONE PR: a shared strict-arity boundary that refuses a value on a boolean flag, adopted by **both**
CLIs that carry the trap, with the registry proven complete by a build-failing guard. **This document
is the design; the PR that follows implements it** — the files under Scope are what that PR touches.

## Problem

`scripts/admin.ts:34-51` is a tokenizer that, for `--x`, consumes the NEXT token as a STRING unless
that token is absent or starts with `--`. So `--confirm false` yields the string `"false"`, and
`purge-items` tests `if (!flags.confirm)` (`:540`) — a non-empty string is truthy, so **an operator
who typed the opposite gets a confirmed, irreversible delete**.

**Seven names in `scripts/admin.ts` are read by truthiness**, each carrying the same coercion:
`help` (`:127`), `upsert` (`:163`), `hard` (`:231`), `force` (`:413`, `:426`, `:448`),
`confirm` (`:486`, `:540`), `dry-run` (`:486`), and `confirm-production` (already strictly parsed by
`lib/access/materialize-command.ts`).

**And the tokenizer is duplicated.** `scripts/brain-tasks.ts:54-70` is a byte-identical copy — the
spec's first draft called `parseArgs` "the sole tokenizer", which is true of `admin.ts` only. It
reads `help` (`:135`), `clear-sprint` (`:180`), `dry-run` (`:265`, `:271`, `:279`) and
`project-to-linear` (`:279`) by truthiness. `extract-meeting-todos --project-to-linear false`
therefore performs an **outward-facing write to Linear**. That is why the registry below is a
per-CLI parameter rather than a fixed list of seven.

**Consequences are not uniform, and severity is not simply "destructive first."** `--confirm false`
on `purge-items` and `--hard false` on `delete-member` (which selects removal over the soft-disable
default) are the irreversible ones; `--project-to-linear false` writes outside the system;
`--force false` defeats collision protection on identity linking. `--dry-run false` turns dry-run
*on*, which fails safe. `--help false` is a correctness annoyance. An earlier draft of this spec
implied a clean severity ordering from the flag reads alone; that was not supported and is withdrawn.

**The `=` form is a different shape.** `--confirm=false` makes the whole token the KEY, so the flag
goes unseen and the command silently dry-runs — fail-closed, but silently ignoring what was typed.

**Repetition erases the malformed token.** Measured against the verbatim tokenizer:
`--confirm false --confirm` → `{confirm: true}`. STAGINGMARK-1's `parseConfirmFlags` receives a
collapsed map, so it **cannot** see the discarded `"false"` and accepts the run. Its AC8 tests maps,
not raw argv. Scoped honestly (Fable, MEDIUM): this is a **strictness gap, not a live hole** — the
reverse order `--confirm --confirm false` is refused (last wins), and the erasing spelling requires
ending in a bare `--confirm`, which is the confirmed spelling anyway. The new boundary closes it by
validating raw argv; `materialize-command.ts`'s logic is not rewritten.

## Decision

**D1 — one shared boundary, with the boolean registry as a PER-CLI PARAMETER.** Not a purge-only
patch (leaves `--hard` and Linear exposed) and not a parser rewrite (option (c) would re-decide 12
value-taking flags and the `flags.actor === true` refusals). Every command routes through it, so a
destructive command cannot forget to opt in. `admin.ts` registers
`{help, upsert, hard, force, confirm, dry-run, confirm-production}`; `brain-tasks.ts` registers
`{help, clear-sprint, dry-run, project-to-linear}`. Covered by AC1, AC2, AC8.

**D2 — validate RAW argv, before the collapse.** Extract the tokenizer unchanged into
**`lib/admin/args.ts` (a NEW file, created by this PR)** and export `parseAdminArgs(argv, registry)`,
which validates raw tokens and only then tokenizes. Returns a discriminated result; the error carries
no parsed payload. Refuse a registered boolean followed by any token not starting with `--`
(including `false`, `true`, `0`, `yes`, `""`, `-x`, and an ordinary positional), refuse
`--<boolean>=...`, and never let a later bare occurrence erase an earlier malformed one. **Do not
echo the offending value** — it may be an adjacent password. Covered by AC1-AC3.

**D3 — an adjacent positional is an error, not confirmation.** `purge-items --confirm extra`
refuses rather than treating `extra` as a positional and confirming. **Verified compatible**: every
USAGE line and every doc invocation places positionals first and booleans last, and every
undocumented boolean-then-positional spelling either already fails at usage today or IS the bug.
Covered by AC4.

**D4 — validate before help, before the `DATABASE_URL` check, before client construction.** `main`
calls the boundary once and routes failure through `die` (exit 1). **This changes one shipped
behaviour: `help --confirm false` exits 0 today and will exit 1** — help must not mask a malformed
invocation. Downstream consumers keep their truthiness reads, because a registered name can now only
be absent or literal `true`; that also keeps the existing text guard
`test/guards/admin-cli-destructive-commands.test.ts:44-56` green. Covered by AC5, AC7.

**D5 — an importable `main`, not a subprocess module loader.** The first draft proposed spawning the
real CLI behind a custom loader with counting fakes. Measured: one spawn is **1.96 s**, and that
matrix is 150+ spawns (5+ minutes) in a tier CI runs under `npm run coverage`, plus a side channel
for cross-process counts. Instead, follow the in-repo precedent at `scripts/setup-wizard.mjs:298`:
gate module-scope `main()` on an `argv[1]` entry check, export `main(argv)`, and make `die` throw a
typed exit error converted to `process.exit` only at that guarded entry. AC7 then runs **in-process**
under vitest with `vi.mock` (five existing tests already mock `@/` modules). ~6 real spawns remain,
only for the claims that need a real process. The first draft cut this as "repository-wide main/exit
cleanup"; that was a misnomer — it is `die` plus one bottom-of-file guard, and it is exactly what
separates the light harness from the heavy one. Covered by AC6, AC7.

## Scope

**In:**
- `lib/admin/args.ts` **(new)** — the extracted tokenizer plus `parseAdminArgs(argv, registry)`.
- `scripts/admin.ts` — adopt the boundary; export `main(argv)`; argv entry guard; `die` throws;
  USAGE gains the bare-only rule and lists `--dry-run`.
- `scripts/brain-tasks.ts` — adopt the same boundary with its own registry.
- `test/admin-args.test.ts` **(new)** — raw-argv matrix + the compatibility golden.
- `test/admin-cli-arity.test.ts` **(new)** — in-process CLI assertions via `vi.mock`, plus the few
  real spawns.
- `test/guards/admin-flag-registry.test.ts` **(new)** — registry completeness, ∀ over both CLIs.
- `lib/access/materialize-command.ts:58-59` and `test/access-materialize-command.test.ts:201-202` —
  **comment text only.** Both currently say the trap "is live today on `purge-items`", which this PR
  makes false. Editing a comment is not a change to a shipped defense.
- `docs/ARCHITECTURE.md:1438` — the documented `purge-items` invocation gains the bare-only rule
  (CLAUDE.md §1 requires the map updated in the same PR).

**Cut, with reasons:**
- **Value-flag validation** (types, requiredness, unknown keys, excess positionals, short options,
  a `--` terminator): option (c)'s surface. Preserve today's behaviour exactly except adjacency to a
  registered boolean. Not deferred to a ticket because nothing is broken there — the existing
  `flags.actor === true` refusals already cover the one real case.
- **Coercing `false` to OFF**: rejected deliberately. Omission is OFF; an explicit value is an error,
  never a guessed instruction to proceed.
- **`materialize-command.ts`'s LOGIC and its dm tests**: the boundary closes the repetition gap
  upstream (AC3); rewriting the shipped defense would be churn. Comments only, as above.
- **Purge/member/identity writers, schema, graph, caches**: no algorithm or persistence change.

## Acceptance criteria

Each criterion is parameterised over every registered name and both CLIs unless stated. Every fake
records call COUNTS; a throwing fake alone is not proof of non-invocation.

- **AC1 — a bare boolean yields literal `true`, and absence yields absent (unit):** for each
  registered name, `parseAdminArgs` returns `flags[name] === true` for a bare flag at end or before
  another `--flag`, and the key is ABSENT when omitted. No successful parse ever returns a string for
  a registered name. *The inverse half: absence must not become `false`, which would change
  truthiness reads.*
- **AC2 — every value form is REFUSED (unit):** `ok === false` for each registered name against
  `false`, `true`, `0`, `yes`, `""`, `-x`, an ordinary positional, and `--name=<v>` for each of those
  values. The error names the flag and the fix, **does not contain the offending value** (asserted
  with a sentinel like `hunter2`), and carries no parsed payload. Bare forms succeed with no
  diagnostic.
- **AC3 — a later bare occurrence cannot erase an earlier malformed one (unit):**
  `["--confirm","false","--confirm"]` returns `ok === false`. Both orders, and the `=` form beside a
  bare one, refuse. Two bare occurrences succeed. *Asserted on raw argv, because the collapsed map
  provably cannot represent this: the verbatim tokenizer yields `{confirm: true}`.*
- **AC4 — a boolean immediately followed by a positional refuses (unit):**
  `purge-items --confirm extra` → `ok === false`; `delete-member user@example.com --hard` → succeeds
  with the email as a positional and `hard === true`; a boolean before another `--flag` does not
  swallow it or its value.
- **AC5 — a malformed invocation fails on ARITY, not incidentally (unit, real spawn):** the process
  exits 1 **and stderr matches `/takes no value/` and does NOT match `/DATABASE_URL/` nor
  `/server-only/`**. *This wording is load-bearing and replaces a vacuous first draft: measured on
  HEAD, `purge-items --confirm false` with `DATABASE_URL` unset ALREADY exits 1 printing
  `✗ DATABASE_URL is required`, and with a dummy URL exits 1 on connection refusal — so "exit 1 with
  zero writer calls" is green before any change and discriminates nothing. Run with `DATABASE_URL`
  both unset and set to a dummy.* Also pinned: **`help --confirm false` exits 0 on HEAD and 1 after**
  (the one deliberate behaviour change), and valid `help` still exits 0 and prints usage.
- **AC6 — the extraction changes no value-flag behaviour (unit, compatibility pin):** a golden over
  every current command and value name (`team`, `name`, `handle`, `role`, `tier`, `password`,
  `base-url`, `ttl-min`, `actor`, `email`, `ids`, `reason`, `org`) comparing `cmd`, `positionals` and
  `flags`. **Expected values are generated by replaying the HEAD tokenizer**, never hand-written from
  the new one. *Labelled characterization on purpose — it pins a pure extraction, and is the one
  place in this spec where that is legitimate.*
- **AC7 — the real CLI consumes the validated result (unit, in-process with `vi.mock`):** with
  counting fakes, a malformed invocation of each destructive path makes **zero** writer calls —
  `purgeItemIds`, `deleteMember` with `hard`, and `brain-tasks`' Linear projection — while the
  corresponding bare form makes exactly one with the expected arguments. Bare `--dry-run` and absent
  `--confirm` both still preview. *Pin the call site, not the helper: **deleting the boundary call
  from either CLI must redden this**, demonstrated by an executed mutation, not asserted in prose.*
- **AC8 — the registry is provably complete (unit guard):** ∀ over `scripts/admin.ts` AND
  `scripts/brain-tasks.ts` — every truthiness read (`Boolean(flags.x)`, `!flags.x`, `flags.x &&`,
  bare `flags.x` in a condition) is IN that CLI's registry, every `as <value type>` / `typeof === "string"`
  read is NOT in it, an `as` cast is classified by its ASSERTED TYPE (boolean-only => boolean read;
  a value type => value read; `any`/`unknown`/`as const`/a type reference => UNRESOLVABLE, so the
  forall clause fires), **any flag NAME with no classified read anywhere fails as `unclassified read:
  <name>`** (per NAME, not per occurrence — see the recorded gap below), a name in both classes fails, and `CONFIRM_KEYS` from
  `lib/access/materialize-command.ts` is a subset of `admin.ts`'s registry (read from the
  DECLARATION via the AST — not an import and not a copied literal, so it cannot drift). *Negative controls, both required: one `flags.newflag &&` read, AND each unclassified spelling
  that defeated the existential form — `flags.wipe !== undefined`, `const w = flags.wipe; if (w)`,
  `flags.wipe ?? false`, `flags.wipe || false`. Without the unclassified clause the guard is
  EXISTENTIAL: it proves things about the spellings it recognises and is silent on the rest.
  **Recorded residual:** the clause is per NAME, so one classified read blesses the name's other
  reads; a value-classified flag truthiness-gated in an unrecognised spelling still passes. Pinned
  as an `it.fails` gap rather than claimed closed — per-occurrence strictness would require 37
  unrelated read rewrites across both CLIs (measured by the diff review: 17 of 46 in `admin.ts`,
  20 of 57 in `brain-tasks.ts`). Without this a
  future boolean flag silently reintroduces the trap, and this is the criterion the first draft was
  missing entirely.*

## What would falsify this

- A successful parse returning a registered boolean as a string, or a malformed occurrence erased by
  repetition (AC2, AC3).
- A parser suite green while the CLI bypasses the boundary — AC7's mutation must redden.
- The extraction changing any value-flag result (AC6): the narrow-blast-radius claim would be false.
- A boolean consumer under an unregistered name (AC8): the enumeration is wrong and must expand
  before building.
- Evidence that a real caller depends on boolean-before-positional: D3 refuses that syntax
  deliberately, and only concrete usage would justify revisiting it — and even then, never by
  treating `false` as an ignorable positional.
