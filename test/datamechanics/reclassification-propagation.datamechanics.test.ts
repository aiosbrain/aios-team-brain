import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ingestItem } from "@/lib/ingest";
import { TierViolationError } from "@/lib/api/schemas";
import { visibleGroupIds } from "@/lib/graph/group";
import type { ItemPayload } from "@/lib/api/item-payload-schema";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { createHash } from "node:crypto";

/**
 * Spec (Pass-1 review, Wave 0 M1 + the trust-gate gap #374 deferred): a tier reclassification has to
 * reach EVERY surface that already committed the old tier to storage — not just `items.access`.
 *
 * There is no RLS (CLAUDE.md §5), so a cached payload built under the old tier keeps serving the old
 * tier's content on its own schedule. `arc_cache` (4h) holds LLM narrative prose synthesized FROM the
 * item, and `work_timeline_cache` (5min) holds titles + LLM day-summaries — both keyed by viewer tier.
 * A row narrowed external→team therefore stays readable by an external principal until the TTL expires
 * unless the reclassification purges the external-tier rows.
 *
 * And the tier a pusher may WRITE is itself an access-control decision: #374 gated the unchanged path
 * but left the changed-body path ungated.
 */

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

async function teamSlugFor(teamId: string): Promise<string> {
  const { data } = await db().from("teams").select("slug").eq("id", teamId).maybeSingle();
  return (data as { slug: string }).slug;
}

/** Push as a specific principal tier — the helper always pushes as a trusted team-tier connector. */
async function ingestAs(
  seed: Seed,
  pusherTier: "team" | "external",
  over: { body: string; path: string; access: "team" | "external"; kind?: ItemPayload["kind"] }
) {
  const payload = {
    project: "acme",
    kind: over.kind ?? "deliverable",
    actor: "tester",
    frontmatter: {},
    content_sha256: sha(over.body),
    ...over,
  } as ItemPayload;
  return ingestItem(
    db(),
    { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
    payload,
    over.access,
    undefined,
    pusherTier
  );
}

/** A cache row that was computed under the OLD tier — i.e. one that may still be serving the content. */
async function seedCaches(teamId: string, teamSlug: string): Promise<void> {
  const externalKey = visibleGroupIds(teamSlug, "external").slice().sort().join(",");
  const teamKey = visibleGroupIds(teamSlug, "team").slice().sort().join(",");
  const now = new Date().toISOString();
  for (const key of [externalKey, teamKey]) {
    await db()
      .from("arc_cache")
      .upsert(
        { team_id: teamId, group_key: key, arcs: JSON.stringify([{ title: "the client spec arc" }]), facts_hash: "h", computed_at: now },
        { onConflict: "team_id,group_key" }
      );
  }
  for (const tier of ["external", "team"]) {
    await db()
      .from("work_timeline_cache")
      .upsert(
        { team_id: teamId, group_key: tier, payload: JSON.stringify({ v: 5, days: [] }), computed_at: now },
        { onConflict: "team_id,group_key" }
      );
  }
}

async function cacheRows(teamId: string) {
  const { data: arcs } = await db().from("arc_cache").select("group_key, computed_at").eq("team_id", teamId);
  const { data: timeline } = await db()
    .from("work_timeline_cache")
    .select("group_key, computed_at")
    .eq("team_id", teamId);
  return {
    arcKeys: ((arcs ?? []) as { group_key: string }[]).map((r) => r.group_key).sort(),
    timelineKeys: ((timeline ?? []) as { group_key: string }[]).map((r) => r.group_key).sort(),
    timelineComputedAt: Object.fromEntries(
      ((timeline ?? []) as { group_key: string; computed_at: string | Date }[]).map((r) => [
        r.group_key,
        new Date(r.computed_at).getTime(),
      ])
    ),
  };
}

describe("tier reclassification propagates past items.access (real Postgres)", () => {
  it("NARROWING external→team purges the external-tier cache rows, leaving the team-tier ones", async () => {
    // The leak: both cached payloads are DERIVED TEXT (arc prose, timeline titles + day summaries)
    // built from the item while it was external, so an external viewer keeps reading the now-internal
    // content for up to 4h. Marking them stale is not enough — the read path is serve-stale-while-
    // revalidate, so a stale row is still SERVED once (and to every viewer until the rebuild lands).
    // The external rows must be gone.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const externalArcKey = visibleGroupIds(slug, "external").slice().sort().join(",");
    const teamArcKey = visibleGroupIds(slug, "team").slice().sort().join(",");

    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the client spec", access: "external" });
    await seedCaches(seed.teamId, slug);

    // Reclassified upstream WITHOUT touching the prose — the unchanged fast path.
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the client spec", access: "team" });

    const after = await cacheRows(seed.teamId);
    expect(after.arcKeys).toEqual([teamArcKey]); // external arc prose gone
    expect(after.timelineKeys).toEqual(["team"]); // external ledger gone
    expect(after.arcKeys).not.toContain(externalArcKey);
  });

  it("WIDENING team→external only marks the external rows stale — nothing leaked, so don't force a cold rebuild", async () => {
    // The asymmetry is the point. Widening means the external payload is MISSING content it should now
    // include — staleness, not a leak. Deleting it would force a cold LLM re-synthesis (and with no
    // prior, the empty-clobber guard has nothing to protect), so the cheaper stale-mark is correct.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the internal spec", access: "team" });
    await seedCaches(seed.teamId, slug);
    const before = await cacheRows(seed.teamId);

    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the internal spec", access: "external" });

    const after = await cacheRows(seed.teamId);
    expect(after.timelineKeys).toEqual(["external", "team"]); // rows survive…
    expect(after.arcKeys).toHaveLength(2);
    // …but the external one is now old enough that the next read rebuilds it.
    expect(after.timelineComputedAt.external).toBeLessThan(before.timelineComputedAt.external);
  });

  it("cascades the healed tier to the evidence tables, not just tasks", async () => {
    // `extracted_facts` / `stakeholder_mentions` each carry their own `audience` and are only stamped by
    // materialize — which does NOT run on the unchanged path. Left behind, they are a tier-filtered
    // table holding rows at the pre-reclassification tier.
    const seed = await seedTeam();
    const item = await ingest(seed, {
      kind: "deliverable",
      path: "docs/spec.md",
      body: "the client spec",
      access: "external",
    });
    for (const table of ["extracted_facts", "stakeholder_mentions"] as const) {
      const base = {
        team_id: seed.teamId,
        project_id: item.projectId,
        source_item_id: item.id,
        row_key: `${table}-1`,
        source_path: "docs/spec.md",
        source_quote: "q",
        audience: "external",
      };
      await db()
        .from(table)
        .insert(
          table === "extracted_facts"
            ? { ...base, title: "a fact", fact_type: "fact" }
            : { ...base, name: "Dana" }
        );
    }

    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the client spec", access: "team" });

    for (const table of ["extracted_facts", "stakeholder_mentions"] as const) {
      const { data } = await db().from(table).select("audience").eq("source_item_id", item.id).maybeSingle();
      expect((data as { audience: string }).audience, table).toBe("team");
    }
  });
});

describe("only a trusted pusher may set an item's tier (real Postgres)", () => {
  it("REFUSES an external-tier pusher MODIFYING an existing team-tier item", async () => {
    // #374 closed this on the unchanged path only. On the changed path `access` went straight into the
    // item record with no gate, so an external key could re-push a known team item's path with its own
    // body and flip the row to `external` — publishing the internal item's history and downstream rows
    // to the external tier, and destroying the internal content on the way.
    //
    // Refused rather than clamped, because unlike the identical-body case this pusher IS trying to
    // change something it doesn't own; a silent partial accept would hide a misconfigured connector.
    const seed = await seedTeam();
    await ingest(seed, { kind: "deliverable", path: "docs/internal.md", body: "internal-only plan", access: "team" });

    await expect(
      ingestAs(seed, "external", { path: "docs/internal.md", body: "client-supplied body", access: "external" })
    ).rejects.toBeInstanceOf(TierViolationError);

    const { data } = await db()
      .from("items")
      .select("access, body")
      .eq("team_id", seed.teamId)
      .eq("path", "docs/internal.md")
      .maybeSingle();
    const row = data as { access: string; body: string };
    expect(row.access).toBe("team"); // untouched
    expect(row.body).toBe("internal-only plan"); // and not overwritten
  });

  it("clamps an external pusher PROMOTING its own external item to team tier on the changed path", async () => {
    // The other direction of the same gap: an external key must not be able to inject content into the
    // internal tier either. Its payload tier is advisory for an item that already exists.
    const seed = await seedTeam();
    await ingestAs(seed, "external", { path: "docs/client.md", body: "v1", access: "external" });

    await ingestAs(seed, "external", { path: "docs/client.md", body: "v2 — now claiming team tier", access: "team" });

    const { data } = await db()
      .from("items")
      .select("access, body")
      .eq("team_id", seed.teamId)
      .eq("path", "docs/client.md")
      .maybeSingle();
    const row = data as { access: string; body: string };
    expect(row.access).toBe("external"); // tier clamped to the stored one…
    expect(row.body).toBe("v2 — now claiming team tier"); // …while its own content still updates
  });

  it("a TRUSTED pusher still reclassifies on the changed path (the gate isn't a blanket freeze)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "v1", access: "external" });
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "v2 internal", access: "team" });

    const { data } = await db()
      .from("items")
      .select("access")
      .eq("team_id", seed.teamId)
      .eq("path", "docs/spec.md")
      .maybeSingle();
    expect((data as { access: string }).access).toBe("team");
  });
});
