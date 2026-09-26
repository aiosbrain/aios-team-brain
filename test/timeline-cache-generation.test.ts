import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { TransactionCapableDbClient, TransactionSession } from "@/lib/db/types";
import { writeTimelineCache } from "@/lib/dashboard/timeline-cache";

const TEAM = "00000000-0000-4000-8000-000000000001";
const before = { dataGeneration: "3", identityGeneration: "5", presentationGeneration: "7" };
const vis = { visibleProjectIds: new Set<string>(), visibilityHash: "generation-test" };
const emptyItems = createHash("sha256").update("[]").digest("hex");

function fake(current: typeof before) {
  const statements: string[] = [];
  const calls: { sql: string; params?: unknown[] }[] = [];
  const session = {
    db: {} as TransactionCapableDbClient,
    executeSql: async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      calls.push({ sql, params });
      if (sql.includes("for share")) return { rows: [{
        data_generation: current.dataGeneration, identity_generation: current.identityGeneration,
        presentation_generation: current.presentationGeneration,
      }], rowCount: 1 };
      if (sql.includes("returning computed_at")) return {
        rows: [{ computed_at: "2026-09-19T00:00:00.000Z" }], rowCount: 1,
      };
      return { rows: [], rowCount: 0 };
    },
    optionalAudit: async <T>(operation: () => Promise<T>) => operation(),
  } as TransactionSession;
  const client = {
    from: () => { throw new Error("unexpected query-builder call"); },
    rpc: async () => { throw new Error("unexpected rpc call"); },
    transaction: async <T>(fn: (s: TransactionSession) => Promise<T>) => fn(session),
  } as TransactionCapableDbClient;
  return { client, statements, calls };
}

describe("timeline cache publication generation fence", () => {
  it("refuses an overtaken build without updating the persisted row", async () => {
    for (const field of ["dataGeneration", "identityGeneration", "presentationGeneration"] as const) {
      const state = fake({ ...before, [field]: "8" });
      expect(await writeTimelineCache(state.client, TEAM, "team", [], false, vis, before)).toBeNull();
      expect(state.statements.some((sql) => sql.includes("work_timeline_cache"))).toBe(false);
    }
  });

  it("publishes the exact three-stamp payload under the row lock", async () => {
    const state = fake(before);
    const at = await writeTimelineCache(state.client, TEAM, "team", [], true, vis, before);
    expect(at).toBe(Date.parse("2026-09-19T00:00:00.000Z"));
    expect(state.statements.findIndex((sql) => sql.includes("for share")))
      .toBeLessThan(state.statements.findIndex((sql) => sql.includes("work_timeline_cache")));
    const payload = JSON.parse(state.calls.find((c) => c.sql.includes("work_timeline_cache"))!.params![2] as string);
    expect(payload.generations).toEqual(before);
    expect(payload.itemFingerprint).toBe(emptyItems);
  });

  it("refuses publication when live item visibility changed with every Slack revision unchanged", async () => {
    const state = fake(before);
    expect(await writeTimelineCache(state.client, TEAM, "team", [], false, vis, before,
      "0".repeat(64))).toBeNull();
    expect(state.statements.some((sql) => sql.includes("work_timeline_cache"))).toBe(false);
  });

  it("propagates an access read error during publication before any cache write", async () => {
    const state = fake(before);
    await expect(writeTimelineCache(state.client, TEAM, "team", [], false,
      { ...vis, visibleProjectIds: new Set(["project-1"]) }, before, emptyItems)).rejects.toThrow();
    expect(state.statements.some((sql) => sql.includes("work_timeline_cache"))).toBe(false);
  });
});
