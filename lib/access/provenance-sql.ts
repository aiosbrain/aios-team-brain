import "server-only";

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
 * WHO is asking. The unsourced (hand-typed) arm is admitted for a MEMBER at team posture and for
 * nobody else — see `admitsUnsourced`.
 *
 * A delegated token's authority is its attenuated scope; a row with no `source_item_id` cannot be
 * tested against that scope, so it can never be shown to one. Absent/foreign values close.
 */
export type ProvenancePrincipal = "member" | "token" | undefined;

/**
 * THE POLICY, in one place, expressed POSITIVELY (AUDITFIX-1).
 *
 * Positive on purpose: `principal !== "token"` would admit `undefined`, `null` and any foreign value
 * — and those are real runtime states here, because `tsconfig.json` excludes `test/`, so an omitted
 * discriminator never fails typecheck. Written this way, everything that is not an explicit member at
 * team posture closes.
 */
export function admitsUnsourced(ctx: { principal?: ProvenancePrincipal; teamPosture: boolean }): boolean {
  return ctx.principal === "member" && ctx.teamPosture === true;
}

export interface ProvenanceSqlCtx {
  teamId: string;
  /** WHO is asking (AUDITFIX-1). Absent closes the hand-typed arm — never synthesise "member". */
  principal?: ProvenancePrincipal;
  /** The oracle's granted project set (`visibleProjects(...).projectIds`) — NOT the §2.1
   *  row-visible set; the semijoin derives item visibility from grants + curations. */
  grantedProjectIds: readonly string[];
  /** True when the viewer is team posture — the hand-typed arm's audience wall. */
  teamPosture: boolean;
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
 *                 `origin` is durability, never provenance) AND team posture.
 * Deleted-creator rows (created_by nulled by `on delete set null`) fall to no-provenance and
 * hide — the stated fail-closed over-restriction (work-timeline.ts:173-175, extended to
 * decisions by ENFB-2 design round 2 H6).
 */
export function provenanceRowSql(alias: string, p: SqlParams, ctx: ProvenanceSqlCtx): string {
  const sourced = `(${alias}.source_item_id is not null and ${itemVisibleSql(`${alias}.source_item_id`, p, ctx)})`;
  // The arm is OMITTED, not parameterised false — a token's SQL simply has no hand-typed disjunct.
  if (!admitsUnsourced(ctx)) return `(${sourced})`;
  return `(
    ${sourced}
    or (${alias}.source_item_id is null and ${alias}.created_by is not null)
  )`;
}

/**
 * The ID-ARRAY form — the exact SQL twin of `rowVisibleByProvenance` for sites that ALREADY hold the
 * principal's materialized visible-item set (retrieve, the timeline, the board, both API lists):
 * sourced → the source id is in the set; null-source → hand-typed, and ONLY for a member at team
 * posture (`admitsUnsourced`).
 *
 * ⚠️ THIS DOCSTRING USED TO CLAIM the form "serves EVERY principal correctly (a delegated token's set
 * is its attenuated set)". That was false and it was the whole bug: the null-source arm never
 * consulted `visibleItemIds` at all, so an empty-scoped token received every hand-typed task and
 * decision in the team. Reproduced against real Postgres before this was written (AUDITFIX-1).
 *
 * The array binds as ONE parameter. The documented large-corpus deferral (enforce.ts) is unchanged.
 */
export function provenanceRowSqlFromIds(
  alias: string,
  p: SqlParams,
  ctx: { visibleItemIds: ReadonlySet<string>; teamPosture: boolean; principal?: ProvenancePrincipal }
): string {
  const ids = p.add([...ctx.visibleItemIds]);
  const sourced = `(${alias}.source_item_id is not null and ${alias}.source_item_id = any(${ids}::uuid[]))`;
  if (!admitsUnsourced(ctx)) return `(${sourced})`;
  return `(
    ${sourced}
    or (${alias}.source_item_id is null and ${alias}.created_by is not null)
  )`;
}
