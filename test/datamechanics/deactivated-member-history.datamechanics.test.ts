import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { addAuthorAlias } from "@/lib/admin/aliases";
import { deleteMember } from "@/lib/admin/members";
import { googleDriveContributionEvidence } from "@/lib/dashboard/gdrive-contributions";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { resolveConfirmedEmail } from "@/lib/identity/provider-sync";
import { buildIdentityMap, resolveByProviderId } from "@/lib/identity/resolve";
import { db, seedTeam } from "./helpers";

/**
 * AIO-1167 R44 C4 — deactivation separates two questions.
 *
 *   · New links and authentication: a deactivated member is NOT eligible. The default identity map
 *     (account linking, identity sync) resolves none of their aliases or provider identities, and a
 *     new identity link to them is refused.
 *   · Established history: offboarding is not an unlink. The attribution map
 *     (`includeDeactivated`) still resolves their existing alias and provider identity, so their
 *     Drive contribution evidence keeps rendering as theirs; `activeMemberIds` still excludes them.
 */

async function member(teamId: string, name: string) {
  const email = `${name}-${randomUUID().slice(0, 6)}@example.com`;
  const { data } = await db().from("members").insert({
    team_id: teamId, email, display_name: name, actor_handle: `${name}-${randomUUID().slice(0, 6)}`,
    role: "member", tier: "team", status: "active",
  }).select("id").single();
  return { id: (data as { id: string }).id, email };
}

describe("a deactivated member's history versus new eligibility (R44 C4, real Postgres)", () => {
  it("history resolves; new links and the default map do not", async () => {
    const seed = await seedTeam();
    const carol = await member(seed.teamId, "carol");
    const alias = `carol-personal-${randomUUID().slice(0, 6)}@example.com`;
    await addAuthorAlias(db(), seed.teamId, carol.id, alias);
    await setMemberIdentity(db(), seed.teamId, carol.id, { provider: "gdrive", externalId: "permission:carol-perm" });
    expect(await deleteMember(db(), seed.teamId, carol.email)).toMatchObject({ deleted: true, mode: "soft" });

    const linking = await buildIdentityMap(db(), seed.teamId, { strict: true });
    expect(linking.byEmail.get(alias)).toBeUndefined();
    expect(resolveByProviderId(linking, "gdrive", "permission:carol-perm")).toBeNull();
    expect(resolveConfirmedEmail(linking, alias)).toBeNull();
    await expect(setMemberIdentity(db(), seed.teamId, carol.id, { provider: "gdrive", externalId: "permission:new" }))
      .rejects.toThrow(/deactivated/);

    const history = await buildIdentityMap(db(), seed.teamId, { strict: true, includeDeactivated: true });
    expect(history.byEmail.get(alias)).toBe(carol.id);
    expect(resolveByProviderId(history, "gdrive", "permission:carol-perm")).toBe(carol.id);
    expect(history.activeMemberIds?.has(carol.id)).toBe(false);

    const frontmatter = {
      source: "gdrive", title: "Plan",
      contributions: [
        { external_id: "permission:carol-perm", role: "editor", at: "2026-10-20T10:00:00Z" },
        { email: alias, role: "commenter", at: "2026-10-21T10:00:00Z" },
      ],
    };
    expect(googleDriveContributionEvidence(frontmatter, "item-1", history).map((row) => [row.memberId, row.role]))
      .toEqual([[carol.id, "editor"], [carol.id, "commenter"]]);
    expect(googleDriveContributionEvidence(frontmatter, "item-1", linking)).toEqual([]);
  });
});
