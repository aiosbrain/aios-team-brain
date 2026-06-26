import { describe, expect, it } from "vitest";
import { syncProviderIdentities } from "@/lib/identity/provider-sync";
import { buildIdentityMap, resolveByProviderId } from "@/lib/identity/resolve";
import { db, seedTeam } from "./helpers";

// Spec: the shared, provider-parameterized identity sync maps a connector's users → roster members
// by email and records member_identities keyed per (provider, external_id). This is what lets Linear
// AND Plane issues attribute to the same person, joinable with their Slack + git activity.

describe("syncProviderIdentities — generic, per provider (real Postgres)", () => {
  it("maps Linear and Plane users to the same member by email, scoped per provider", async () => {
    const seed = await seedTeam();
    await db().from("member_emails").insert({ team_id: seed.teamId, member_id: seed.memberId, email: "alex@corp.com" });

    const lin = await syncProviderIdentities(db(), seed.teamId, "linear", [
      { id: "LU-1", displayName: "Alex", email: "alex@corp.com" }, // resolves
      { id: "LU-2", displayName: "Ghost", email: "ghost@elsewhere.io" }, // no member → skip
    ]);
    const pla = await syncProviderIdentities(db(), seed.teamId, "plane", [
      { id: "mid-7", displayName: "Alex", email: "alex@corp.com" }, // resolves (same person, different tool)
    ]);
    expect(lin).toMatchObject({ scanned: 2, mapped: 1, skipped: 1 });
    expect(pla).toMatchObject({ scanned: 1, mapped: 1, skipped: 0 });

    const map = await buildIdentityMap(db(), seed.teamId);
    expect(resolveByProviderId(map, "linear", "LU-1")).toBe(seed.memberId);
    expect(resolveByProviderId(map, "plane", "mid-7")).toBe(seed.memberId);
    // provider-scoped: a Linear id never resolves under the Plane provider
    expect(resolveByProviderId(map, "plane", "LU-1")).toBeNull();
    expect(resolveByProviderId(map, "linear", "LU-2")).toBeNull();
  });

  it("is a no-op when no users carry an email (connector lacks the scope/endpoint)", async () => {
    const seed = await seedTeam();
    const res = await syncProviderIdentities(db(), seed.teamId, "linear", [{ id: "LU-1", displayName: "Alex" }]);
    expect(res).toMatchObject({ scanned: 0, mapped: 0, skipped: 0 });
  });
});
