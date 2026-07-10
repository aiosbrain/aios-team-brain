import { afterEach, describe, expect, it, vi } from "vitest";
import { getRetrievalHealth } from "@/lib/query/retrieval-health";
import { seedTeam, type Seed } from "./helpers";

// Spec: getRetrievalHealth must degrade GRACEFULLY against the real DB — the standard test Postgres
// has no pgvector/item_chunks, which is exactly the "semantic search off" reality it must report
// (not throw). Keyword is always on; graph/rerank reflect env.

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
  vi.unstubAllEnvs();
});

describe("getRetrievalHealth (real Postgres, no pgvector)", () => {
  it("reports keyword on and semantic off (pgvector schema not loaded) without throwing", async () => {
    const seed: Seed = await seedTeam();
    vi.stubEnv("EMBEDDINGS_URL", "https://api.openai.com/v1"); // configured, but item_chunks absent
    const h = await getRetrievalHealth(seed.teamId);
    expect(h.keyword).toBe("on");
    expect(h.dense.state).toBe("off");
    expect(h.dense.note).toMatch(/pgvector/i);
  });

  it("reports semantic off with the right reason when EMBEDDINGS_URL is unset", async () => {
    const seed: Seed = await seedTeam();
    vi.stubEnv("EMBEDDINGS_URL", "");
    const h = await getRetrievalHealth(seed.teamId);
    expect(h.dense.state).toBe("off");
    expect(h.dense.note).toMatch(/EMBEDDINGS_URL/);
  });

  it("reflects graph + rerank config (malformed GRAPHITI_URL reads off)", async () => {
    const seed: Seed = await seedTeam();
    vi.stubEnv("GRAPHITI_URL", "http://"); // the malformed value prod actually had
    vi.stubEnv("RERANK_URL", "");
    const h = await getRetrievalHealth(seed.teamId);
    expect(h.graph).toBe("off");
    expect(h.rerank).toBe("off");

    vi.stubEnv("RERANK_URL", "https://rerank.example.com");
    expect((await getRetrievalHealth(seed.teamId)).rerank).toBe("on");
  });
});
