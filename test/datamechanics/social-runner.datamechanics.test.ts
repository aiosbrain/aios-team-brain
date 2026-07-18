import { describe, expect, it } from "vitest";
import { createOpportunity, getVariant, setVariantGeneration, setVariantStatus } from "@/lib/social/store";
import { planOpportunity } from "@/lib/social/plan";
import { setPublishDryRun } from "@/lib/social/settings";
import { scheduleVariant, runPublication } from "@/lib/social/publish";
import { createPublication, getPublication } from "@/lib/social/publications";
import type { PublishRequest, SocialPublishingProvider } from "@/lib/social/providers/types";
import { db, seedTeam } from "./helpers";

/**
 * Spec for the runner-side hardening (2026-07-16 audit #2 idempotency, #5 double-submit), on real
 * Postgres with the provider STUBBED + call-counted. The observable outcomes: a retry after the
 * provider already accepted does NOT create a second live post, and a variant can never hold two
 * ACTIVE publications (→ two posts). The provider is instrumented so "how many times did we post?"
 * is a hard assertion.
 */

function recorder(): SocialPublishingProvider & { calls: number; last?: PublishRequest } {
  const p = {
    name: "stub",
    calls: 0,
    last: undefined as PublishRequest | undefined,
    async publish(req: PublishRequest) {
      p.calls++;
      p.last = req;
      return { externalId: `ext-${p.calls}`, url: "https://x.com/1", status: "published" };
    },
  };
  return p;
}

async function liveApprovedVariant() {
  const seed = await seedTeam();
  const opp = await createOpportunity(db(), seed.teamId, { access: "external", sourceType: "manual", title: "Ship it" });
  const { variants } = await planOpportunity(db(), seed.teamId, opp.id, { memberId: seed.memberId });
  const variantId = variants[0].id;
  await setVariantGeneration(db(), seed.teamId, variantId, { body: "we shipped a durable queue", status: "generated", validation: {} });
  await setVariantStatus(db(), seed.teamId, variantId, "approved");
  await setPublishDryRun(db(), seed.teamId, false); // LIVE
  return { seed, variantId };
}

describe("publish runner idempotency + double-submit (real Postgres, stubbed provider)", () => {
  it("#2 sends a stable per-publication idempotency key and persists the external id", async () => {
    const { seed, variantId } = await liveApprovedVariant();
    const pub = await scheduleVariant(db(), seed.teamId, variantId);
    const stub = recorder();
    await runPublication(db(), seed.teamId, pub.id, { provider: stub });
    expect(stub.calls).toBe(1);
    expect(stub.last?.idempotencyKey).toBe(`publish:${pub.id}`);
    const after = await getPublication(db(), seed.teamId, pub.id);
    expect(after!.status).toBe("published");
    expect(after!.external_id).toBe("ext-1");
  });

  it("#2 a retry of a job that FAILED after posting (id persisted) does NOT re-post", async () => {
    // Non-vacuous: status 'failed' (not the terminal 'published'/'cancelled' early-return) forces the
    // re-entry through the external_id short-circuit. On revert, the door passes (variant scheduled)
    // and the stub is called a second time.
    const { seed, variantId } = await liveApprovedVariant();
    const pub = await scheduleVariant(db(), seed.teamId, variantId);
    // The provider accepted (id persisted) but a later write threw → the row is 'failed' with the id.
    await db()
      .from("social_publications")
      .update({ status: "failed", external_id: "ext-prior", last_error: "db blip after post", updated_at: new Date().toISOString() })
      .eq("team_id", seed.teamId)
      .eq("id", pub.id);

    const stub = recorder();
    await runPublication(db(), seed.teamId, pub.id, { provider: stub });
    expect(stub.calls).toBe(0); // already posted last time — finalize, never re-post
    const after = await getPublication(db(), seed.teamId, pub.id);
    expect(after!.status).toBe("published");
    expect(after!.external_id).toBe("ext-prior");
  });

  it("#2 re-entry after a crash between provider-accept and 'published' finalizes without re-posting", async () => {
    const { seed, variantId } = await liveApprovedVariant();
    const pub = await scheduleVariant(db(), seed.teamId, variantId);
    // Simulate the crash window: the provider accepted and we persisted its external id, but the
    // process died before marking 'published' — the row is left 'publishing' with an external id.
    await db()
      .from("social_publications")
      .update({ status: "publishing", external_id: "ext-prior", updated_at: new Date().toISOString() })
      .eq("team_id", seed.teamId)
      .eq("id", pub.id);

    const stub = recorder();
    await runPublication(db(), seed.teamId, pub.id, { provider: stub });
    expect(stub.calls).toBe(0); // the post already went out last time — NEVER re-post
    const after = await getPublication(db(), seed.teamId, pub.id);
    expect(after!.status).toBe("published");
    expect(after!.external_id).toBe("ext-prior"); // kept the original id
    expect((await getVariant(db(), seed.teamId, variantId))!.status).toBe("published");
  });

  it("#2 a no-id provider response still arms the short-circuit (sentinel), so a retry can't re-post", async () => {
    const { seed, variantId } = await liveApprovedVariant();
    const pub = await scheduleVariant(db(), seed.teamId, variantId);
    let calls = 0;
    const noId: SocialPublishingProvider = {
      name: "noid",
      publish: async () => {
        calls++;
        return { externalId: "", url: null, status: "accepted" }; // the verify-at-build no-id case
      },
    };
    await runPublication(db(), seed.teamId, pub.id, { provider: noId });
    expect(calls).toBe(1);
    const after = await getPublication(db(), seed.teamId, pub.id);
    expect(after!.status).toBe("published");
    expect(after!.external_id).toBe(`accepted:${pub.id}`); // sentinel, NOT empty — arms the guard

    // A crash-window retry (row forced back to a non-terminal state) must not re-post.
    await db().from("social_publications").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", pub.id);
    await runPublication(db(), seed.teamId, pub.id, { provider: noId });
    expect(calls).toBe(1); // still one — the sentinel short-circuited the retry
  });

  it("#5 a variant cannot hold two ACTIVE publications — the second insert is refused", async () => {
    const { seed, variantId } = await liveApprovedVariant();
    // First active publication (scheduled).
    await createPublication(db(), seed.teamId, { variantId, access: "external", dryRun: false, scheduledAt: new Date().toISOString() });
    // A racing second create for the same variant (both would post) must be refused by the partial
    // unique index — the DB backstop, not just the app-level status check.
    await expect(
      createPublication(db(), seed.teamId, { variantId, access: "external", dryRun: false, scheduledAt: new Date().toISOString() })
    ).rejects.toThrow(/active publication/i);

    const { count } = await db()
      .from("social_publications")
      .select("id", { count: "exact", head: true })
      .eq("team_id", seed.teamId)
      .in("status", ["scheduled", "publishing"]);
    expect(count).toBe(1); // exactly one active
  });

  it("#5 a variant CAN be re-scheduled after its prior publication is cancelled (partial index only)", async () => {
    const { seed, variantId } = await liveApprovedVariant();
    const first = await createPublication(db(), seed.teamId, { variantId, access: "external", dryRun: false, scheduledAt: new Date().toISOString() });
    // Cancel the first — now no ACTIVE publication, so a new one is allowed.
    await db().from("social_publications").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", first.id);
    await expect(
      createPublication(db(), seed.teamId, { variantId, access: "external", dryRun: false, scheduledAt: new Date().toISOString() })
    ).resolves.toBeTruthy();
  });
});
