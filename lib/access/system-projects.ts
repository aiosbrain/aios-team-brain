/**
 * AUDITFIX-3 — the ONE definition of "which project_groups edges the access substrate owns".
 *
 * Pure and dependency-free on purpose. It cannot live in `lib/access/groups.ts` (the writer
 * that enforces it) or `lib/access/bootstrap.ts` (which creates the sanctioned edges), because
 * bootstrap already imports the writer, so a constant in either would make a cycle out of the
 * other's import. Both re-export what they used to own, so no call site moves.
 *
 * WHY A GUARD EXISTS AT ALL: `grantProjectToGroup` read no `projects.kind` and no group class, so
 * `admin.ts grant-project <anygroup> general` legally granted an entire system corpus to an
 * arbitrary group — while `revokeProjectFromGroup` refuses EVERY system revocation by deliberate
 * design ("raw SQL is the deliberate barrier"). A one-way door. This slice closes it; the key is
 * AUDITFIX-21 and the census that finds an existing bad edge is AUDITFIX-22.
 *
 * WHAT THIS PREDICATE IS A FUNCTION OF, AND WHAT IT MUST NEVER BE: the PAIR — the project's
 * kind+slug and the group's slug+is_builtin. Nothing else. Four spec rounds each found an
 * implementation keyed on some other axis that passed the whole acceptance suite while the CLI
 * exploit stayed open: the ACTOR (round 3), the `opts` shape (round 4), and GROUP CLASS — exempt
 * person singletons and `grant-project person-<id> general` walks straight through (round 4). So
 * the signature takes no actor, no opts, and no `person_member_id`: the bypasses are not
 * expressible here rather than merely untaken.
 */

/** The two system-project slugs the §11 bootstrap owns. */
export const GENERAL_SLUG = "general";
export const EXTERNAL_SHARED_SLUG = "external-shared";
/** The two built-in group slugs. Single-sourced here so the sanctioned table below cannot drift
 *  from the groups writer's own constants — `lib/access/groups.ts` re-exports these. */
export const EVERYONE_SLUG = "everyone";
export const EXTERNAL_SLUG = "external";

export const RESERVED_PROJECT_SLUGS: readonly string[] = [GENERAL_SLUG, EXTERNAL_SHARED_SLUG];

/** The project columns the rule is a function of. */
export interface ProjectIdentity {
  kind: string;
  slug: string;
}

/** The group columns edge identity is a function of. Slug ALONE is not identity: an ordinary group
 *  squatting the `external` slug would otherwise become an approved target (an earlier round's
 *  hijack). `null` = the group could not be resolved, which is never "absent" — see the callers. */
export interface EdgeGroupIdentity {
  slug: string;
  is_builtin: boolean;
}

/** Exactly the three edges `ensureAccessBootstrap` itself creates. Bootstrap calls the same writer,
 *  so a guard admitting anything less breaks every team's access (spec AC1). */
const SANCTIONED: ReadonlyArray<{ project: string; group: string }> = [
  { project: GENERAL_SLUG, group: EVERYONE_SLUG },
  { project: EXTERNAL_SHARED_SLUG, group: EVERYONE_SLUG },
  { project: EXTERNAL_SHARED_SLUG, group: EXTERNAL_SLUG },
];

export function isReservedProjectSlug(slug: string): boolean {
  return RESERVED_PROJECT_SLUGS.includes(slug);
}

/**
 * Whose edges the substrate owns: a `system` project, and a `source` project already holding a
 * reserved slug.
 *
 * THE `source` CLAUSE IS WHAT CLOSES THE ADOPTION RACE, and its narrowness is load-bearing twice
 * over. `ensureSystemProject` adopts a reserved-slug `source` row by flipping it to `system`
 * (lib/access/bootstrap.ts), and it never reads `project_groups` — so a grant made while the row
 * was still `source` SURVIVES the flip. Refusing pre-adoption closes the census→CAS interval from
 * both sides: before the flip this clause refuses, after it the `system` clause does, and there is
 * no instant between where the grant is legal.
 *
 * But it must NOT say "regardless of kind". `slugify("General")` is `"general"`, and a human naming
 * a project that in the dashboard mints a kind='initiative' row which MUST then be granted to its
 * creator or the project is invisible to the person who just made it — and the admin repair its own
 * error message suggests calls this same writer. An initiative is never adoptable
 * (`ensureSystemProject` refuses any kind but `source`), so scoping by kind costs the race nothing
 * and saves that flow. This is also the ONLY exemption: it is by KIND, never by group class.
 */
export function isProtectedProject(p: ProjectIdentity): boolean {
  return p.kind === "system" || (p.kind === "source" && isReservedProjectSlug(p.slug));
}

/**
 * Is this the substrate's own edge? An unresolvable group (`null`) is UNSANCTIONED, never absent —
 * the fail-closed direction. Today the composite FK makes a null group unreachable through the
 * joined census, and this branch is what a future left-join or two-read form would need; the
 * oracle carries the same branch for the same reason (lib/access/oracle.ts).
 */
export function isSanctionedSystemEdge(projectSlug: string, group: EdgeGroupIdentity | null): boolean {
  if (!group || !group.is_builtin) return false;
  return SANCTIONED.some((e) => e.project === projectSlug && e.group === group.slug);
}

/** One edge the writer would refuse, as the census reports it. Slugs are what a repair needs — both
 *  tables are unique on `(team_id, slug)` — and the ids are carried so a repair need not re-resolve. */
export interface UnsanctionedEdge {
  projectId: string;
  projectSlug: string;
  groupId: string;
  groupSlug: string;
}

/** How many characters of the human summary the sample may occupy (AUDITFIX-23 §2b.1). The ledger
 *  clamps each stored error at 500 and the compound reserves the rest for the bootstrap half. */
export const CENSUS_SAMPLE_BUDGET = 200;

/**
 * AUDITFIX-23 §2b.1 — the human-readable summary of a census result.
 *
 * WHY THIS IS A COUNT PLUS A SAMPLE, not the list. The spec's first draft promised "every forbidden
 * edge is reported" in a field the ledger clamps to 500 characters, against `groups.slug` which is
 * unconstrained `text`. An unbounded set cannot be named in a bounded string, so the promise was
 * unkeepable — and worse, every criterion planting ONE edge let a `find`-style implementation satisfy
 * the whole suite while a second edge went unreported forever (spec round 2).
 *
 * So: the COUNT is exact and unbounded-safe, the SAMPLE is deterministic — sorted by
 * `(projectSlug, groupSlug)` so it is stable across runs and diffable between them — and the COMPLETE
 * structured set travels in the ledger row's `meta`, which is jsonb and unclamped.
 */
export function describeUnsanctionedEdges(edges: readonly UnsanctionedEdge[]): string {
  if (edges.length === 0) return "";
  // CODE-POINT order, not localeCompare: the sample has to be byte-stable across runs and machines
  // so two runs are diffable, and `localeCompare` is locale-sensitive. The sort is CLIENT-SIDE
  // because the adapter orders only when explicitly asked, so the row order off the wire is
  // unspecified — a criterion feeding permuted rows is what pins this (spec round 3 HIGH 4).
  const ordered = [...edges].sort((a, b) =>
    a.projectSlug < b.projectSlug ? -1
      : a.projectSlug > b.projectSlug ? 1
      : a.groupSlug < b.groupSlug ? -1
      : a.groupSlug > b.groupSlug ? 1
      : 0
  );
  const head = `${ordered.length} unsanctioned edge(s) on system projects: `;
  const named: string[] = [];
  let used = 0;
  for (const e of ordered) {
    const pair = `${e.projectSlug}→${e.groupSlug}`;
    // Reserve room for the "+N more" suffix so the sample can never crowd the count out.
    const suffix = ordered.length - named.length - 1 > 0 ? ` +${ordered.length - named.length - 1} more` : "";
    if (used + pair.length + 2 + suffix.length > CENSUS_SAMPLE_BUDGET - head.length) break;
    named.push(pair);
    used += pair.length + 2;
  }
  const rest = ordered.length - named.length;
  return head + named.join(", ") + (rest > 0 ? ` +${rest} more` : "");
}
