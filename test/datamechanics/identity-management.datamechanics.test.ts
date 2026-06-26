import { describe, expect, it } from "vitest";
import { setMemberIdentity, removeMemberIdentity } from "@/lib/identity/member-identities";
import { addAuthorAlias, removeAuthorAlias } from "@/lib/admin/aliases";
import { listMemberIdentities } from "@/lib/identity/list";
import { db, seedTeam } from "./helpers";

// Spec: the Admin → Members "Identities" panel reads every link for a person and lets admins
// correct them. Verified on real Postgres: the reader assembles emails + provider ids, and the
// delete writers remove a link / alias.

describe("identity management (real Postgres)", () => {
  it("lists a member's email aliases + provider identities, and removes them", async () => {
    const seed = await seedTeam();

    await addAuthorAlias(db(), seed.teamId, seed.memberId, "alex@personal.com");
    await setMemberIdentity(db(), seed.teamId, seed.memberId, { provider: "slack", externalId: "U1", handle: "alex" });
    await setMemberIdentity(db(), seed.teamId, seed.memberId, { provider: "linear", externalId: "LU1", handle: "Alex" });

    let map = await listMemberIdentities(db(), seed.teamId);
    const rec = map.get(seed.memberId)!;
    expect(rec.emails).toContain("alex@personal.com");
    expect(rec.providers.map((p) => p.provider).sort()).toEqual(["linear", "slack"]);
    expect(rec.providers.find((p) => p.provider === "slack")?.handle).toBe("alex");

    // Unlink the slack identity → gone from the view; linear remains.
    const r = await removeMemberIdentity(db(), seed.teamId, { provider: "slack", externalId: "U1" });
    expect(r.removed).toBe(true);
    map = await listMemberIdentities(db(), seed.teamId);
    expect(map.get(seed.memberId)!.providers.map((p) => p.provider)).toEqual(["linear"]);

    // Remove the email alias → gone from the view.
    const ra = await removeAuthorAlias(db(), seed.teamId, "alex@personal.com");
    expect(ra.removed).toBe(true);
    map = await listMemberIdentities(db(), seed.teamId);
    expect(map.get(seed.memberId)!.emails).not.toContain("alex@personal.com");
  });

  it("removing an absent identity / alias is a no-op", async () => {
    const seed = await seedTeam();
    expect((await removeMemberIdentity(db(), seed.teamId, { provider: "plane", externalId: "nope" })).removed).toBe(false);
    expect((await removeAuthorAlias(db(), seed.teamId, "ghost@x.io")).removed).toBe(false);
  });
});
