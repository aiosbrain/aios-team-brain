import "server-only";

/**
 * PROJECT ROWS for the shared ingest lock order (AIO-1167; accepted with PR 714).
 *
 * Every ingest is project-before-item, and its project work belongs to the same transaction as
 * the item, version, evidence and context writes it publishes — a project that an ingest created,
 * a `last_synced_at` it advanced or a graph pointer it set must roll back with a refused or failed
 * ingest, never survive it. So an ingest:
 *
 *   1. PLANS with unlocked reads — the source project by `(team, slug)` and every other project it
 *      can place into or reference. A plan authorizes nothing;
 *   2. creates an absent source project inside its transaction, before any other project or item
 *      lock, and resolves a concurrent creator of the same slug by reading the winner — never by a
 *      late conflict-update;
 *   3. locks the COMPLETE set once, in ascending id order, each row in the strongest mode the
 *      transaction will need (`lockProjectRows`). Nothing is acquired or strengthened afterwards;
 *   4. re-reads what the plan assumed under those locks (the caller compares the returned slug).
 *
 * The statements run on the executor the caller passes: the ingest's own context session for an
 * ordinary ingest, so a savepoint rollback releases them; the ambient commit transaction for a
 * Drive commit and for source reconciliation.
 */

/** One statement on the transaction that owns the locks. */
export type ProjectSqlExecutor = <T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<{ rows: T[] }>;

/** Row-lock modes an ingest takes on a project, weakest first. */
const PROJECT_LOCK_MODES = ["key share", "share", "no key update"] as const;
export type ProjectLockMode = (typeof PROJECT_LOCK_MODES)[number];

/** The projects one transaction needs, each named with what it will do to it. */
export interface ProjectLockPlan {
  /** Rows it UPDATES: the source project (`for no key update`). */
  write: readonly string[];
  /** Protected audience rows whose grants it validates and places into (`for share`). */
  share: readonly string[];
  /** Rows it only references by key: a system destination, a canonical item's project (`for key share`). */
  reference: readonly string[];
}

/** The plan no longer describes the database under its locks: abandon the attempt, never patch it. */
export class ProjectPlanChangedError extends Error {
  readonly code = "ingest-project-plan-changed";
  constructor(detail: string) {
    super(`ingest project plan changed under its locks (${detail}); the attempt was abandoned`);
    this.name = "ProjectPlanChangedError";
  }
}

const SOURCE_PROJECT_READ = "select id from projects where team_id = $1 and slug = $2";

/**
 * The source project a push names. An unlocked read; when the project does not exist it is created
 * HERE — in the caller's transaction, before any other project or item acquisition — so a
 * rollback removes it. `on conflict do nothing` abandons the creation when a concurrent creator of
 * the same slug wins (the statement waits for that transaction first), and the winner is then
 * read: it is resolved before any downstream lock, and its row is taken like any existing project.
 */
export async function resolveSourceProject(
  exec: ProjectSqlExecutor,
  teamId: string,
  slug: string,
  now: string,
): Promise<{ id: string; created: boolean }> {
  const existing = (await exec<{ id: string }>(SOURCE_PROJECT_READ, [teamId, slug])).rows[0];
  if (existing) return { id: existing.id, created: false };
  const created = (await exec<{ id: string }>(
    `insert into projects (team_id, slug, last_synced_at) values ($1, $2, $3)
     on conflict (team_id, slug) do nothing returning id`,
    [teamId, slug, now],
  )).rows[0];
  if (created) return { id: created.id, created: true };
  const winner = (await exec<{ id: string }>(SOURCE_PROJECT_READ, [teamId, slug])).rows[0];
  if (!winner) throw new ProjectPlanChangedError("the source project was created and removed concurrently");
  return { id: winner.id, created: false };
}

/** The system projects an ordinary ingest's context move can place into. Unlocked; plans only. */
export async function systemDestinationProjectIds(exec: ProjectSqlExecutor, teamId: string): Promise<string[]> {
  const { rows } = await exec<{ id: string }>(
    "select id from projects where team_id = $1 and kind = 'system'",
    [teamId],
  );
  return rows.map((row) => row.id);
}

/**
 * Lock the complete project set in ONE ascending-id pass. Ids are deduplicated; a row with several
 * roles is locked once, in its strongest mode — taking it weaker and strengthening it afterwards
 * is the upgrade two concurrent transactions deadlock on, and taking the roles in separate passes
 * orders them by role rather than by id.
 *
 * Returns the rows actually held, by lower-case id, with the slug read under the lock. A planned
 * row that is gone is simply absent: the caller decides whether that abandons its attempt.
 */
export async function lockProjectRows(
  exec: ProjectSqlExecutor,
  teamId: string,
  plan: ProjectLockPlan,
): Promise<Map<string, string>> {
  const modes = new Map<string, ProjectLockMode>();
  const need = (ids: readonly string[], mode: ProjectLockMode) => {
    for (const raw of ids) {
      const id = raw.toLowerCase();
      const held = modes.get(id);
      if (!held || PROJECT_LOCK_MODES.indexOf(mode) > PROJECT_LOCK_MODES.indexOf(held)) modes.set(id, mode);
    }
  };
  need(plan.reference, "key share");
  need(plan.share, "share");
  need(plan.write, "no key update");

  const ordered = [...modes.keys()].sort();
  const locked = new Map<string, string>();
  // Consecutive ids that want the same mode share one statement; `order by` precedes the row lock
  // in the plan, so each run — and therefore the whole pass — is locked in ascending id order.
  for (let start = 0; start < ordered.length;) {
    const mode = modes.get(ordered[start])!;
    let end = start + 1;
    while (end < ordered.length && modes.get(ordered[end]) === mode) end++;
    const { rows } = await exec<{ id: string; slug: string }>(
      `select id, slug from projects where team_id = $1 and id = any($2::uuid[]) order by id for ${mode}`,
      [teamId, ordered.slice(start, end)],
    );
    for (const project of rows) locked.set(project.id.toLowerCase(), project.slug);
    start = end;
  }
  return locked;
}
