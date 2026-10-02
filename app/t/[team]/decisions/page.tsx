import type { Metadata } from "next";
import { Gavel } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { getSessionUser } from "@/lib/auth/session";
import { visibleDecisions } from "@/lib/auth/visibility";
import { rowVisibleByProvenanceCtx } from "@/lib/access/provenance";
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

  const { data: me } = await db
    .from("members")
    .select("id, role")
    .eq("team_id", team.id)
    .eq("auth_user_id", user?.id ?? "")
    .eq("status", "active")
    .maybeSingle();

  // ENFB-1 §2.7: the settled provenance rule gates decision PROSE (rationale/impact) — a
  // sourced decision needs its source item in the viewer's oracle set; a null-source one
  // survives only when hand-typed (created_by, the dashboard action's sole write) and admitted.
  // TIERRET-1: WHO is reading comes from the one admission resolver — an admitted member reads by
  // membership (no audience label ceiling; hand-entered rows by Everyone-or-grants); a non-principal
  // keeps its posture ceiling. Resolved once; no member → empty page (fail closed).
  const { visibleProjectRows, readableProjectRows } = await import("@/lib/access/enforce");
  const { resolveContentView, contentLabelTier, provenanceCtxFor } = await import("@/lib/access/admission");
  const { adminClient } = await import("@/lib/db/admin");
  const vis = me ? await resolveContentView(adminClient(), team.id, (me as { id: string }).id) : null;
  const tier = vis ? contentLabelTier(vis.admission) : "external";
  const provCtx = vis ? provenanceCtxFor(vis) : null;
  // ENFB-2 §2.1: the create-form DROPDOWN derives from the WRITER row set (where this member may
  // file — unchanged by TIERRET-1); the per-row container SLUG derives from the READER row set
  // (what this member may see named). Neither is vis.projectIds (the granted set alone).
  const projRows = me ? await visibleProjectRows(adminClient(), { teamId: team.id, memberId: (me as { id: string }).id }) : null;
  const readRows = me ? await readableProjectRows(adminClient(), { teamId: team.id, memberId: (me as { id: string }).id }) : null;

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
    .filter((d) => provCtx !== null && rowVisibleByProvenanceCtx(d, provCtx))
    // Round-2 H5's class, decisions edition: an entitled row (cross-project curation) must not
    // name a container whose ROW the viewer cannot see — the slug renders only for READABLE
    // containers, absent otherwise (indistinguishable from a container-less decision).
    // Redaction nulls BOTH the embed and the id (Fable diff M3): rows feed a "use client"
    // table, so a surviving project_id would serialize the hidden container's uuid into the
    // RSC payload — byte-distinguishable from a container-less row, and a probe input.
    .map((d) => (d.project_id && readRows && !readRows.error && readRows.ids.has(d.project_id) ? d : { ...d, projects: null, project_id: null }));
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
