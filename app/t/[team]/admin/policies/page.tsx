import { serverClient } from "@/lib/db/server";
import { listAllPolicies } from "@/lib/policy/manage";
import { PoliciesManager } from "@/components/admin/policies-manager";

export default async function PoliciesAdminPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const supabase = await serverClient();

  const { data: team } = await supabase.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const policies = await listAllPolicies(supabase, team.id);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-secondary">
        Rules the brain evaluates before an agent acts (<code>POST /api/v1/actions</code> → <code>authorize()</code>).
        <strong> Default-deny</strong>: with no matching <code>allow</code>, an action is denied. Highest{" "}
        <code>priority</code> wins; ties break most-restrictive (deny &gt; require_approval &gt; allow). Subject fields
        left blank match anyone; <code>action</code>/<code>resource</code> are <code>*</code>-globs.
      </p>
      <PoliciesManager teamSlug={teamSlug} policies={policies} />
    </div>
  );
}
