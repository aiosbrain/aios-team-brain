import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { itemPayloadSchema } from "@/lib/api/item-payload-schema";
import { ingestItem } from "@/lib/ingest";
import { db, seedTeam, type Seed } from "./helpers";

function hash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

async function ingestEvidence(
  seed: Seed,
  input: Record<string, unknown>
): Promise<{ status: string; id: string }> {
  const payload = itemPayloadSchema.parse({
    project: "evidence",
    actor: "reviewer",
    frontmatter: {},
    ...input,
  });
  if (payload.access !== "team" && payload.access !== "external") {
    throw new Error("test evidence must be syncable");
  }
  return ingestItem(
    db(),
    {
      teamId: seed.teamId,
      memberId: seed.memberId,
      apiKeyId: randomUUID(),
    },
    payload,
    payload.access
  );
}

describe("approved transcript evidence materialization (real Postgres)", () => {
  it("creates, updates, retries unchanged, diff-deletes, and inherits fact audience", async () => {
    const seed = await seedTeam();
    const path = "3-log/facts-team.md";
    const firstBody = "| fact-one | Annual plan is approved |";
    const first = await ingestEvidence(seed, {
      kind: "fact",
      path,
      access: "team",
      body: firstBody,
      content_sha256: hash(firstBody),
      rows: [
        {
          row_key: "fact-one",
          title: "Annual plan is approved",
          occurred_at: "2026-07-24",
          fact_type: "event",
          source_path: "1-context/transcripts/planning.md",
          source_quote: "We approved the annual plan today.",
        },
      ],
    });
    expect(first.status).toBe("created");

    const unchanged = await ingestEvidence(seed, {
      kind: "fact",
      path,
      access: "team",
      body: firstBody,
      content_sha256: hash(firstBody),
      rows: [
        {
          row_key: "fact-one",
          title: "Annual plan is approved",
          occurred_at: "2026-07-24",
          fact_type: "event",
          source_path: "1-context/transcripts/planning.md",
          source_quote: "We approved the annual plan today.",
        },
      ],
    });
    expect(unchanged.status).toBe("unchanged");

    const changedBody = "| fact-one | Annual operating plan is approved |";
    await ingestEvidence(seed, {
      kind: "fact",
      path,
      access: "team",
      body: changedBody,
      content_sha256: hash(changedBody),
      rows: [
        {
          row_key: "fact-one",
          title: "Annual operating plan is approved",
          fact_type: "fact",
          source_path: "1-context/transcripts/planning.md",
          source_quote: "We approved the annual plan today.",
        },
      ],
    });

    const { data: updated } = await db()
      .from("extracted_facts")
      .select("title, fact_type, audience, source_item_id")
      .eq("team_id", seed.teamId)
      .eq("row_key", "fact-one")
      .single();
    expect(updated).toMatchObject({
      title: "Annual operating plan is approved",
      fact_type: "fact",
      audience: "team",
      source_item_id: first.id,
    });

    // diff-delete: introduce a second fact on this item, then re-push a NON-EMPTY subset that omits
    // it. The contract requires >=1 row per fact push (canonical minItems:1), so a set can only be
    // SHRUNK, never fully cleared — fact-two is diff-deleted, fact-one survives on the same item.
    const twoBody = "| fact-one | Annual operating plan is approved | fact-two | Budget ratified |";
    await ingestEvidence(seed, {
      kind: "fact",
      path,
      access: "team",
      body: twoBody,
      content_sha256: hash(twoBody),
      rows: [
        {
          row_key: "fact-one",
          title: "Annual operating plan is approved",
          fact_type: "fact",
          source_path: "1-context/transcripts/planning.md",
          source_quote: "We approved the annual plan today.",
        },
        {
          row_key: "fact-two",
          title: "Budget ratified",
          fact_type: "event",
          source_path: "1-context/transcripts/planning.md",
          source_quote: "The budget was ratified.",
        },
      ],
    });
    const shrunkBody = "| fact-one | Annual operating plan is approved |";
    await ingestEvidence(seed, {
      kind: "fact",
      path,
      access: "team",
      body: shrunkBody,
      content_sha256: hash(shrunkBody),
      rows: [
        {
          row_key: "fact-one",
          title: "Annual operating plan is approved",
          fact_type: "fact",
          source_path: "1-context/transcripts/planning.md",
          source_quote: "We approved the annual plan today.",
        },
      ],
    });
    const { data: survivors } = await db()
      .from("extracted_facts")
      .select("row_key")
      .eq("team_id", seed.teamId);
    expect(survivors).toEqual([{ row_key: "fact-one" }]);
  });

  it("diff-deletes only rows originating from the synced item", async () => {
    const seed = await seedTeam();
    // Item B (external) — its row must survive a diff-delete run on item A.
    const secondBody = "| fact-source-two | Second source survives |";
    await ingestEvidence(seed, {
      kind: "fact",
      path: "4-shared/facts.md",
      access: "external",
      body: secondBody,
      content_sha256: hash(secondBody),
      rows: [
        {
          row_key: "fact-source-two",
          title: "Second source survives",
          fact_type: "fact",
          source_path: "1-context/transcripts/two.md",
          source_quote: "The second source survives.",
        },
      ],
    });
    // Item A (team) starts with TWO rows...
    const firstBody = "| fact-source-one | First source | fact-source-oneb | Kept on item A |";
    await ingestEvidence(seed, {
      kind: "fact",
      path: "3-log/facts-team.md",
      access: "team",
      body: firstBody,
      content_sha256: hash(firstBody),
      rows: [
        {
          row_key: "fact-source-one",
          title: "First source",
          fact_type: "fact",
          source_path: "1-context/transcripts/one.md",
          source_quote: "The first source.",
        },
        {
          row_key: "fact-source-oneb",
          title: "Kept on item A",
          fact_type: "fact",
          source_path: "1-context/transcripts/one.md",
          source_quote: "Kept on item A.",
        },
      ],
    });
    // ...then re-push a subset omitting fact-source-one. It is diff-deleted (same source item), while
    // fact-source-oneb (same item) and fact-source-two (a DIFFERENT item) are both untouched.
    const shrunk = "| fact-source-oneb | Kept on item A |";
    await ingestEvidence(seed, {
      kind: "fact",
      path: "3-log/facts-team.md",
      access: "team",
      body: shrunk,
      content_sha256: hash(shrunk),
      rows: [
        {
          row_key: "fact-source-oneb",
          title: "Kept on item A",
          fact_type: "fact",
          source_path: "1-context/transcripts/one.md",
          source_quote: "Kept on item A.",
        },
      ],
    });

    const { data } = await db()
      .from("extracted_facts")
      .select("row_key, audience")
      .eq("team_id", seed.teamId)
      .order("row_key");
    expect(data).toEqual([
      { row_key: "fact-source-oneb", audience: "team" },
      { row_key: "fact-source-two", audience: "external" },
    ]);
  });

  it("stores stakeholder mentions without mutating canonical identity or company graph", async () => {
    const seed = await seedTeam();
    const graphBefore = await Promise.all([
      db().from("graph_entities").select("id", { count: "exact", head: true }).eq("team_id", seed.teamId),
      db().from("graph_relationships").select("id", { count: "exact", head: true }).eq("team_id", seed.teamId),
      db().from("members").select("id", { count: "exact", head: true }).eq("team_id", seed.teamId),
    ]);
    const body = "| mention-jordan | Jordan Lee | VP Operations |";
    await ingestEvidence(seed, {
      kind: "stakeholder_mention",
      path: "4-shared/stakeholder-mentions.md",
      access: "external",
      body,
      content_sha256: hash(body),
      rows: [
        {
          row_key: "mention-jordan",
          name: "Jordan Lee",
          role: "VP Operations",
          context: "Owns the rollout",
          source_path: "1-context/transcripts/rollout.md",
          source_quote: "Jordan Lee owns the rollout.",
        },
      ],
    });

    const { data: mention } = await db()
      .from("stakeholder_mentions")
      .select("name, role, context, audience")
      .eq("team_id", seed.teamId)
      .single();
    expect(mention).toEqual({
      name: "Jordan Lee",
      role: "VP Operations",
      context: "Owns the rollout",
      audience: "external",
    });

    const graphAfter = await Promise.all([
      db().from("graph_entities").select("id", { count: "exact", head: true }).eq("team_id", seed.teamId),
      db().from("graph_relationships").select("id", { count: "exact", head: true }).eq("team_id", seed.teamId),
      db().from("members").select("id", { count: "exact", head: true }).eq("team_id", seed.teamId),
    ]);
    expect(graphAfter.map((result) => result.count)).toEqual(
      graphBefore.map((result) => result.count)
    );
  });
});
