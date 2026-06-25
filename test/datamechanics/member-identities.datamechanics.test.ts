import { describe, expect, it } from "vitest";
import { buildIdentityMap, resolveByProviderId, resolveMember } from "@/lib/identity/resolve";
import { db, seedTeam } from "./helpers";

// Spec: the shared resolver reads member_identities so a provider user id (Slack/Linear/…) AND any
// email carried on the identity both resolve to the same member. Verified on real Postgres.

describe("member_identities → resolver (real Postgres)", () => {
  it("resolves a Slack user id to the mapped member, and folds its email into byEmail", async () => {
    const seed = await seedTeam();
    await db().from("member_identities").insert({
      team_id: seed.teamId,
      member_id: seed.memberId,
      provider: "slack",
      external_id: "U0ALICE",
      handle: "alice",
      email: "alice@corp.com",
    });

    const map = await buildIdentityMap(db(), seed.teamId);
    expect(resolveByProviderId(map, "slack", "U0ALICE")).toBe(seed.memberId);
    // the email on the identity also resolves the same person (secondary match)
    expect(resolveMember(map, { email: "alice@corp.com" })).toBe(seed.memberId);
    // a different provider with the same external id does not match
    expect(resolveByProviderId(map, "linear", "U0ALICE")).toBeNull();
  });

  it("keeps the (provider, external_id) mapping team-scoped and one-to-one", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    // same Slack id in two teams maps to each team's own member, independently
    await db().from("member_identities").insert([
      { team_id: a.teamId, member_id: a.memberId, provider: "slack", external_id: "USHARED" },
      { team_id: b.teamId, member_id: b.memberId, provider: "slack", external_id: "USHARED" },
    ]);
    const mapA = await buildIdentityMap(db(), a.teamId);
    const mapB = await buildIdentityMap(db(), b.teamId);
    expect(resolveByProviderId(mapA, "slack", "USHARED")).toBe(a.memberId);
    expect(resolveByProviderId(mapB, "slack", "USHARED")).toBe(b.memberId);
  });
});
