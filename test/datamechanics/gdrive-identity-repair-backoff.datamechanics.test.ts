import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { getPool } from "@/lib/db/pg/pool";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { runIdentityRepairObligation } from "@/lib/ingest/identity-repair";
import { db, driveFixture, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1167 R44 C13 — a repair obligation's backoff counts FAILURES, not healthy batches.
 *
 * Spec (adjudication C13). A long obligation that converges batch by batch is not failing: its
 * healthy batches must not inflate the delay a later real failure gets. After any number of healthy
 * batches, the first failure backs off by the first-failure delay (2^0 = 1 s); each further failure
 * doubles it. A restart after the failures resumes from the obligation's own cursor — nothing already
 * scanned is scanned again — and completes.
 */

const EXTERNAL_ID = "permission:backoff-person";

async function driveItem(seed: Seed, suffix: string) {
  const result = await driveFixture(seed, {
    project: "drive-repair-backoff",
    path: `gdrive/${suffix}-${randomUUID()}.md`,
    body: `body ${suffix}`,
    frontmatter: {
      source: "gdrive",
      source_id: `doc-${suffix}`,
      title: `Drive ${suffix}`,
      authors: [{ provider: "gdrive", external_id: EXTERNAL_ID, email: "provider@example.com", role: "editor" }],
      contributions: [{ external_id: EXTERNAL_ID, email: "provider@example.com", role: "editor", at: "2026-09-21T08:30:00Z" }],
    },
  }, { unclaimed: true, access: "team", attribution: { authorMemberId: null } });
  return result.id;
}

async function state(seed: Seed, revision: number) {
  const { rows } = await getPool().query<{ status: string; attempts: number; items_scanned: number; delay: number | null }>(
    `select status, attempts::int as attempts, items_scanned::int as items_scanned,
            extract(epoch from (next_attempt_at - updated_at))::float8 as delay
       from identity_repair_obligations
      where team_id=$1 and provider='gdrive' and external_id=$2 and mapping_revision=$3`,
    [seed.teamId, EXTERNAL_ID, revision],
  );
  if (rows.length !== 1) throw new Error(`expected one obligation, found ${rows.length}`);
  return rows[0];
}

const failing = { afterSnapshot: async () => { throw new Error("injected repair failure"); } };

describe("identity repair obligation backoff (R44 C13, real Postgres)", () => {
  it("healthy batches add no attempts; failures back off from the first-failure delay; a restart resumes", async () => {
    const seed = await seedTeam();
    const items = 4;
    for (let i = 0; i < items; i += 1) await driveItem(seed, `b${i}`);
    const linked = await setMemberIdentity(db(), seed.teamId, seed.memberId, { provider: "gdrive", externalId: EXTERNAL_ID });
    const revision = linked.mappingRevision;
    if (revision === undefined) throw new Error("the Drive link recorded no mapping revision");
    const { data } = await db().from("identity_repair_obligations")
      .select("team_id,provider,external_id,mapping_revision,cursor_item_id,items_scanned,items_updated,versions_updated,contributions_updated")
      .eq("team_id", seed.teamId).eq("provider", "gdrive").eq("external_id", EXTERNAL_ID).eq("mapping_revision", revision)
      .single();
    const obligation = data as Parameters<typeof runIdentityRepairObligation>[1];

    // Three healthy batches of one item each: progress, and no attempt recorded.
    for (let batch = 0; batch < 3; batch += 1) {
      expect((await runIdentityRepairObligation(db(), obligation, { batchSize: 1 })).status).toBe("partial");
    }
    expect(await state(seed, revision)).toMatchObject({ status: "running", attempts: 0, items_scanned: 3 });

    // The first real failure backs off by the FIRST-failure delay, not one inflated by the batches.
    await expect(runIdentityRepairObligation(db(), obligation, { batchSize: 1, hooks: failing })).rejects.toThrow(/injected/);
    const first = await state(seed, revision);
    expect(first).toMatchObject({ status: "retry", attempts: 1 });
    expect(first.delay).toBe(1);

    // A repeated failure doubles it.
    await expect(runIdentityRepairObligation(db(), obligation, { batchSize: 1, hooks: failing })).rejects.toThrow(/injected/);
    const second = await state(seed, revision);
    expect(second).toMatchObject({ status: "retry", attempts: 2 });
    expect(second.delay).toBe(2);

    // Restart: resumes from its own cursor (the fourth item only), then completes.
    expect((await runIdentityRepairObligation(db(), obligation, { batchSize: 1 })).status).toBe("partial");
    expect((await runIdentityRepairObligation(db(), obligation, { batchSize: 1 })).status).toBe("complete");
    expect(await state(seed, revision)).toMatchObject({ status: "complete", items_scanned: items });
  });
});
