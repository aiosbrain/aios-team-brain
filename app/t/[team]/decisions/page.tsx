import type { Metadata } from "next";
import { Gavel } from "lucide-react";
import { serverClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import { DecisionsTable, type Decision } from "@/components/decisions-table";
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

  const [{ data: decisions }, { data: me }] = await Promise.all([
    supabase
      .from("decisions")
      .select(
        "id, row_key, decided_at, title, rationale, decided_by, impact, tier, audience, still_valid, projects(slug)"
      )
      .eq("team_id", team.id)
      .order("decided_at", { ascending: false }),
    supabase
      .from("members")
      .select("role")
      .eq("team_id", team.id)
      .eq("auth_user_id", user?.id ?? "")
      .eq("status", "active")
      .maybeSingle(),
  ]);

  const rows = (decisions ?? []) as unknown as Decision[];
  const canToggle = me?.role === "admin" || me?.role === "lead";

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <h1 className="text-2xl font-semibold text-ink">Decisions</h1>
      {rows.length === 0 ? (
        <EmptyState
          icon={Gavel}
          title="No decisions recorded"
          action="Decisions materialize from the synced decision-log.md — push your project's status spine with aios push and they show up here, filterable and auditable."
        />
      ) : (
        <DecisionsTable initialDecisions={rows} canToggle={canToggle} />
      )}
    </div>
  );
}
