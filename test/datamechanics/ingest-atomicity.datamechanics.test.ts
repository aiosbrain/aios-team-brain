import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ingestItem } from "@/lib/ingest";
import type { ItemPayload } from "@/lib/api/schemas";
import type { DbClient } from "@/lib/db/types";
import { db, seedTeam, sha } from "./helpers";

/**
 * Spec for audit finding H4: the item write and the task/decision materialize are not one
 * transaction, so a mid-materialize failure must NOT leave the item marked synced (its new
 * content_sha256 committed) while its rows never materialized — otherwise the retry takes the
 * "unchanged" fast-path and the board stays diverged forever. The fix commits content_sha256 LAST;
 * this proves the observable outcome by injecting a DB failure at the task upsert.
 */

/** Real client, but the tasks upsert throws — simulates a DB failure mid-materialize. */
function failTasksUpsert(real: DbClient): DbClient {
  return {
    from(table: string) {
      const builder = real.from(table);
      if (table !== "tasks") return builder;
      return new Proxy(builder, {
        get(target, prop, recv) {
          if (prop === "upsert") {
            return () => {
              throw new Error("simulated mid-materialize DB failure");
            };
          }
          const v = Reflect.get(target, prop, recv);
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }) as unknown as ReturnType<DbClient["from"]>;
    },
    rpc: real.rpc.bind(real),
  };
}

describe("ingest atomicity under mid-materialize failure (real Postgres)", () => {
  it("does not mark the item synced when materialize fails, so the retry reprocesses the rows", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    const body = "| row_key | title | status |\n|---|---|---|\n| T-1 | Ship it | in_progress |";
    const payload = {
      project: "acme",
      kind: "task",
      path: "board.md",
      actor: "tester",
      frontmatter: {},
      body,
      content_sha256: sha(body),
      rows: [{ row_key: "T-1", title: "Ship it", status: "in_progress" }],
    } as unknown as ItemPayload;

    // 1) Push with the faulty client — materialize throws, so ingestItem must throw.
    await expect(ingestItem(failTasksUpsert(db()), auth, payload, "team")).rejects.toThrow();

    // 2) The item exists but is NOT marked synced (sha withheld), and no task row materialized.
    const { data: item } = await db()
      .from("items")
      .select("id, content_sha256")
      .eq("team_id", seed.teamId)
      .eq("path", "board.md")
      .maybeSingle();
    expect(item).toBeTruthy();
    expect((item as { content_sha256: string }).content_sha256).not.toBe(sha(body));
    const { data: tasksAfterFail } = await db()
      .from("tasks")
      .select("row_key")
      .eq("team_id", seed.teamId)
      .eq("row_key", "T-1");
    expect(tasksAfterFail ?? []).toHaveLength(0);

    // 3) Retry with a healthy client — because the sha was never committed, it reprocesses (not a
    //    no-op "unchanged"), materializes the task, and commits the sha.
    const res = await ingestItem(db(), auth, payload, "team");
    expect(res.status).not.toBe("unchanged");
    const { data: itemOk } = await db()
      .from("items")
      .select("content_sha256")
      .eq("team_id", seed.teamId)
      .eq("path", "board.md")
      .single();
    expect((itemOk as { content_sha256: string }).content_sha256).toBe(sha(body));
    const { data: tasksOk } = await db()
      .from("tasks")
      .select("row_key, title")
      .eq("team_id", seed.teamId)
      .eq("row_key", "T-1");
    expect(tasksOk ?? []).toHaveLength(1);
  });
});
