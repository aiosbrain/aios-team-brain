import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ingestSubscription } from "@/lib/subscriptions/ingest";
import { getSubscriptions } from "@/lib/metrics/subscriptions";
import { IngestValidationError } from "@/lib/api/schemas";
import { db, seedTeam } from "./helpers";

describe("subscriptions ingest + read (v1.8)", () => {
  it("upserts a flat plan, updates in place, and reads it back", async () => {
    const seed = await seedTeam();
    const auth = {
      teamId: seed.teamId,
      memberId: seed.memberId,
      apiKeyId: "k",
    };

    await ingestSubscription(db(), auth, {
      provider: "claude",
      plan: "max_5x",
      monthly_usd: 100,
      source: "keychain",
    });
    // Re-push with the corrected plan → updates the same row (idempotent on team,member,provider).
    await ingestSubscription(db(), auth, {
      provider: "claude",
      plan: "max_20x",
      monthly_usd: 200,
      source: "config",
    });

    const view = await getSubscriptions(db(), seed.teamId, {
      isAdmin: true,
      memberId: seed.memberId,
    });
    expect(view.rows.length).toBe(1); // not duplicated
    expect(view.rows[0].plan).toBe("max_20x");
    expect(view.rows[0].monthly_usd).toBe(200);
    expect(view.monthly_usd).toBe(200);
  });

  it("role-scopes non-admins to their own subscription", async () => {
    const seed = await seedTeam();
    const { data: other } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: `${randomUUID()}@test.local`,
        display_name: "Other",
        actor_handle: `actor-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "team",
        status: "active",
      })
      .select("id")
      .single();
    const otherId = (other as { id: string }).id;

    await ingestSubscription(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: "k1" },
      {
        provider: "claude",
        plan: "max_20x",
        monthly_usd: 200,
        source: "config",
      },
    );
    await ingestSubscription(
      db(),
      { teamId: seed.teamId, memberId: otherId, apiKeyId: "k2" },
      { provider: "cursor", plan: "pro", monthly_usd: 20, source: "manual" },
    );

    const admin = await getSubscriptions(db(), seed.teamId, {
      isAdmin: true,
      memberId: seed.memberId,
    });
    expect(admin.rows.length).toBe(2);
    expect(admin.monthly_usd).toBe(220);

    // Non-admin member1 sees ONLY their own — member2's cursor sub must not leak.
    const self = await getSubscriptions(db(), seed.teamId, {
      isAdmin: false,
      memberId: seed.memberId,
    });
    expect(self.selfOnly).toBe(true);
    expect(self.rows.length).toBe(1);
    expect(self.rows[0].provider).toBe("claude");
    expect(self.monthly_usd).toBe(200);
  });

  it("rejects an unknown member handle as a client error (→ 422)", async () => {
    const seed = await seedTeam();
    await expect(
      ingestSubscription(
        db(),
        { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: "k" },
        {
          member: "nobody-here",
          provider: "claude",
          plan: "pro",
          monthly_usd: 20,
          source: "manual",
        },
      ),
    ).rejects.toBeInstanceOf(IngestValidationError);
  });
});
