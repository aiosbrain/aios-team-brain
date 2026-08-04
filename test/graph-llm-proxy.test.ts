import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizeGraphProxy,
  resolveGraphProxyTeamId,
  forwardBody,
  forwardUpstream,
  graphChatTarget,
  graphEmbeddingTarget,
  isRefusal,
} from "@/lib/llm/graph-proxy";
import { EMBEDDING_DIM } from "@/lib/api/schemas";
import { classifyGraphCall } from "@/lib/llm/graph-call-kind";

/**
 * The graph LLM proxy exists because a SECOND provider key, on a second service, was invisible to
 * this app — and on 2026-07-28 it quietly ran out of quota and killed graph extraction for hours.
 * These specs pin the decisions that make the console the single source of truth, and the two
 * refusals that stop it doing damage while it's at it.
 */

const SECRET = "s".repeat(40);

describe("authorizeGraphProxy — fails closed", () => {
  it("accepts the exact bearer secret", () => {
    expect(authorizeGraphProxy(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("REFUSES when no secret is configured — an unset secret must never mean 'open'", () => {
    // This endpoint spends money on a paid API. "We forgot to set it" defaulting to open would be
    // strictly worse than the endpoint not working.
    expect(authorizeGraphProxy(`Bearer ${SECRET}`, undefined)).toBe(false);
    expect(authorizeGraphProxy(`Bearer ${SECRET}`, "")).toBe(false);
  });

  it("REFUSES a too-short secret rather than accepting a weak one", () => {
    const weak = "short";
    expect(authorizeGraphProxy(`Bearer ${weak}`, weak)).toBe(false);
  });

  it("refuses a wrong, absent, or malformed credential", () => {
    expect(authorizeGraphProxy(`Bearer ${"x".repeat(40)}`, SECRET)).toBe(false);
    expect(authorizeGraphProxy(null, SECRET)).toBe(false);
    expect(authorizeGraphProxy(SECRET, SECRET)).toBe(false); // no "Bearer " prefix
    expect(authorizeGraphProxy(`Bearer ${SECRET}x`, SECRET)).toBe(false); // length mismatch must not throw
  });
});

/**
 * Metering — the gap this closes. ALL Graphiti extraction + embedding spend was invisible to the
 * `llm_usage` ledger, so the costs page read near-zero while the biggest LLM consumer ran unmetered.
 * `forwardUpstream` now records the upstream `usage` (best-effort) when a meter ctx is passed. These
 * prove a row IS written on success, carries the right source/provider/cost, and that a failed call or
 * a metering error can never break the proxy response.
 */
describe("forwardUpstream — meters graph spend into llm_usage", () => {
  const target = { url: "https://prov/api/v1/chat/completions", headers: {}, model: "qwen/x", provider: "openrouter" };
  // Table-AWARE on purpose. The original fake pushed every insert into one array, so a row written to
  // the failure sidecar was indistinguishable from a spend row — a test asserting "nothing was metered"
  // would have passed while money was recorded, or failed while only a failure was. The two tables mean
  // different things; the double has to know which one it is holding.
  const captureDb = () => {
    const rows: Record<string, unknown>[] = []; // llm_usage — money
    const failures: Record<string, unknown>[] = []; // llm_failures — billed attempts we can't price
    const db = {
      from: (table: string) => ({
        insert: async (r: Record<string, unknown>) => {
          (table === "llm_failures" ? failures : rows).push(r);
          return { error: null };
        },
      }),
    } as never;
    return { db, rows, failures };
  };
  const mockFetch = (status: number, bodyObj: unknown) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(bodyObj), { status, headers: { "content-type": "application/json" } })
    );

  afterEach(() => vi.restoreAllMocks());

  it("records a `graph` row with the provider-reported cost on a successful extraction", async () => {
    mockFetch(200, { choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 900, completion_tokens: 40, cost: 0.0042 } });
    const { db, rows, failures } = captureDb();
    const res = await forwardUpstream(target, { messages: [] }, { meter: { db, teamId: "team-1", source: "graph", kind: "chat", callKind: "extract_nodes" } });
    expect(res.status).toBe(200);
    expect(rows).toHaveLength(1);
    // The split pinned from the other side: a priced call must NOT also be filed as an unpriceable
    // attempt, or the page double-counts it as both a call and a failure.
    expect(failures).toHaveLength(0);
    expect(rows[0]).toMatchObject({
      team_id: "team-1",
      source: "graph",
      provider: "openrouter",
      model: "qwen/x",
      input_tokens: 900,
      output_tokens: 40,
      cost_usd: 0.0042,
      estimated: false,
      member_id: null,
    });
  });

  it("does not meter a failed call that carries NO usage — but no longer loses it in silence", async () => {
    mockFetch(429, { error: { message: "insufficient_quota" } });
    const { db, rows, failures } = captureDb();
    const res = await forwardUpstream(target, { messages: [] }, { meter: { db, teamId: "team-1", source: "graph", kind: "chat", callKind: "extract_nodes" } });
    expect(res.status).toBe(429); // the provider error still passes through untouched
    expect(rows).toHaveLength(0); // nothing priceable arrived, so no dollars are invented
    // …and the attempt is filed instead of vanishing. Silence here is how the Costs page ended up
    // reporting 45% of spend as an anonymous remainder.
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ team_id: "team-1", source: "graph", failure_reason: "http_429" });
  });

  it("files an ABORTED call as `timeout` — our deadline, not the provider's fault", async () => {
    // The 2026-07-29 shape: the model generated, our own ceiling fired, the provider billed, and the
    // ledger recorded nothing. `timeout` vs `network` is the distinction that assigns the blame.
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(abort);
    const { db, rows, failures } = captureDb();
    await expect(
      forwardUpstream(target, { messages: [] }, { meter: { db, teamId: "team-1", source: "graph", kind: "chat", callKind: "extract_nodes" } })
    ).rejects.toThrow();
    expect(rows).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ source: "graph", failure_reason: "timeout", provider: "openrouter" });
  });

  it("DOES meter a non-2xx that still carries `usage` — the provider billed it", async () => {
    // This used to be gated on a 2xx, on the assumption that "only a successful call spent tokens".
    // False: a provider can return usage alongside an error (a post-generation refusal, a partial),
    // and that generation is billed. Measured on prod 2026-07-30 the ledger held $51.46 while
    // OpenRouter's `/credits` reported $96.67 on the same key — spend the meter simply threw away.
    mockFetch(400, {
      error: { message: "content policy" },
      usage: { prompt_tokens: 1200, completion_tokens: 300, cost: 0.0091 },
    });
    const { db, rows } = captureDb();
    const res = await forwardUpstream(target, { messages: [] }, { meter: { db, teamId: "team-1", source: "graph", kind: "chat", callKind: "extract_nodes" } });
    expect(res.status).toBe(400); // the provider error still passes through untouched
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cost_usd: 0.0091, input_tokens: 1200, output_tokens: 300 });
  });

  it("never lets a metering failure break the proxy response", async () => {
    mockFetch(200, { usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.001 } });
    const throwingDb = { from: () => ({ insert: async () => { throw new Error("ledger down"); } }) } as never;
    const res = await forwardUpstream(target, { messages: [] }, { meter: { db: throwingDb, teamId: "t", source: "graph", kind: "chat", callKind: "extract_nodes" } });
    expect(res.status).toBe(200); // the proxy is the thing this module keeps alive — metering is subordinate
  });

  it("does nothing when no meter ctx is passed (metering is opt-in)", async () => {
    mockFetch(200, { usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.001 } });
    const res = await forwardUpstream(target, { messages: [] });
    expect(res.status).toBe(200);
  });
});

describe("graphChatTarget — the console's model wins", () => {
  it("builds an OpenAI-compatible target from an OpenRouter backend, carrying its headers", () => {
    const t = graphChatTarget({
      kind: "openrouter",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-4o",
      apiKey: "or-key",
      headers: { "HTTP-Referer": "https://aios" },
    });
    expect(isRefusal(t)).toBe(false);
    if (isRefusal(t)) return;
    expect(t.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(t.model).toBe("openai/gpt-4o");
    expect(t.headers.Authorization).toBe("Bearer or-key");
    expect(t.headers["HTTP-Referer"]).toBe("https://aios");
  });

  it("tolerates a trailing slash on the base URL", () => {
    const t = graphChatTarget({
      kind: "openai-compatible",
      provider: "local",
      baseUrl: "http://localhost:11434/v1/",
      model: "llama3.1",
      apiKey: null,
    });
    if (isRefusal(t)) throw new Error("expected a target");
    expect(t.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(t.headers.Authorization).toBeUndefined(); // keyless local servers
  });

  it("REFUSES Anthropic instead of half-translating it", () => {
    // Graphiti extracts with an OpenAI structured-output call. Approximating that against a
    // different wire format would degrade extraction silently, which is the failure mode this whole
    // change exists to end — so it refuses with something an operator can act on.
    const t = graphChatTarget({ kind: "anthropic", provider: "anthropic", model: "claude-opus-4-8", apiKey: "k" });
    expect(isRefusal(t)).toBe(true);
    if (!isRefusal(t)) return;
    expect(t.status).toBe(501);
    expect(t.message).toMatch(/Admin → Integrations/);
  });
});

describe("graphEmbeddingTarget — pinned to the graph's vector width", () => {
  const ok = { provider: "openrouter" as const, baseUrl: "https://openrouter.ai/api/v1", model: "openai/text-embedding-3-small", apiKey: "k", dim: EMBEDDING_DIM };

  it("builds a target when the dimension matches", () => {
    const t = graphEmbeddingTarget(ok);
    if (isRefusal(t)) throw new Error("expected a target");
    expect(t.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(t.model).toBe("openai/text-embedding-3-small");
  });

  it("REFUSES a different dimension — swapping it would invalidate every vector in Neo4j", () => {
    // Graphiti built its index at one width and has no migration path. The damage from a mismatch
    // is invisible at write time and shows up later as bad search, so this must fail at the boundary.
    const t = graphEmbeddingTarget({ ...ok, dim: 768 });
    expect(isRefusal(t)).toBe(true);
    if (!isRefusal(t)) return;
    expect(t.status).toBe(501);
    expect(t.message).toContain("768");
  });

  it("refuses when nothing is configured, naming where to fix it", () => {
    const t = graphEmbeddingTarget(null);
    if (!isRefusal(t)) throw new Error("expected a refusal");
    expect(t.status).toBe(503);
    expect(t.message).toMatch(/Admin → Integrations/);
  });
});

describe("forwardBody — one place decides the model", () => {
  it("REPLACES the client's model with the console's", () => {
    // Graphiti sends its own MODEL_NAME. Honouring it would recreate the second source of truth this
    // proxy removes, so it is discarded — deliberately, and documented in the module header.
    const out = forwardBody({ model: "whatever-graphiti-was-told", messages: [] }, "openai/gpt-4o");
    if (isRefusal(out)) throw new Error("expected a body");
    expect(out.model).toBe("openai/gpt-4o");
  });

  it("passes structured-output fields through untouched", () => {
    // `response_format` IS the extraction contract — Graphiti calls `.parse()` with a JSON schema.
    // Dropping or rewriting it would produce unparseable output and an empty graph.
    const schema = { type: "json_schema", json_schema: { name: "entities", schema: { type: "object" } } };
    const out = forwardBody({ messages: [{ role: "user", content: "hi" }], response_format: schema, temperature: 0 }, "m");
    if (isRefusal(out)) throw new Error("expected a body");
    expect(out.response_format).toEqual(schema);
    expect(out.temperature).toBe(0);
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("refuses streaming rather than silently ignoring it", () => {
    // A silently-dropped `stream: true` leaves the caller waiting for chunks that never arrive.
    const out = forwardBody({ stream: true, messages: [] }, "m");
    expect(isRefusal(out)).toBe(true);
  });

  it("asks OpenRouter for usage.cost so `source=graph` meters the REAL charge, not tokens-only", () => {
    // The metering gap's second half: without this the graph meter can fall to a tokens-only $0 on any
    // OpenRouter model that omits cost unless asked — the costs page would keep reading near-zero for
    // the largest consumer. Mirrors lib/llm/complete.ts. Provider-gated.
    const or = forwardBody({ messages: [] }, "m", "openrouter");
    if (isRefusal(or)) throw new Error("expected a body");
    expect(or.usage).toEqual({ include: true });
    const openai = forwardBody({ messages: [] }, "m", "openai");
    if (isRefusal(openai)) throw new Error("expected a body");
    expect(openai.usage).toBeUndefined(); // only OpenRouter needs the flag
  });

  it("does not mutate the caller's body", () => {
    const body = { model: "original", messages: [] };
    forwardBody(body, "replaced");
    expect(body.model).toBe("original");
  });
});

/**
 * Team resolution against a stubbed client.
 *
 * The DEFAULT production shape — one team, `GRAPH_LLM_TEAM` unset — cannot be tested against the
 * data-mechanics database, because that database is shared across suites and can never hold exactly
 * one team. It went untested anywhere: deleting the auto-resolve branch outright left the entire
 * suite green while a dm test's title claimed to cover it. For a money-spending endpoint, the default
 * path is the last thing that should be uncovered.
 */
describe("resolveGraphProxyTeamId — the default production path", () => {
  const stub = (rows: { id: string; slug: string }[]) =>
    ({
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: rows[0] ?? null }) }),
          limit: async (n: number) => ({ data: rows.slice(0, n) }),
        }),
      }),
    }) as unknown as Parameters<typeof resolveGraphProxyTeamId>[0];

  it("auto-resolves when exactly one team exists and no slug is set", async () => {
    const got = await resolveGraphProxyTeamId(stub([{ id: "team-1", slug: "acme" }]), undefined);
    expect(isRefusal(got)).toBe(false);
    if (isRefusal(got)) return;
    expect(got.teamId).toBe("team-1");
  });

  it("REFUSES to guess when several teams exist", async () => {
    const got = await resolveGraphProxyTeamId(
      stub([
        { id: "team-1", slug: "acme" },
        { id: "team-2", slug: "other" },
      ]),
      undefined
    );
    if (!isRefusal(got)) throw new Error("expected a refusal");
    expect(got.code).toBe("graph_proxy_team_ambiguous");
  });

  it("refuses when there is no team at all, rather than resolving to nothing", async () => {
    const got = await resolveGraphProxyTeamId(stub([]), undefined);
    if (!isRefusal(got)) throw new Error("expected a refusal");
    expect(got.code).toBe("graph_proxy_no_team");
  });
});

/**
 * The timeout that silently broke extraction in production.
 *
 * 120s looked generous and was not: Graphiti's extraction prompts carry the episode plus resolution
 * context, and real ones exceeded it — while a hand-built 16KB probe returned in 32s, so nothing
 * local reproduced it. The OpenAI SDK then retried twice, so every job burned ~7-9 minutes and died.
 * The queue drained and NOT ONE fact was created, and the only symptom was an opaque 502 inside
 * another service's traceback.
 *
 * The caller should own the deadline (Graphiti's SDK defaults to 600s non-streaming), so ours must
 * sit generously below that without being the binding constraint on a legitimately slow extraction.
 */
describe("the proxy's upstream timeout", () => {
  it("is well clear of a slow extraction, and below the caller's own deadline", async () => {
    const { PROXY_TIMEOUT_MS_FOR_TEST } = (await import("@/lib/llm/graph-proxy")) as unknown as {
      PROXY_TIMEOUT_MS_FOR_TEST: number;
    };
    // Measured in prod: a 16KB structured-output call returns in ~32s. 120s was still too low for
    // real prompts, so the floor here is deliberately far above the observed happy path.
    expect(PROXY_TIMEOUT_MS_FOR_TEST).toBeGreaterThan(120_000);
    // …and strictly under the OpenAI SDK's 600s default, so the CALLER's deadline is the outer bound
    // and ours only releases a genuinely hung connection.
    expect(PROXY_TIMEOUT_MS_FOR_TEST).toBeLessThan(600_000);
  });
});

/**
 * Reasoning off — the saving that needed no new setting.
 *
 * Extraction is a schema-constrained transformation; chain-of-thought buys nothing and is billed at
 * the OUTPUT rate. `lib/llm/complete.ts` has disabled reasoning on OpenRouter for extraction-type
 * calls all along. This transport copied that function's `usage: {include:true}` line and missed the
 * one next to it, leaving the graph leg — 99% of the brain's LLM spend — as the only OpenRouter path
 * still paying for hidden thinking. Measured live: 473 of 529 completion tokens (89%) were reasoning.
 */
describe("forwardBody — extraction never pays for chain-of-thought", () => {
  it("disables reasoning on OpenRouter", () => {
    const out = forwardBody({ messages: [] }, "qwen/qwen3.7-max", "openrouter");
    if (isRefusal(out)) throw new Error("expected a body");
    expect(out.reasoning).toEqual({ enabled: false });
  });

  it("leaves non-OpenRouter providers untouched — the flag is OpenRouter's", () => {
    const out = forwardBody({ messages: [] }, "gpt-4o", "openai");
    if (isRefusal(out)) throw new Error("expected a body");
    expect(out.reasoning).toBeUndefined();
    expect(out.usage).toBeUndefined();
  });

  it("still asks for the real cost alongside it", () => {
    const out = forwardBody({ messages: [] }, "m", "openrouter");
    if (isRefusal(out)) throw new Error("expected a body");
    expect(out.usage).toEqual({ include: true });
  });
});

/**
 * GRAPHCOST-5 — the WIRING, not the classifier.
 *
 * `lib/llm/graph-call-kind` has its own 28 specs, and they proved nothing about whether a real graph
 * call ever reaches the ledger labelled. Verified by mutation: replacing the route's
 * `classifyGraphCall(body)` with the constant `"unknown"`, and deleting `callKind` from
 * `meterGraphCall`'s insert, each left 249 tests green. These are the assertions that redden.
 *
 * The composition below is exactly the route's (`app/api/internal/llm/v1/chat/completions/route.ts`):
 * classify the REQUEST body, forward the body `forwardBody` produced, meter the response.
 */
describe("graph call-kind reaches the ledger (the route's composition, end to end)", () => {
  const target = { url: "https://prov/api/v1/chat/completions", headers: {}, model: "qwen/x", provider: "openrouter" };
  // node_operations.py:115 — extract_nodes.extract_message, verbatim from the deployed image.
  const REAL_BODY = {
    model: "ignored-by-the-proxy",
    messages: [
      {
        role: "system",
        content:
          "You are an AI assistant that extracts entity nodes from conversational messages. \n    Your primary task is to extract and classify the speaker and other significant entities mentioned in the conversation.",
      },
      { role: "user", content: "<PREVIOUS MESSAGES>…" },
    ],
  };

  const captureDb = () => {
    const rows: Record<string, unknown>[] = [];
    const db = {
      from: () => ({
        insert: async (r: Record<string, unknown>) => {
          rows.push(r);
          return { error: null };
        },
      }),
    } as never;
    return { db, rows };
  };

  afterEach(() => vi.restoreAllMocks());

  it("labels a real extract_nodes call all the way into the llm_usage row", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ usage: { prompt_tokens: 4000, completion_tokens: 300, cost: 0.01 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const { db, rows } = captureDb();
    const forwarded = forwardBody(REAL_BODY, "qwen/x", "openrouter");
    if (isRefusal(forwarded)) throw new Error("expected a body");

    await forwardUpstream(target, forwarded, {
      meter: { db, teamId: "team-1", source: "graph", kind: "chat", callKind: classifyGraphCall(REAL_BODY) },
    });

    expect(rows).toHaveLength(1);
    // The whole point: not `''` (which would read as pre-instrumentation history) and not `unknown`.
    expect(rows[0].call_kind).toBe("extract_nodes");
    expect(rows[0].source).toBe("graph"); // AC4: the existing dimension is untouched
  });

  it("classifies the body the PROVIDER receives, not a different one", async () => {
    // `forwardBody` rewrites `model` and adds `usage`/`reasoning`. If it ever touched `messages`, the
    // label would describe a request that was never sent.
    const forwarded = forwardBody(REAL_BODY, "qwen/x", "openrouter");
    if (isRefusal(forwarded)) throw new Error("expected a body");
    expect(classifyGraphCall(forwarded)).toBe(classifyGraphCall(REAL_BODY));
    expect(forwarded.messages).toEqual(REAL_BODY.messages);
  });

  it("an unrecognised prompt reaches the ledger as `unknown`, never as ''", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.001 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const { db, rows } = captureDb();
    const body = { messages: [{ role: "system", content: "You are a brand new prompt from a graph upgrade." }] };
    await forwardUpstream(target, body, {
      meter: { db, teamId: "team-1", source: "graph", kind: "chat", callKind: classifyGraphCall(body) },
    });
    expect(rows[0].call_kind).toBe("unknown"); // the drift alarm, distinct from '' history
  });
});
