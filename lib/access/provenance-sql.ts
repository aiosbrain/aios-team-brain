import "server-only";
import { isRestrictedTier } from "@/lib/auth/visibility";

/**
 * The IN-QUERY form of the settled provenance rule (ENFB-2 §2.2) — the SQL sibling of
 * `lib/access/provenance.rowVisibleByProvenance` (the TS owner, which remains for uncapped /
 * app-side sites). Two owners, one contract: the dm agreement suite asserts BOTH against
 * fixture-level expected truth (not merely against each other — parity alone lets both be
 * wrong together, design round 2 M7), so the pair cannot drift silently.
 *
 * Why in-query: every capped structured window that filtered app-side AFTER its LIMIT let
 * invisible rows starve visible ones out of the window (ENFB-1's deferred Codex M1). The
 * predicate compiles into the WHERE clause, so the window fills with rows the caller may
 * actually see.
 *
 * The membership semijoin takes the member's GRANTED project ids (the oracle's ≤tens-of-rows
 * set) instead of the materialized visible-item id list — retiring the documented >65k
 * IN-list wall at every site this lands on. An EMPTY granted set compiles to
 * `= any('{}')` → no row matches the sourced arm — the same fail-closed direction as the
 * builder's `.in(col, []) → "false"`.
 */

/** Ordered SQL parameter list where `add` returns the placeholder ("$n") for the pushed value. */
export interface SqlParams {
  readonly values: unknown[];
  add(value: unknown): string;
}

export function newSqlParams(initial: readonly unknown[] = []): SqlParams {
  const values = [...initial];
  return {
    values,
    add(value: unknown): string {
      values.push(value);
      return `$${values.length}`;
    },
  };
}

/**
 * WHO is asking — see `unsourcedAdmission` for what each arm admits.
 *
 * ⚠️ THIS USED TO SAY a row with no `source_item_id` "cannot be tested against that scope, so it can
 * never be shown to one". **The premise was false** (AUDITFIX-7): hand-entered rows carry
 * `project_id`, written by the dashboard create actions in the same insert as `created_by`, and both
 * token-reachable leg queries already join `projects`. A token now sees such a row when its EFFECTIVE
 * project set contains that project. Absent/foreign values still close.
 *
 * TIERRET-1 split the old single member value in two, because "a valid `aios_` key" and "a positively
 * admitted member" were never the same fact (`authenticateApiKey` does not select kind/is_connector):
 *   · `"member"` — ONLY from `lib/access/admission.ts`, after the members row passed `isPrincipal`
 *     (active human or standing agent). Membership is its whole read rule: no label ceiling.
 *   · `"legacy"` — a valid key/session whose ACTIVE member is NOT a principal (connector or
 *     offroster). Keeps the pre-TIERRET posture rule byte-for-byte: no gain, no loss. Inactive rows
 *     never reach either arm — the resolver throws.
 */
export type ProvenancePrincipal = "member" | "legacy" | "token" | undefined;

/**
 * The two discriminant tags, DERIVED rather than re-spelled.
 *
 * ⚠️ Written this way for a specific reason: `test/guards/provenance-principal-callsites.test.ts`'s
 * tree-wide layer flags a bare `"member"` literal outside a listed member-only boundary, and it
 * cannot distinguish a TYPE annotation (`principal: "member";`) from a value assignment by text —
 * the two are textually identical. `Extract` gives the discriminated `RetrieveEnforce` union its
 * arms without introducing a literal the guard would have to be weakened to permit.
 */
export type MemberTag = Extract<ProvenancePrincipal, "member">;
export type LegacyTag = Extract<ProvenancePrincipal, "legacy">;
export type TokenTag = Extract<ProvenancePrincipal, "token">;

/**
 * THE POLICY, in one place, expressed POSITIVELY (AUDITFIX-1) — now three-valued (AUDITFIX-7).
 *
 * Positive on purpose: `principal !== "token"` would admit `undefined`, `null` and any foreign value
 * — and those are real runtime states here, because `tsconfig.json` excludes `test/`, so an omitted
 * discriminator never fails typecheck. Everything that is not an explicit admitted member (Everyone →
 * all; otherwise its granted projects), an explicit legacy principal at team posture, or an explicit
 * token with a project set, closes.
 *
 * ⚠️ A UNION IS NOT SELF-ENFORCING. A consumer that branches on `kind !== "closed"` reads `"projects"`
 * as `"all"` and hands a scoped token the whole corpus — the very widening the union was chosen to
 * prevent (spec round 2, HIGH 1). Every consumer therefore switches EXHAUSTIVELY with a `never`
 * check, so a missed branch is a COMPILE error rather than a policy decision nobody made.
 */
export type UnsourcedAdmission =
  | { kind: "closed" }
  | { kind: "all" }
  | { kind: "projects"; projectIds: readonly string[] };

/** Exhaustiveness helper — the compile error a missed union branch must produce. */
export function assertNeverAdmission(x: never): never {
  throw new Error(`unhandled UnsourcedAdmission: ${JSON.stringify(x)}`);
}

export function unsourcedAdmission(ctx: {
  principal?: ProvenancePrincipal;
  /**
   * MEMBER arm: the ORACLE-ACCEPTED Everyone bit (`ContentAdmission.everyone` — an active human whose
   * builtin Everyone row passes `isBuiltinEligible`), produced only by `lib/access/admission.ts`.
   * LEGACY arm: raw viewer posture, exactly as before TIERRET-1. Ignored for tokens.
   */
  teamPosture: boolean;
  /** The token's EFFECTIVE project set (`effectiveVisibleProjects`). Absent closes. */
  tokenProjectIds?: readonly string[];
  /** TIERRET-1: an admitted member's oracle GRANTED project set. Absent or empty closes. */
  memberProjectIds?: readonly string[];
}): UnsourcedAdmission {
  if (ctx.principal === "member") {
    // TIERRET-1 AC-04 (revised): Everyone is the existing audience group of its oracle-accepted
    // humans, so they keep every hand-entered row. Every other admitted member — an external human,
    // a standing agent, even one with a PLANTED builtin row (N3: posture ≠ oracle acceptance) — gets
    // exactly the projects the oracle granted them. A grantless member gets nothing: the rejected
    // "all members" proposal would have disclosed every hand-entered project to them.
    if (ctx.teamPosture === true) return { kind: "all" };
    const ids = ctx.memberProjectIds;
    if (ids === undefined || ids.length === 0) return { kind: "closed" };
    return { kind: "projects", projectIds: ids };
  }
  // LEGACY (active connector / offroster) — the pre-TIERRET member rule verbatim. AC-03 requires
  // that these principals GAIN nothing; it does not revoke what they already had.
  if (ctx.principal === "legacy") return ctx.teamPosture === true ? { kind: "all" } : { kind: "closed" };
  if (ctx.principal === "token") {
    // ⚠️ THE TOKEN ARM DOES NOT CONSULT `teamPosture`, AND THAT IS ONLY SAFE BECAUSE OF ONE LINE
    // ELSEWHERE (Fable diff review, MEDIUM). A token's wall is its project authority, not posture —
    // but if `verifyAgentToken`'s Phase-A refusal of external-tier delegation
    // (`lib/access/agent-tokens.ts:170`, `if (effectiveTier === "external") return null`) is ever
    // lifted, an external-posture token would get `{kind:"projects"}` while its own external LAUNCHER
    // gets `{kind:"closed"}` — the token EXCEEDING its launcher, which `lib/access/enforce.ts:39`
    // states can never happen. The per-leg `audience = 'external'` conjuncts would be the only
    // remaining wall, and those are per-leg, not the central policy.
    // `test/guards/provenance-principal-callsites.test.ts` reddens if that refusal is deleted while
    // this pin stands, so the coupling cannot be broken silently from either end.
    const ids = ctx.tokenProjectIds;
    // An EMPTY set closes EXPLICITLY rather than relying on `= any('{}')` being false: the closed
    // case is a decision, not an emergent property of SQL. Absent closes for the same reason a
    // missing discriminator does — a permissive default obtainable by saying nothing is the defect
    // AUDITFIX-1 exists to have removed.
    if (ids === undefined || ids.length === 0) return { kind: "closed" };
    return { kind: "projects", projectIds: ids };
  }
  return { kind: "closed" };
}

export interface ProvenanceSqlCtx {
  teamId: string;
  /** WHO is asking (AUDITFIX-1). Absent closes the hand-typed arm — never synthesise "member". */
  principal?: ProvenancePrincipal;
  /** The oracle's granted project set (`visibleProjects(...).projectIds`) — NOT the §2.1
   *  row-visible set; the semijoin derives item visibility from grants + curations. */
  grantedProjectIds: readonly string[];
  /** See `unsourcedAdmission`: the oracle-accepted Everyone bit (member) or raw posture (legacy). */
  teamPosture: boolean;
  /** AUDITFIX-7: a TOKEN's effective project set, gating the hand-typed arm. Absent closes it. */
  tokenProjectIds?: readonly string[];
  /** TIERRET-1: an admitted MEMBER's granted project set, gating the hand-typed arm. Absent closes it. */
  memberProjectIds?: readonly string[];
}

/**
 * TIERRET-1 — the LABEL ceiling (items.access / tasks|decisions.audience = 'external' only).
 *
 * A positively admitted MEMBER has none: membership (the oracle) is the member read rule, and a label
 * veto over a valid grant is exactly the inconsistency this slice retires. Every OTHER reader keeps
 * the posture ceiling it had — the explicit legacy arm (no gain), tokens (whose launchers are never
 * external: `verifyAgentToken` refuses external delegation), and any absent/foreign discriminator,
 * which is restricted whenever its tier is not exactly "team" (fail closed via `isRestrictedTier`).
 * Labels still route placement and still narrow an EXPLICIT export (`?tier=external`); that is
 * caller-selected narrowing, not this ceiling.
 */
export function labelCeilingApplies(principal: ProvenancePrincipal, tier: string): boolean {
  if (principal === "member") return false;
  return isRestrictedTier(tier);
}

/**
 * Membership visibility for an ITEM id referenced by `<expr>` (a column expression, e.g.
 * `t.source_item_id` or `i.id`): an ACTIVE item-grain unit for that source with a CURRENT
 * include-membership into a granted project. Mirrors `unitServesItem` +
 * `currentIncludeMemberships` (lib/access/enforce.ts) conjunct for conjunct — each conjunct
 * has an INVERSE dm fixture (exclude / expired / retracted / non-item), per design round 1 F4.
 */
export function itemVisibleSql(expr: string, p: SqlParams, ctx: ProvenanceSqlCtx): string {
  const team = p.add(ctx.teamId);
  const granted = p.add([...ctx.grantedProjectIds]);
  return `exists (
    select 1 from project_context_units u
    join project_context_memberships m
      on m.context_unit_id = u.id
     and m.team_id = ${team}
     and m.decision = 'include'
     and m.valid_to is null
     and m.project_id = any(${granted}::uuid[])
    where u.team_id = ${team}
      and u.state = 'active'
      and u.unit_kind = 'item'
      and u.source_item_id = ${expr}
  )`;
}

/**
 * The full row predicate for a structured row (task/decision) aliased `alias`:
 *   sourced  → the source item is membership-visible;
 *   null-source → hand-typed (`created_by` non-null — the sole-writer provenance proof;
 *                 `origin` is durability, never provenance) AND admitted by `unsourcedAdmission`.
 * Deleted-creator rows (created_by nulled by `on delete set null`) fall to no-provenance and
 * hide — the stated fail-closed over-restriction (work-timeline.ts:173-175, extended to
 * decisions by ENFB-2 design round 2 H6).
 */
export function provenanceRowSql(alias: string, p: SqlParams, ctx: ProvenanceSqlCtx): string {
  const sourced = `(${alias}.source_item_id is not null and ${itemVisibleSql(`${alias}.source_item_id`, p, ctx)})`;
  const authored = `${alias}.source_item_id is null and ${alias}.created_by is not null`;
  const admission = unsourcedAdmission(ctx);
  switch (admission.kind) {
    // The arm is OMITTED, not parameterised false — a closed principal's SQL simply has no disjunct.
    case "closed":
      return `(${sourced})`;
    case "all":
      return `(\n    ${sourced}\n    or (${authored})\n  )`;
    case "projects": {
      // `alias.project_id` always resolves: both columns are NOT NULL in the schema, so a SQL caller
      // never has to select anything extra (spec §3b — the distinction from the TS owner).
      const scope = p.add([...admission.projectIds]);
      return `(\n    ${sourced}\n    or (${authored} and ${alias}.project_id = any(${scope}::uuid[]))\n  )`;
    }
    default:
      return assertNeverAdmission(admission);
  }
}

/** The id-array ctx — shared by both id-array owners (this SQL form and `rowVisibleByProvenanceCtx`). */
export interface ProvenanceIdsCtx {
  visibleItemIds: ReadonlySet<string>;
  teamPosture: boolean;
  principal?: ProvenancePrincipal;
  /** AUDITFIX-7: the token's effective project set. Absent closes the arm for a token. */
  tokenProjectIds?: readonly string[];
  /** TIERRET-1: an admitted member's granted project set. Absent closes the arm for a member. */
  memberProjectIds?: readonly string[];
}

/**
 * The ID-ARRAY form — the exact SQL twin of `rowVisibleByProvenance` for sites that ALREADY hold the
 * principal's materialized visible-item set (retrieve, the timeline, the board, both API lists):
 * sourced → the source id is in the set; null-source → hand-typed, admitted by `unsourcedAdmission`.
 *
 * ⚠️ THIS DOCSTRING USED TO CLAIM the form "serves EVERY principal correctly (a delegated token's set
 * is its attenuated set)". That was false and it was the whole bug: the null-source arm never
 * consulted `visibleItemIds` at all, so an empty-scoped token received every hand-typed task and
 * decision in the team. Reproduced against real Postgres before this was written (AUDITFIX-1).
 *
 * The array binds as ONE parameter. The documented large-corpus deferral (enforce.ts) is unchanged.
 */
export function provenanceRowSqlFromIds(alias: string, p: SqlParams, ctx: ProvenanceIdsCtx): string {
  const ids = p.add([...ctx.visibleItemIds]);
  const sourced = `(${alias}.source_item_id is not null and ${alias}.source_item_id = any(${ids}::uuid[]))`;
  const authored = `${alias}.source_item_id is null and ${alias}.created_by is not null`;
  const admission = unsourcedAdmission(ctx);
  switch (admission.kind) {
    case "closed":
      return `(${sourced})`;
    case "all":
      return `(\n    ${sourced}\n    or (${authored})\n  )`;
    case "projects": {
      const scope = p.add([...admission.projectIds]);
      return `(\n    ${sourced}\n    or (${authored} and ${alias}.project_id = any(${scope}::uuid[]))\n  )`;
    }
    default:
      return assertNeverAdmission(admission);
  }
}
