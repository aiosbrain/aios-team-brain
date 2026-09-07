import { describe, expect, it, vi } from "vitest";
import { PgClient } from "@/lib/db/pg/client";
import type { SqlExecutor } from "@/lib/db/types";

function recordingExecutor() {
  const calls: { text: string; params: unknown[] }[] = [];
  const executor: SqlExecutor = async <T>(text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    if (/count\(\*\)/i.test(text)) {
      return { rows: [{ count: 7 } as T], rowCount: 1 };
    }
    if (/returning/i.test(text)) {
      return { rows: [{ id: "returned" } as T], rowCount: 1 };
    }
    if (/rate_limit_hit/i.test(text)) {
      return { rows: [{ result: 3 } as T], rowCount: 1 };
    }
    return { rows: [{ id: "selected" } as T], rowCount: 1 };
  };
  return { calls, executor };
}

describe("PgClient executor enlistment", () => {
  it("A13-10: select, second count, head, mutation and RETURNING use the injected executor", async () => {
    const trace = recordingExecutor();
    const client = new PgClient({ executor: trace.executor });

    const selected = await client
      .from("items")
      .select("id", { count: "exact" })
      .eq("team_id", "team");
    expect(selected.count).toBe(7);
    expect(trace.calls).toHaveLength(2);

    const headed = await client
      .from("items")
      .select("id", { count: "exact", head: true })
      .eq("team_id", "team");
    expect(headed.count).toBe(7);

    await client.from("items").insert({ id: "i" });
    await client.from("items").upsert({ id: "i" }, { onConflict: "id" });
    const updated = await client
      .from("items")
      .update({ access: "team" })
      .eq("id", "i")
      .select("id")
      .single();
    await client.from("items").delete().eq("id", "i");

    expect(updated.data).toEqual({ id: "returned" });
    expect(trace.calls.some((call) => /^insert into items/i.test(call.text))).toBe(true);
    expect(trace.calls.some((call) => /on conflict \(id\)/i.test(call.text))).toBe(true);
    expect(trace.calls.some((call) => /^update items/i.test(call.text))).toBe(true);
    expect(trace.calls.some((call) => /^delete from items/i.test(call.text))).toBe(true);
  });

  it("A13-10: supported RPC uses the same injected executor", async () => {
    const trace = recordingExecutor();
    const client = new PgClient({ executor: trace.executor });
    const result = await client.rpc("rate_limit_hit", {
      p_bucket: "bucket",
      p_window_start: "2026-01-01T00:00:00Z",
    });
    expect(result).toEqual({ data: 3, error: null });
    expect(trace.calls).toHaveLength(1);
    expect(trace.calls[0].text).toMatch(/rate_limit_hit/);
  });

  it("A13-05/06: a synthetic returned-error envelope is reported to the transaction tracker seam", async () => {
    const trace = recordingExecutor();
    const reportFailure = vi.fn();
    const client = new PgClient({
      executor: trace.executor,
      reportFailure,
      envelopeInterceptor: (_context, result) => ({
        ...result,
        data: null,
        error: { message: "synthetic returned error" },
      }),
    });
    const result = await client.from("items").select("id");
    expect(result.error?.message).toBe("synthetic returned error");
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure.mock.calls[0][0]).toMatchObject({
      message: "synthetic returned error",
    });
  });

  it("A13-FR1 F2: a native cardinality error is reported once before envelope interception", async () => {
    const calls: { text: string; params: unknown[] }[] = [];
    const executor: SqlExecutor = async <T>(text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      return {
        rows: [{ id: "first" } as T, { id: "second" } as T],
        rowCount: 2,
      };
    };
    const reportFailure = vi.fn();
    const interceptEnvelope = vi.fn((_context, result) => result);
    const client = new PgClient({ executor, reportFailure, envelopeInterceptor: interceptEnvelope });

    const result = await client
      .from("projects")
      .insert([
        { team_id: "team", slug: "first" },
        { team_id: "team", slug: "second" },
      ])
      .select("id")
      .single();

    expect(result).toEqual({
      data: null,
      error: { message: "multiple rows returned" },
      count: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/^INSERT INTO projects /);
    expect(interceptEnvelope).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure.mock.calls[0][0]).toMatchObject({ message: "multiple rows returned" });
    expect(reportFailure.mock.calls[0][1]).toBe(calls[0].text);
  });
});
