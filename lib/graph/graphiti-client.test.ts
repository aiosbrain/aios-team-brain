import { describe, expect, it } from "vitest";
import { GraphitiClient } from "@/lib/graph/graphiti-client";

type Call = { url: string; body: unknown };

function stubFetch(calls: Call[], searchFacts: unknown[] = []) {
  return (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/search")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ facts: searchFacts }) } as Response;
    }
    return { ok: true, status: 202, text: async () => "" } as Response; // /messages
  }) as unknown as typeof fetch;
}

describe("GraphitiClient", () => {
  it("throws when GRAPHITI_URL is unset", async () => {
    const c = new GraphitiClient({ baseUrl: "" });
    expect(c.configured).toBe(false);
    await expect(c.search("q", ["g"])).rejects.toThrow(/not set/);
  });

  it("is NOT configured for a malformed URL — no doomed calls (prod had 'http://')", async () => {
    // The old `base.length > 0` treated "http://" as configured → every query fired a doomed call.
    for (const bad of ["http://", "https://", "not a url", "://x"]) {
      expect(new GraphitiClient({ baseUrl: bad }).configured, bad).toBe(false);
    }
    expect(new GraphitiClient({ baseUrl: "http://gx:8000" }).configured).toBe(true);
    expect(new GraphitiClient({ baseUrl: "http://gx:8000/" }).configured).toBe(true); // trailing slash ok
  });

  it("addEpisodes POSTs mapped episodes to /messages", async () => {
    const calls: Call[] = [];
    const c = new GraphitiClient({ baseUrl: "http://gx:8000", fetchImpl: stubFetch(calls) });
    await c.addEpisodes("acme_team", [
      { content: "hello", timestamp: "2026-06-01T00:00:00Z", sourceDescription: "Slack thread — #eng" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://gx:8000/messages");
    const b = calls[0].body as {
      group_id: string;
      messages: { content: string; source_description: string; role_type: string; role: string | null }[];
    };
    expect(b.group_id).toBe("acme_team");
    expect(b.messages[0].content).toBe("hello");
    expect(b.messages[0].source_description).toBe("Slack thread — #eng");
    expect(b.messages[0].role_type).toBe("user");
    // Regression: Graphiti's Message schema requires `role` present (nullable). Omitting it → 422.
    expect(b.messages[0]).toHaveProperty("role");
    expect(b.messages[0].role).toBeNull();
  });

  it("addEpisodes is a no-op for an empty batch", async () => {
    const calls: Call[] = [];
    const c = new GraphitiClient({ baseUrl: "http://gx:8000", fetchImpl: stubFetch(calls) });
    await c.addEpisodes("acme:team", []);
    expect(calls).toHaveLength(0);
  });

  it("healthcheck GETs /healthcheck and returns true when the service answers", async () => {
    const calls: Call[] = [];
    const okFetch = (async (url: string) => {
      calls.push({ url: String(url), body: undefined });
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as unknown as typeof fetch;
    const c = new GraphitiClient({ baseUrl: "http://gx:8000", fetchImpl: okFetch });
    expect(await c.healthcheck()).toBe(true);
    expect(calls[0].url).toBe("http://gx:8000/healthcheck");
  });

  it("healthcheck returns false on a non-2xx (service up but unhealthy)", async () => {
    const downFetch = (async () => ({ ok: false, status: 503, text: async () => "" }) as Response) as unknown as typeof fetch;
    const c = new GraphitiClient({ baseUrl: "http://gx:8000", fetchImpl: downFetch });
    expect(await c.healthcheck()).toBe(false);
  });

  it("healthcheck returns false (never throws) when the service is unreachable", async () => {
    const throwFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const c = new GraphitiClient({ baseUrl: "http://gx:8000", fetchImpl: throwFetch });
    expect(await c.healthcheck()).toBe(false);
  });

  it("healthcheck returns false without a call when GRAPHITI_URL is unset/malformed", async () => {
    const calls: Call[] = [];
    const c = new GraphitiClient({ baseUrl: "http://", fetchImpl: stubFetch(calls) });
    expect(await c.healthcheck()).toBe(false);
    expect(calls).toHaveLength(0); // no doomed call to a malformed URL
  });

  it("search POSTs group_ids + query and returns facts", async () => {
    const calls: Call[] = [];
    const facts = [{ fact: "Alex owns the payments service", valid_at: "2026-06-01T00:00:00Z" }];
    const c = new GraphitiClient({ baseUrl: "http://gx:8000", fetchImpl: stubFetch(calls, facts) });
    const out = await c.search("who owns payments?", ["acme:external"], 10);
    expect(calls[0].url).toBe("http://gx:8000/search");
    expect((calls[0].body as { group_ids: string[] }).group_ids).toEqual(["acme:external"]);
    expect(out).toEqual(facts);
  });

  it("search short-circuits for no group_ids (no request)", async () => {
    const calls: Call[] = [];
    const c = new GraphitiClient({ baseUrl: "http://gx:8000", fetchImpl: stubFetch(calls) });
    expect(await c.search("q", [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("raises on a non-OK response", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, text: async () => "" }) as Response) as unknown as typeof fetch;
    const c = new GraphitiClient({ baseUrl: "http://gx:8000", fetchImpl });
    await expect(c.search("q", ["g"])).rejects.toThrow(/500/);
  });
});
