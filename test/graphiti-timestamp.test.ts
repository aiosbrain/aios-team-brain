import { describe, expect, it, vi } from "vitest";
import { GraphitiClient, toIsoTimestamp } from "@/lib/graph/graphiti-client";

// Spec (projector 422 fix): Graphiti's Pydantic datetime rejects a raw Postgres timestamptz string
// ("2026-07-09 10:39:17.281+00") with "unexpected extra characters" → 422 on every push. The client
// must normalize timestamps to strict ISO-8601 before sending.

describe("toIsoTimestamp", () => {
  it("normalizes a Postgres timestamptz string to ISO-8601", () => {
    expect(toIsoTimestamp("2026-07-09 10:39:17.281+00")).toBe("2026-07-09T10:39:17.281Z");
  });
  it("passes a valid ISO instant through", () => {
    expect(toIsoTimestamp("2026-07-09T10:39:17.281Z")).toBe("2026-07-09T10:39:17.281Z");
  });
  it("falls back to a valid ISO instant for empty/garbage input", () => {
    expect(toIsoTimestamp(undefined)).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(toIsoTimestamp("not a date")).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
});

describe("addEpisodes wire format", () => {
  it("sends a normalized ISO timestamp (never the raw Postgres string that 422s)", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 202 })) as unknown as typeof fetch;
    const client = new GraphitiClient({ baseUrl: "http://graphiti.test", fetchImpl: fetchMock });
    await client.addEpisodes("aios:team", [
      { name: "items:1", content: "x", timestamp: "2026-07-09 10:39:17.281+00", sourceDescription: "s" },
    ]);
    const body = JSON.parse(String((fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1].body));
    expect(body.messages[0].timestamp).toBe("2026-07-09T10:39:17.281Z");
  });
});
