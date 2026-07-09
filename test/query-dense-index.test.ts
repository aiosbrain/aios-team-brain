import { describe, expect, it } from "vitest";
import { indexItem, indexPendingItems, denseIndexAvailable } from "@/lib/query/dense-index";

/**
 * Spec: dense indexing is OFF by default (no EMBEDDINGS_URL in this env) and must be a clean no-op
 * that never touches the DB — so the default, extension-free install is completely unaffected by the
 * optional pgvector path. Derived from the "Option A / portable by default" requirement.
 * (The write path itself is proven end-to-end in the self-skipping pgvector data-mechanics test.)
 */

describe("dense indexing when unconfigured", () => {
  it("denseIndexAvailable() is false without EMBEDDINGS_URL", async () => {
    expect(await denseIndexAvailable()).toBe(false);
  });

  it("indexItem() is a clean no-op (no DB access) when dense retrieval is off", async () => {
    const r = await indexItem({
      id: "item-1",
      teamId: "team-1",
      body: "authentication redesign notes",
      access: "team",
      contentSha256: "deadbeef",
    });
    expect(r).toEqual({ itemId: "item-1", chunks: 0, skipped: true });
  });

  it("indexPendingItems() is a clean no-op (no DB access) when dense retrieval is off", async () => {
    const r = await indexPendingItems();
    expect(r).toEqual({ scanned: 0, indexed: 0, chunks: 0, skipped: true, failed: 0 });
  });
});
