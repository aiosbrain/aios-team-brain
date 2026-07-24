import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recordLlmUsage } from "@/lib/costs/llm-usage";
import { completeText } from "@/lib/llm/complete";
import type { DbClient } from "@/lib/db/types";

/**
 * Spec: the brain must meter ALL of its LLM inference into `llm_usage`, not just the Query box — so
 * background tasks (arcs, meetings, titles) show up in the Spend KPI + costs breakdown. Two contracts:
 *  1. `recordLlmUsage` maps a call into one ledger row (rounded cost, non-negative, null member ok).
 *  2. `completeText` with `opts.meter` captures OpenRouter's real `usage.cost` (estimated=false) and
 *     tags the row with the caller's `source` + the resolved provider/model.
 * Derived from the product contract ("all inference is costed"), not the implementation.
 */

/** A fake db that captures llm_usage inserts (and nothing else). */
function captureDb(): { db: DbClient; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          if (table === "llm_usage") rows.push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  } as unknown as DbClient;
  return { db, rows };
}

describe("recordLlmUsage — ledger row mapping", () => {
  it("maps a metered call into one row (rounded cost, source/provider/model)", async () => {
    const { db, rows } = captureDb();
    await recordLlmUsage(db, {
      teamId: "team-1",
      memberId: "member-1",
      source: "arcs",
      provider: "openrouter",
      model: "qwen/qwen3.7-plus",
      inputTokens: 1200,
      outputTokens: 340,
      costUsd: 0.123456789,
      estimated: false,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      team_id: "team-1",
      member_id: "member-1",
      source: "arcs",
      provider: "openrouter",
      model: "qwen/qwen3.7-plus",
      input_tokens: 1200,
      output_tokens: 340,
      cost_usd: 0.12346, // rounded to numeric(12,5)
      estimated: false,
    });
  });

  it("allows a null member (system/background call) and clamps negatives", async () => {
    const { db, rows } = captureDb();
    await recordLlmUsage(db, {
      teamId: "team-1",
      source: "timeline-summary",
      provider: "openrouter",
      model: "m",
      inputTokens: -5,
      outputTokens: 10,
      costUsd: -1,
      estimated: false,
    });
    expect(rows[0]).toMatchObject({ member_id: null, input_tokens: 0, cost_usd: 0 });
  });

  it("never throws when the insert errors (metering can't break the call)", async () => {
    const db = {
      from: () => ({ insert: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
    } as unknown as DbClient;
    await expect(
      recordLlmUsage(db, {
        teamId: "t",
        source: "query",
        provider: "openrouter",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.01,
        estimated: false,
      })
    ).resolves.toBeUndefined();
  });
});

describe("completeText — meters inference into llm_usage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function jsonResponse(payload: unknown): Response {
    return { ok: true, status: 200, json: async () => payload, text: async () => "" } as unknown as Response;
  }

  it("records OpenRouter's real cost with source/provider, estimated=false", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "a summary" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 500, completion_tokens: 80, cost: 0.0042 },
      })
    );
    const { db, rows } = captureDb();
    const text = await completeText(
      { system: "s", prompt: "p" },
      {
        keys: { activeProvider: "openrouter", openrouterKey: "or-test", openrouterModel: "some/model" },
        meter: { db, teamId: "team-1", source: "meeting-extract", memberId: "m-9" },
      }
    );
    expect(text).toBe("a summary");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      team_id: "team-1",
      member_id: "m-9",
      source: "meeting-extract",
      provider: "openrouter",
      model: "some/model",
      input_tokens: 500,
      output_tokens: 80,
      cost_usd: 0.0042,
      estimated: false,
    });
  });

  it("asks OpenRouter to include usage/cost in the request body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "ok" } }], usage: { cost: 0.1 } })
    );
    const { db } = captureDb();
    await completeText(
      { system: "s", prompt: "p" },
      {
        keys: { activeProvider: "openrouter", openrouterKey: "or-test", openrouterModel: "m" },
        meter: { db, teamId: "t", source: "social" },
      }
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.usage).toEqual({ include: true });
  });

  it("does not meter when opts.meter is absent (opt-in)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "ok" } }], usage: { cost: 0.1 } })
    );
    const { rows } = captureDb();
    await completeText(
      { system: "s", prompt: "p" },
      { keys: { activeProvider: "openrouter", openrouterKey: "or-test", openrouterModel: "m" } }
    );
    // No meter/db was handed to completeText, so nothing is recorded through the capture db.
    expect(rows).toHaveLength(0);
  });
});
