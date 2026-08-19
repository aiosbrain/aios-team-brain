import type { Metadata } from "next";
import { Gavel } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { getSessionUser } from "@/lib/auth/session";
import { visibleDecisions } from "@/lib/auth/visibility";
import { rowVisibleByProvenance } from "@/lib/access/provenance";
import { DecisionsTable, type Decision } from "@/components/decisions-table";
import { NewDecisionButton } from "@/components/decisions/new-decision-button";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Decisions" };

export default async function DecisionsPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const db = await serverClient();

  const { data: team } = await db
    .from("teams")
    .select("id")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null;

  const user = await getSessionUser();

  // The viewer's POSTURE gates the decision read (audience filter) — resolved before the
  // query so an external-posture principal never receives team-audience rows (no RLS backstop;
  // PRET-4 §1a: membership-derived, the members.tier record is not consulted).
  const { data: me } = await db
    .from("members")
    .select("id, role")
    .eq("team_id", team.id)
    .eq("auth_user_id", user?.id ?? "")
    .eq("status", "active")
    .maybeSingle();
  const { resolveViewerPosture } = await import("@/lib/access/posture");
  const tier = me ? await resolveViewerPosture(db, team.id, (me as { id: string }).id) : "external";

  // ENFB-1 §2.7: the settled provenance rule gates decision PROSE (rationale/impact) — a
  // sourced decision needs its source item in the viewer's oracle set; a null-source one
  // survives only when hand-typed (created_by, the dashboard action's sole write) at team
  // posture. Resolved once; no member → empty page (fail closed).
  const { visibleItemIds, visibleProjectRows } = await import("@/lib/access/enforce");
  const { adminClient } = await import("@/lib/db/admin");
  const vis = me ? await visibleItemIds(adminClient(), { teamId: team.id, memberId: (me as { id: string }).id }) : null;
  // ENFB-2 §2.1: the create-form dropdown and the per-row container slug both derive from the
  // ROW-VISIBLE set (not vis.projectIds — that is the granted set alone).
  const projRows = me ? await visibleProjectRows(adminClient(), { teamId: team.id, memberId: (me as { id: string }).id }) : null;

  const [{ data: decisions }, { data: projects }] = await Promise.all([
    visibleDecisions(
      db
        .from("decisions")
        .select(
          "id, row_key, decided_at, title, rationale, decided_by, impact, tier, audience, still_valid, source_item_id, created_by, project_id, projects(slug)"
        )
        .eq("team_id", team.id)
        .order("decided_at", { ascending: false }),
      tier
    ),
    db
      .from("projects")
      .select("id, slug, name")
      .eq("team_id", team.id)
      .in("id", projRows && !projRows.error ? [...projRows.ids] : [])
      .order("slug"),
  ]);

  const rows = ((decisions ?? []) as unknown as (Decision & { source_item_id?: string | null; created_by?: string | null; project_id?: string | null })[])
    .filter((d) => rowVisibleByProvenance(d, vis && !vis.error ? vis.ids : null, tier))
    // Round-2 H5's class, decisions edition: an entitled row (cross-project curation) must not
    // name a container whose ROW the viewer cannot see — the slug renders only for row-visible
    // containers, absent otherwise (indistinguishable from a container-less decision).
    // Redaction nulls BOTH the embed and the id (Fable diff M3): rows feed a "use client"
    // table, so a surviving project_id would serialize the hidden container's uuid into the
    // RSC payload — byte-distinguishable from a container-less row, and a probe input.
    .map((d) => (d.project_id && projRows && !projRows.error && projRows.ids.has(d.project_id) ? d : { ...d, projects: null, project_id: null }));
  const canToggle = me?.role === "admin" || me?.role === "lead";
  const projectOptions = (projects ?? []) as { id: string; slug: string; name: string }[];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink">Decisions</h1>
        {canToggle ? <NewDecisionButton teamId={team.id} projects={projectOptions} /> : null}
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={Gavel}
          title="No decisions recorded"
          action="Record one with the button above (admins/leads), or push your project's decision-log.md with aios push — both show up here, filterable and auditable."
        />
      ) : (
        <DecisionsTable initialDecisions={rows} canToggle={canToggle} />
      )}
    </div>
  );
}
