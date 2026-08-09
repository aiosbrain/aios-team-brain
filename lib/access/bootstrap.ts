import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import {
  EVERYONE_SLUG,
  EXTERNAL_SLUG,
  ensureBuiltins,
  grantProjectToGroup,
  type WriteResult,
} from "@/lib/access/groups";

/**
 * §11 access bootstrap — the app-code "migration" that gives every team its built-in access
 * topology. It CANNOT be a SQL migration: the single-writer guard forbids SQL DML against the
 * edge tables by design, so the only legal seeder is this module calling the groups writer.
 * Runs idempotently from three triggers: team creation (lib/admin/teams), every scheduler tick
 * (the convergence backstop that also bootstraps all PRE-EXISTING teams on first deploy), and
 * tests. Result per §11: day-one visibility byte-identical to the two-tier world —
 *
 *   general (kind system)         ↔ everyone
 *   external-shared (kind system) ↔ external AND everyone   (external content is team-visible
 *                                                            today; not vice versa)
 */

export const GENERAL_SLUG = "general";
export const EXTERNAL_SHARED_SLUG = "external-shared";

type ProjectRow = { id: string; kind: string };

/**
 * Get-or-create a system project. An EXISTING row under the slug (an ingestion-created
 * 'general' is common in practice; the payload schema requires `project`, so any default
 * lives in the pushing CLI, not this repo) is ADOPTED: kind flips to
 * 'system', loudly audited. This is the §11 fail-open-to-today ruling, deliberately the
 * opposite of the groups reserved-slug refusal: adopting a source project named `general`
 * changes no one's visibility (its items are team content, already team-visible, and the
 * general↔everyone grant preserves exactly that), whereas converting a curated GROUP would
 * rewrite an ACL. Content placement ≠ principal sets.
 */
async function ensureSystemProject(
  db: DbClient,
  teamId: string,
  slug: string
): Promise<{ ok: boolean; error?: string; projectId?: string }> {
  const { data: existing } = await db
    .from("projects")
    .select("id, kind")
    .eq("team_id", teamId)
    .eq("slug", slug)
    .maybeSingle();
  const row = existing as ProjectRow | null;
  if (row) {
    if (row.kind !== "system") {
      // Adopt ONLY ingestion containers. A source project has no restriction semantics (its
      // items' visibility lives on items.access, already team-visible), so adoption is
      // visibility-neutral — that is which way §11's fail-open ruling cuts. An INITIATIVE is
      // grant-scoped under Part II: adopting one and granting everyone-visibility would be
      // exactly the ACL rewrite the groups reserved-slug refusal exists to prevent (slice-3
      // Fable Medium — written now, while the ruling's author is in the file).
      if (row.kind !== "source") {
        return { ok: false, error: `a kind='${row.kind}' project holds reserved slug '${slug}' — refusing to adopt it` };
      }
      const { error } = await db.from("projects").update({ kind: "system" }).eq("id", row.id).eq("team_id", teamId);
      if (error) return { ok: false, error: error.message };
      await audit(db, {
        team_id: teamId,
        actor_kind: "system",
        action: "access.project_adopted",
        target_type: "project",
        target_id: row.id,
        meta: { slug, from_kind: row.kind },
      });
    }
    return { ok: true, projectId: row.id };
  }
  const { data, error } = await db
    .from("projects")
    .insert({ team_id: teamId, slug, name: slug === GENERAL_SLUG ? "General" : "External shared", kind: "system" })
    .select("id")
    .single();
  if (error || !data) {
    // Race loser on unique (team_id, slug): converge on the winner.
    const { data: winner } = await db
      .from("projects")
      .select("id, kind")
      .eq("team_id", teamId)
      .eq("slug", slug)
      .maybeSingle();
    if (winner) return ensureSystemProject(db, teamId, slug);
    return { ok: false, error: error?.message ?? "insert failed" };
  }
  return { ok: true, projectId: data.id as string };
}

/** The full §11 bootstrap for one team. Idempotent; every step converges. */
export async function ensureAccessBootstrap(db: DbClient, teamId: string): Promise<WriteResult> {
  const builtins = await ensureBuiltins(db, teamId);
  if (!builtins.ok) return builtins;

  const general = await ensureSystemProject(db, teamId, GENERAL_SLUG);
  if (!general.ok) return { ok: false, error: `general: ${general.error}` };
  const externalShared = await ensureSystemProject(db, teamId, EXTERNAL_SHARED_SLUG);
  if (!externalShared.ok) return { ok: false, error: `external-shared: ${externalShared.error}` };

  const { data: groups, error: gErr } = await db
    .from("groups")
    .select("id, slug")
    .eq("team_id", teamId)
    .eq("is_builtin", true)
    .in("slug", [EVERYONE_SLUG, EXTERNAL_SLUG]);
  if (gErr) return { ok: false, error: gErr.message };
  const bySlug = new Map(((groups ?? []) as { id: string; slug: string }[]).map((g) => [g.slug, g.id]));
  const everyone = bySlug.get(EVERYONE_SLUG);
  const external = bySlug.get(EXTERNAL_SLUG);
  if (!everyone || !external) return { ok: false, error: "builtin groups missing after ensure" };

  // The §11 grant set, exactly three edges. grantProjectToGroup upserts, so re-runs converge.
  for (const [projectId, groupId] of [
    [general.projectId!, everyone],
    [externalShared.projectId!, external],
    [externalShared.projectId!, everyone],
  ] as const) {
    const r = await grantProjectToGroup(db, teamId, projectId, groupId, null);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/**
 * Convergence over every team — the scheduler-tick backstop. Best-effort per team: one team's
 * failure never blocks another's bootstrap; failures surface through the ingest-run trace the
 * scheduler leg records, not by throwing.
 */
export async function ensureAccessBootstrapAllTeams(
  db: DbClient
): Promise<{ teams: number; failed: { teamId: string; error: string }[] }> {
  const { data: teams, error: tErr } = await db.from("teams").select("id");
  // A failed teams read must NOT report a green run — an instance whose read persistently
  // fails would otherwise show a healthy access_bootstrap leg while converging nothing.
  if (tErr) return { teams: 0, failed: [{ teamId: "*", error: `teams read failed: ${tErr.message}` }] };
  const failed: { teamId: string; error: string }[] = [];
  for (const t of (teams ?? []) as { id: string }[]) {
    try {
      const r = await ensureAccessBootstrap(db, t.id);
      if (!r.ok) failed.push({ teamId: t.id, error: r.error ?? "unknown" });
    } catch (e) {
      failed.push({ teamId: t.id, error: e instanceof Error ? e.message : "threw" });
    }
  }
  return { teams: (teams ?? []).length, failed };
}
