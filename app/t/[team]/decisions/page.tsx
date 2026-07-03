import type { Metadata } from "next";
import { Gavel } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { getSessionUser } from "@/lib/auth/session";
import { visibleDecisions } from "@/lib/auth/visibility";
import { DecisionsTable, type Decision } from "@/components/decisions-table";
import { NewDecisionButton } from "@/components/decisions/new-decision-button";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Decisions" };

export default async function DecisionsPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const supabase = await serverClient();

  const { data: team } = await supabase
    .from("teams")
    .select("id")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null;

  const user = await getSessionUser();

  // The viewer's tier gates the decision read (audience filter) — fetch it before the
  // query so an external principal never receives team-audience rows (no RLS backstop).
  const { data: me } = await supabase
    .from("members")
    .select("role, tier")
    .eq("team_id", team.id)
    .eq("auth_user_id", user?.id ?? "")
    .eq("status", "active")
    .maybeSingle();
  const tier = (me?.tier as "team" | "external" | undefined) ?? "external";

  const [{ data: decisions }, { data: projects }] = await Promise.all([
    visibleDecisions(
      supabase
        .from("decisions")
        .select(
          "id, row_key, decided_at, title, rationale, decided_by, impact, tier, audience, still_valid, projects(slug)"
        )
        .eq("team_id", team.id)
        .order("decided_at", { ascending: false }),
      tier
    ),
    supabase
      .from("projects")
      .select("id, slug, name")
      .eq("team_id", team.id)
      .order("slug"),
  ]);

  const rows = (decisions ?? []) as unknown as Decision[];
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
