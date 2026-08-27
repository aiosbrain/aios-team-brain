import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "@/lib/db/types";

// Past the `no-llm` gate on purpose: without this the pass returns `no-llm` (its OWN fail-closed
// answer to an unreadable key store) and never reaches the read whose throw this test is about.
vi.mock("@/lib/query/answering", () => ({
  resolveAnsweringKeys: async () => ({ openaiKey: "sk-test", openaiModel: "gpt-4.1", activeProvider: null }),
}));
vi.mock("@/lib/dashboard/timeline-summary", () => ({ llmConfigured: () => true }));

const { runDocTaskInference } = await import("@/lib/dashboard/doc-task-infer-run");

/**
 * BANNERSTUCK-1 / AC6 — a READ that throws must never become a clearing row.
 *
 * The clearing outcomes are defined as "read the eligible set successfully and found no work". A read
 * that threw satisfies neither half, and mistaking one for the other is the sharpest way this feature
 * could silence a real alarm: the leg would record `ok=true` on exactly the tick its data went
 * unreadable. Unit tier because there is no fault injection against real Postgres, and because the
 * property is orchestration shape — which branch runs — not persistence.
 */

/** A client whose every table read rejects, standing in for a DB-level fault mid-pass. */
function throwingDb(): { db: DbClient; recorded: { ok: boolean; meta: Record<string, unknown> }[] } {
  const recorded: { ok: boolean; meta: Record<string, unknown> }[] = [];
  const reject = () => Promise.reject(new Error("read failed"));
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "not", "gte", "order", "limit", "maybeSingle", "single"]) {
    chain[m] = () => chain;
  }
  (chain as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    reject().then(res, rej);
  const db = {
    from: (table: string) => {
      if (table === "ingest_runs") {
        return {
          ...chain,
          // The pass's own recorder — capture what it writes rather than rejecting, so the assertion
          // is about WHICH row was written, not about the write failing.
          insert: (row: Record<string, unknown>) => {
            recorded.push({ ok: row.ok as boolean, meta: (row.meta ?? {}) as Record<string, unknown> });
            return Promise.resolve({ error: null });
          },
        };
      }
      return chain;
    },
  } as unknown as DbClient;
  return { db, recorded };
}

describe("AC6 — a thrown read never becomes a clearing row", () => {
  it("records a FAILURE, and nothing carrying `health_clear`", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, recorded } = throwingDb();

    const res = await runDocTaskInference(db, "11111111-1111-1111-1111-111111111111");

    // Not a clean idle outcome: the pass could not read, so it must not name one.
    expect(res.skipped).toBeUndefined();
    const cleared = recorded.filter((r) => r.meta.health_clear === true);
    expect(cleared, "a failed read must not be recorded as contrary evidence of health").toEqual([]);
    expect(recorded.some((r) => r.ok === false), "the failure itself must still be recorded").toBe(true);
    err.mockRestore();
  });
});
