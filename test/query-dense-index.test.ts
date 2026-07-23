import { describe, expect, it } from "vitest";
import { indexItem, indexPendingItems, itemChunksTablePresent, resetDenseIndexProbe } from "@/lib/query/dense-index";
import type { EmbeddingBackend } from "@/lib/query/embeddings-backend";

/**
 * Spec: dense indexing is OFF when the optional pgvector `item_chunks` table isn't loaded — a clean
 * no-op that never corrupts the default, extension-free install. (The write path itself is proven
 * end-to-end in the self-skipping pgvector data-mechanics test.) In this unit env there's no DB, so
 * the table probe fails → dense is off.
 */

const DUMMY_BACKEND: EmbeddingBackend = {
  provider: "env",
  baseUrl: "http://localhost:9/v1",
  model: "text-embedding-3-small",
  apiKey: "local",
  dim: 1536,
};

describe("dense indexing when the pgvector table is absent", () => {
  it("itemChunksTablePresent() is false without item_chunks", async () => {
    resetDenseIndexProbe();
    expect(await itemChunksTablePresent()).toBe(false);
  });

  it("indexItem() is a clean no-op (table absent) regardless of backend", async () => {
    const r = await indexItem(
      { id: "item-1", teamId: "team-1", body: "authentication redesign notes", access: "team", contentSha256: "deadbeef" },
      DUMMY_BACKEND
    );
    expect(r).toEqual({ itemId: "item-1", chunks: 0, skipped: true });
  });

  it("indexPendingItems() is a clean no-op when the table is absent", async () => {
    const r = await indexPendingItems();
    expect(r).toEqual({ scanned: 0, indexed: 0, chunks: 0, skipped: true, failed: 0 });
  });
});
