import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, sha } from "./helpers";

// Spec (brain-api contract): ingest is idempotent by content_sha256, versions on
// body change, and the item's full-text `search` column is populated. These are
// real-DB outcomes the in-memory FakeSupabase cannot verify (no generated column,
// no constraints). Verified to the observable outcome: the row read back from PG.

describe("ingest persistence (real Postgres)", () => {
  it("creates an item and populates the generated `search` tsvector", async () => {
    const seed = await seedTeam();
    const body = "the governance review gates run in advisory mode";
    const res = await ingest(seed, { path: "deliverables/gov.md", body, access: "team" });
    expect(res.status).toBe("created");

    const { data } = await db()
      .from("items")
      .select("content_sha256, search, body")
      .eq("id", res.id)
      .single();
    expect(data?.content_sha256).toBe(sha(body));
    // `search` is GENERATED ALWAYS in Postgres — proves we hit a real DB, not a stub.
    expect(typeof data?.search).toBe("string");
    expect((data?.search as string).length).toBeGreaterThan(0);
    // Postgres `english` config stems tokens: "governance" → lexeme "govern".
    expect(data?.search as string).toContain("govern");
  });

  it("is idempotent by sha: identical re-ingest is 'unchanged' with no new version", async () => {
    const seed = await seedTeam();
    const body = "stable body";
    const first = await ingest(seed, { path: "d/x.md", body, access: "team" });
    expect(first.status).toBe("created");

    const versionsAfterCreate = await countVersions(first.id);
    expect(versionsAfterCreate).toBe(1);

    const second = await ingest(seed, { path: "d/x.md", body, access: "team" });
    expect(second.status).toBe("unchanged");
    expect(second.id).toBe(first.id);
    expect(await countVersions(first.id)).toBe(1); // no new version on a no-op
  });

  it("versions on body change and updates the sha", async () => {
    const seed = await seedTeam();
    const a = await ingest(seed, { path: "d/y.md", body: "v1", access: "team" });
    const b = await ingest(seed, { path: "d/y.md", body: "v2 changed", access: "team" });
    expect(b.status).toBe("updated");
    expect(b.id).toBe(a.id);
    expect(await countVersions(a.id)).toBe(2);

    const { data } = await db().from("items").select("content_sha256").eq("id", a.id).single();
    expect(data?.content_sha256).toBe(sha("v2 changed"));
  });
});

async function countVersions(itemId: string): Promise<number> {
  const { data } = await db().from("item_versions").select("id").eq("item_id", itemId);
  return (data ?? []).length;
}
