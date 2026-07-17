import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { InviteMember } from "@/components/admin/invite-member";
import { MemberIdentities, type ProviderLink } from "@/components/admin/member-identities";
import { MemberRoleSelect } from "@/components/admin/member-role-select";
import { ReattributeButton } from "@/components/admin/reattribute-button";
import { ResetPasswordButton } from "@/components/admin/reset-password-button";
import { RemoveMemberButton } from "@/components/admin/remove-member-button";
import { ManagerSelect } from "@/components/admin/manager-select";
import { MemberProvisioningCell } from "@/components/admin/member-provisioning-cell";
import { listMemberIdentities } from "@/lib/identity/list";
import { getProvisioningAvailabilityAction } from "@/app/t/[team]/admin/actions";
import { getMemberProvisioning } from "@/lib/provisioning/run";

export default async function MembersAdminPage({
  params,
}: {
  params: Promise<{ team: string }>;
}) {
  const { team: teamSlug } = await params;
  const db = await serverClient();

  const { data: team } = await db
    .from("teams")
    .select("id")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null;

  const adminDb = adminClient();

  // The member roster and the per-tool provisioning availability (invite checkboxes) are
  // independent, so load them concurrently rather than one-after-the-other.
  const [membersRes, provisioningAvailability] = await Promise.all([
    db
      .from("members")
      .select(
        "id, display_name, email, actor_handle, role, tier, status, github_login, avatar_url, created_at, manager_member_id"
      )
      .eq("team_id", team.id)
      .eq("is_connector", false)
      .order("created_at"),
    getProvisioningAvailabilityAction(teamSlug),
  ]);
  const members = membersRes.data;

  // Candidate managers for the "Reports to" selector: any other non-disabled, non-connector
  // member (setMemberManager rejects disabled/connector targets server-side too).
  const managerCandidates = (members ?? [])
    .filter((m) => m.status !== "disabled")
    .map((m) => ({ id: m.id as string, displayName: m.display_name as string }));

  // Each member's provisioning rows (compact retry badges) and the linked-identities panel are
  // independent once the roster is known — fan out the per-member reads and the identities read
  // together. Reads go through the admin service client + single-writer read helpers; the members
  // subtree is already admin-gated by the layout.
  const [provisioningEntries, identities] = await Promise.all([
    Promise.all(
      (members ?? []).map(
        async (m) => [m.id, await getMemberProvisioning(adminDb, team.id, m.id as string)] as const
      )
    ),
    listMemberIdentities(db, team.id),
  ]);
  const provisioningByMember = new Map(provisioningEntries);
  const providerOf = (memberId: string, provider: string): ProviderLink | null => {
    const p = identities.get(memberId)?.providers.find((x) => x.provider === provider);
    return p ? { externalId: p.externalId, handle: p.handle } : null;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-secondary">
          {(members ?? []).length} member(s). The <strong>Identities</strong> column shows every
          platform we&apos;ve linked this person to — expand it to add an alternate email or correct a
          link.
        </p>
        <div className="flex items-center gap-2">
          <ReattributeButton teamSlug={teamSlug} />
          <InviteMember teamSlug={teamSlug} provisioningAvailability={provisioningAvailability} />
        </div>
      </div>
      <div className="prism-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-left text-xs uppercase tracking-wide text-ink-tertiary">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Handle</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Tier</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Reports to</th>
              <th className="px-4 py-3">Password</th>
              <th className="px-4 py-3">Tools</th>
              <th className="px-4 py-3">Identities</th>
              <th className="px-4 py-3">Remove</th>
            </tr>
          </thead>
          <tbody>
            {(members ?? []).map((m) => (
              <tr key={m.id} className="border-b border-border-subtle last:border-0 align-top">
                <td className="px-4 py-3 font-medium text-ink">{m.display_name}</td>
                <td className="px-4 py-3 text-ink-secondary">{m.email}</td>
                <td className="px-4 py-3 font-mono text-xs text-ink-secondary">{m.actor_handle}</td>
                <td className="px-4 py-3">
                  <MemberRoleSelect teamSlug={teamSlug} memberId={m.id} role={m.role as "admin" | "lead" | "member"} />
                </td>
                <td className="px-4 py-3 text-ink-secondary">{m.tier}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs ${m.status === "active" ? "text-emerald-600" : m.status === "invited" ? "text-amber-600" : "text-ink-tertiary"}`}>
                    {m.status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <ManagerSelect
                    teamSlug={teamSlug}
                    memberId={m.id}
                    managerMemberId={m.manager_member_id as string | null}
                    candidates={managerCandidates.filter((c) => c.id !== m.id)}
                  />
                </td>
                <td className="px-4 py-3">
                  <ResetPasswordButton teamSlug={teamSlug} memberId={m.id} />
                </td>
                <td className="px-4 py-3">
                  <MemberProvisioningCell
                    teamSlug={teamSlug}
                    memberId={m.id}
                    rows={provisioningByMember.get(m.id) ?? []}
                  />
                </td>
                <td className="px-4 py-3">
                  <MemberIdentities
                    teamSlug={teamSlug}
                    memberId={m.id}
                    rosterEmail={m.email}
                    github={m.github_login ? { login: m.github_login, avatarUrl: m.avatar_url ?? null } : null}
                    emails={identities.get(m.id)?.emails ?? []}
                    slack={providerOf(m.id, "slack")}
                    linear={providerOf(m.id, "linear")}
                    plane={providerOf(m.id, "plane")}
                  />
                </td>
                <td className="px-4 py-3">
                  <RemoveMemberButton teamSlug={teamSlug} memberId={m.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
