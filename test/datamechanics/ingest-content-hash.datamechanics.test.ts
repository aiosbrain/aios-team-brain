import { describe, expect, it } from "vitest";
import { db, seedTeam, ingest, sha } from "./helpers";

/**
 * Spec: `content_sha256` is the ingest contract's CHANGE KEY — it decides "new work" vs "no-op
 * re-sync". Integrity of that key is the contract's own invariant, so the server hashes the body it
 * is about to store; the wire field is advisory. Derived from the contract (dedup must be correct
 * for any producer), not from the implementation.
 *
 * The wire field was previously trusted verbatim, which delegated dedup integrity to every present
 * and future connector and produced two silent failures — both reproduced below:
 *   (a) a client whose hash covers a different normalization marks every push "changed" → endless
 *       version/embed/projection churn;
 *   (b) a client that repeats a STALE sha while the body changed hits the unchanged fast-path and
 *       the stored body NEVER updates — permanently stale content served to retrieval, no error.
 * Real Postgres is the right tier: the observable outcome is the stored row + the version ledger.
 */

async function readItem(id: string): Promise<{ body: string; content_sha256: string }> {
  const { data } = await db().from("items").select("body, content_sha256").eq("id", id).maybeSingle();
  return data as { body: string; content_sha256: string };
}

async function countVersions(itemId: string): Promise<number> {
  const { data } = await db().from("item_versions").select("id").eq("item_id", itemId);
  return (data ?? []).length;
}

describe("ingest content hash (server-authoritative change key)", () => {
  it("stores the body's OWN hash, ignoring a client that lies about it", async () => {
    const seed = await seedTeam();
    const { id } = await ingest(seed, {
      path: "lying-client.md",
      body: "the real body",
      access: "team",
      content_sha256: sha("a completely different body"),
    });

    const row = await readItem(id);
    expect(row.body).toBe("the real body");
    // The stored key is the hash of what we actually hold — not the client's claim.
    expect(row.content_sha256).toBe(sha("the real body"));

    // …and the disagreement is RECORDED, so a buggy connector is diagnosable rather than silent.
    // It rides the item's existing create/update audit row (never its own row, never on the
    // unchanged fast-path) so a systematically-wrong client can't grow audit_log unboundedly.
    const { data: audits } = await db()
      .from("audit_log")
      .select("action, meta")
      .eq("target_id", id);
    const created = (audits ?? []).find(
      (a) => (a as { action: string }).action === "item.created"
    ) as { meta: Record<string, unknown> } | undefined;
    expect(created?.meta?.sha_mismatch).toBe(true);
    expect(created?.meta?.client_sha).toBe(sha("a completely different body"));
  });

  it("records NO mismatch flag when the client's sha is honest", async () => {
    const seed = await seedTeam();
    const { id } = await ingest(seed, { path: "honest-client.md", body: "agreed body", access: "team" });
    const { data: audits } = await db()
      .from("audit_log")
      .select("action, meta")
      .eq("target_id", id);
    const created = (audits ?? []).find(
      (a) => (a as { action: string }).action === "item.created"
    ) as { meta: Record<string, unknown> } | undefined;
    expect(created).toBeDefined();
    expect(created?.meta?.sha_mismatch).toBeUndefined();
  });

  it("UPDATES a changed body even when the client repeats the stale sha (the frozen-body bug)", async () => {
    const seed = await seedTeam();
    const first = await ingest(seed, { path: "frozen.md", body: "v1", access: "team" });
    expect(first.status).toBe("created");

    // The client edits the body but re-sends v1's sha (a buggy/cached hasher). Trusting the wire
    // field took the unchanged fast-path here: the stored body stayed "v1" forever, silently.
    const second = await ingest(seed, {
      path: "frozen.md",
      body: "v2 — a real edit",
      access: "team",
      content_sha256: sha("v1"),
    });

    expect(second.status).toBe("updated");
    const row = await readItem(second.id);
    expect(row.body).toBe("v2 — a real edit");
    expect(row.content_sha256).toBe(sha("v2 — a real edit"));
    // The edit is a real unit of work: it must be recorded in the version ledger.
    expect(await countVersions(second.id)).toBe(2);
  });

  it("treats an unchanged body as unchanged even when the client's sha churns", async () => {
    const seed = await seedTeam();
    const body = "stable content";
    const first = await ingest(seed, {
      path: "churn.md",
      body,
      access: "team",
      content_sha256: sha("client normalization A"),
    });
    const second = await ingest(seed, {
      path: "churn.md",
      body,
      access: "team",
      content_sha256: sha("client normalization B"),
    });

    // Same body → no new work, regardless of what the client's hasher decided.
    expect(second.status).toBe("unchanged");
    expect(await countVersions(first.id)).toBe(1);
  });
});
