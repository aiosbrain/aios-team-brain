import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GET as getMe } from "@/app/api/v1/me/route";
import { pickHomeState } from "@/lib/dashboard/home-state";
import { db, ingest, seedTeam } from "./helpers";

// Spec: a non-admin member invited into an ALREADY-ACTIVE team (itemCount > 0) with zero
// validated api_keys must land on "member-setup" — the root-cause bug this phase fixes
// (the old team-scoped-only checklist never fired for this exact scenario, since it only
// showed when the whole TEAM had zero synced items). Once that member issues a key, the
// same team+member flips to "dashboard". Verified through the real /api/v1/me authentication
// path and Postgres persistence, not just the pure decision function in isolation. Issuing a
// key is not enough: last_used_at is populated only after authentication succeeds.

describe("dashboard home-state on an active team with a brand-new member (real Postgres)", () => {
  it("member-setup fires for a member with no key, even though the team already has synced items", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "docs/plan.md", body: "already active", access: "team" });

    const { count: itemCount } = await db()
      .from("items")
      .select("id", { count: "exact", head: true })
      .eq("team_id", seed.teamId);
    expect(itemCount ?? 0).toBeGreaterThan(0); // non-vacuity: team really is active

    const { count: ownKeyCount } = await db()
      .from("api_keys")
      .select("id", { count: "exact", head: true })
      .eq("team_id", seed.teamId)
      .eq("member_id", seed.memberId);
    expect(ownKeyCount ?? 0).toBe(0);

    expect(
      pickHomeState({ isAdmin: false, itemCount: itemCount ?? 0, hasConnectedKey: false })
    ).toBe("member-setup");
  });

  it("stays in setup after issue, then flips once that key authenticates", async () => {
    const seed = await seedTeam();
    const keyId = `k${seed.memberId.replaceAll("-", "").slice(0, 12)}`;
    const secret = "datamechanics_secret";
    await ingest(seed, { path: "docs/plan.md", body: "already active", access: "team" });
    await db()
      .from("api_keys")
      .insert({
        team_id: seed.teamId,
        member_id: seed.memberId,
        key_id: keyId,
        key_hash: createHash("sha256").update(secret).digest("hex"),
        name: "laptop",
      });

    const { count: itemCount } = await db()
      .from("items")
      .select("id", { count: "exact", head: true })
      .eq("team_id", seed.teamId);
    const { count: ownKeyCount } = await db()
      .from("api_keys")
      .select("id", { count: "exact", head: true })
      .eq("team_id", seed.teamId)
      .eq("member_id", seed.memberId);
    expect(ownKeyCount ?? 0).toBe(1);

    expect(
      pickHomeState({ isAdmin: false, itemCount: itemCount ?? 0, hasConnectedKey: false })
    ).toBe("member-setup");

    const response = await getMe(
      new Request("https://brain.test/api/v1/me", {
        headers: {
          Authorization: `Bearer aios_${keyId}_${secret}`,
          "X-AIOS-Team": seed.teamSlug,
        },
      }) as Parameters<typeof getMe>[0],
    );
    expect(response.status).toBe(200);

    const { data: validatedKeys } = await db()
      .from("api_keys")
      .select("last_used_at, revoked_at")
      .eq("team_id", seed.teamId)
      .eq("member_id", seed.memberId);
    const hasConnectedKey = (validatedKeys ?? []).some(
      (key) => !key.revoked_at && !!key.last_used_at,
    );

    expect(
      pickHomeState({ isAdmin: false, itemCount: itemCount ?? 0, hasConnectedKey })
    ).toBe("dashboard");
  });
});
