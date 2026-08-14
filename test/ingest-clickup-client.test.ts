import { describe, expect, it } from "vitest";
import {
  ClickUpClient,
  ClickUpClientError,
  type ClickUpTransport,
} from "@/lib/ingest/sources/clickup";
import tasks101Page0 from "@/test/fixtures/clickup/synthetic-tasks-list-101-page-0.json";
import tasks101Page1 from "@/test/fixtures/clickup/synthetic-tasks-list-101-page-1.json";
import tasks202Page0 from "@/test/fixtures/clickup/synthetic-tasks-list-202-page-0.json";
import docsPage0 from "@/test/fixtures/clickup/synthetic-docs-page-0.json";
import docsPage1 from "@/test/fixtures/clickup/synthetic-docs-page-1.json";
import docAlpha from "@/test/fixtures/clickup/synthetic-doc-alpha.json";
import docAlphaPages from "@/test/fixtures/clickup/synthetic-doc-alpha-pages.json";
import recordedProbe from "@/test/fixtures/clickup/recorded-probe.redacted.json";

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("ClickUpClient task reads", () => {
  it("uses every read flag, completes zero-based pagination, and de-duplicates TIML tasks", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const transport: ClickUpTransport = async (input, init) => {
      const url = new URL(input);
      calls.push({ url, init });
      expect(init.method).toBe("GET");
      expect(new Headers(init.headers).get("Authorization")).toBe("test-clickup-token");

      const listId = url.pathname.split("/").at(-2);
      const page = url.searchParams.get("page");
      if (listId === "101" && page === "0") return jsonResponse(tasks101Page0);
      if (listId === "101" && page === "1") return jsonResponse(tasks101Page1);
      if (listId === "202" && page === "0") return jsonResponse(tasks202Page0);
      throw new Error(`unexpected request ${url.pathname}${url.search}`);
    };
    const client = new ClickUpClient({ token: "test-clickup-token", transport, random: () => 0 });

    const records = await client.getTasksForLists(["101", 202]);

    expect(records.map((record) => String(record.task.id))).toEqual(["1001", "1002", "1003", "1004"]);
    expect(records.find((record) => String(record.task.id) === "1003")?.observedListIds).toEqual(["101", "202"]);
    expect(records.find((record) => String(record.task.id) === "1003")?.task.date_updated).toBe("1786000700000");
    expect(calls).toHaveLength(3);
    for (const { url, init } of calls) {
      expect(url.searchParams.get("include_closed")).toBe("true");
      expect(url.searchParams.get("subtasks")).toBe("true");
      expect(url.searchParams.get("include_timl")).toBe("true");
      expect(url.searchParams.get("include_markdown_description")).toBe("true");
      expect(init.body).toBeUndefined();
    }
  });

  it("supports string and integer task ids without using custom ids as identity", async () => {
    const transport: ClickUpTransport = async (input, init) => {
      expect(init.method).toBe("GET");
      const id = new URL(input).pathname.split("/").at(-1)!;
      return jsonResponse({ id: id === "42" ? 42 : id, custom_id: "DISPLAY-ONLY" });
    };
    const client = new ClickUpClient({ token: "test-clickup-token", transport });
    await expect(client.getTask(42)).resolves.toMatchObject({ id: 42 });
    await expect(client.getTask("abc")).resolves.toMatchObject({ id: "abc" });
  });
});

describe("ClickUpClient Docs reads", () => {
  it("follows cursor pagination and requests the full Markdown page tree", async () => {
    const calls: URL[] = [];
    const transport: ClickUpTransport = async (input, init) => {
      expect(init.method).toBe("GET");
      const url = new URL(input);
      calls.push(url);
      if (url.pathname.endsWith("/docs/doc-alpha/pages")) return jsonResponse(docAlphaPages);
      if (url.pathname.endsWith("/docs") && url.searchParams.get("cursor") === "cursor-two") {
        return jsonResponse(docsPage1);
      }
      if (url.pathname.endsWith("/docs")) return jsonResponse(docsPage0);
      throw new Error(`unexpected request ${url.pathname}${url.search}`);
    };
    const client = new ClickUpClient({ token: "test-clickup-token", transport });

    const docs = await client.searchDocs(9001, { type: "LIST", id: "101" });
    const pages = await client.getDocPages("9001", "doc-alpha");

    expect(docs.map((doc) => doc.id)).toEqual(["doc-alpha", "doc-beta"]);
    expect(pages).toHaveLength(2);
    expect(calls[0].searchParams.get("limit")).toBe("100");
    expect(calls[0].searchParams.get("parent_type")).toBe("LIST");
    expect(calls[0].searchParams.get("parent_id")).toBe("101");
    expect(calls[1].searchParams.get("cursor")).toBe("cursor-two");
    expect(calls[2].searchParams.get("max_page_depth")).toBe("-1");
    expect(calls[2].searchParams.get("content_format")).toBe("text/md");
  });

  it("fails closed on a repeated Docs cursor", async () => {
    const transport: ClickUpTransport = async () => jsonResponse({ docs: [], next_cursor: "same" });
    const client = new ClickUpClient({ token: "test-clickup-token", transport, maxPages: 5 });
    await expect(client.searchDocs(9001, undefined)).rejects.toMatchObject({ code: "pagination" });
  });

  it("reads explicit and parent-selected Docs once, filtering only inactive discoveries", async () => {
    const calls: string[] = [];
    const transport: ClickUpTransport = async (input, init) => {
      expect(init.method).toBe("GET");
      const url = new URL(input);
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname.endsWith("/docs/doc-alpha/pages")) return jsonResponse(docAlphaPages);
      if (url.pathname.endsWith("/docs/doc-alpha")) return jsonResponse(docAlpha);
      if (url.pathname.endsWith("/docs") && url.searchParams.has("cursor")) return jsonResponse(docsPage1);
      if (url.pathname.endsWith("/docs")) return jsonResponse(docsPage0);
      throw new Error(`unexpected request ${url.pathname}${url.search}`);
    };
    const client = new ClickUpClient({ token: "test-clickup-token", transport });

    const docs = await client.readDocs(9001, {
      docIds: ["doc-alpha", "doc-alpha"],
      parent: { type: "LIST", id: "101" },
    });

    expect(docs).toHaveLength(1);
    expect(docs[0].doc.id).toBe("doc-alpha");
    expect(calls.filter((call) => call.endsWith("/docs/doc-alpha"))).toHaveLength(1);
    expect(calls.filter((call) => call.includes("/docs/doc-alpha/pages"))).toHaveLength(1);
  });
});

describe("ClickUpClient retry and rate-limit handling", () => {
  it("honors X-RateLimit-Reset on 429 before retrying", async () => {
    let calls = 0;
    let now = 1_000_000;
    const sleeps: number[] = [];
    const transport: ClickUpTransport = async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          { err: "rate limited" },
          429,
          { "X-RateLimit-Limit": "100", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1002" }
        );
      }
      return jsonResponse({ user: { id: 7 } });
    };
    const client = new ClickUpClient({
      token: "test-clickup-token",
      transport,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      random: () => 0,
      baseRetryDelayMs: 10,
    });

    await expect(client.getAuthorizedUser()).resolves.toEqual({ user: { id: 7 } });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it("does not treat a MISSING remaining-quota header as an exhausted quota", async () => {
    // `Number(null)` is 0, so a response carrying a reset epoch but no remaining count once read as
    // "0 requests left" and parked the whole client until that epoch — a self-inflicted stall with no
    // rate limit in force. The second request must go straight out, sleeping for nothing.
    let now = 1_000_000;
    const sleeps: number[] = [];
    const client = new ClickUpClient({
      token: "test-clickup-token",
      // A CDN/proxy response, or an endpoint whose header set differs: reset present, remaining absent.
      transport: async () => jsonResponse({ user: { id: 7 } }, 200, { "X-RateLimit-Reset": "1002" }),
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await client.getAuthorizedUser();
    await client.getAuthorizedUser();
    expect(sleeps).toEqual([]);
  });

  it("still blocks on a genuinely exhausted quota", async () => {
    // The non-vacuous other half: remaining PRESENT and zero must park the client, or the fix above
    // would have bought its calm by disabling the rate-limit gate entirely.
    let now = 1_000_000;
    const sleeps: number[] = [];
    const client = new ClickUpClient({
      token: "test-clickup-token",
      transport: async () =>
        jsonResponse({ user: { id: 7 } }, 200, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1002" }),
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await client.getAuthorizedUser();
    await client.getAuthorizedUser();
    expect(sleeps).toEqual([2000]);
  });

  it("retries transient GET failures with bounded exponential delay", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = new ClickUpClient({
      token: "test-clickup-token",
      transport: async () => {
        calls += 1;
        return calls < 3 ? jsonResponse({ err: "transient" }, 503) : jsonResponse({ user: { id: 7 } });
      },
      maxRetries: 2,
      baseRetryDelayMs: 10,
      maxRetryDelayMs: 25,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      random: () => 0,
    });

    await expect(client.getAuthorizedUser()).resolves.toEqual({ user: { id: 7 } });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });

  it.each([401, 403, 404])("does not retry terminal HTTP %s", async (status) => {
    let calls = 0;
    const token = "must-never-escape";
    const client = new ClickUpClient({
      token,
      transport: async () => {
        calls += 1;
        return jsonResponse({ token, authorization: token }, status);
      },
    });

    const error = await client.getTask("missing").catch((caught) => caught as ClickUpClientError);
    expect(error).toMatchObject({ code: "http", status });
    expect(error.message).not.toContain(token);
    expect(error.message).not.toContain("authorization");
    expect(calls).toBe(1);
  });

  it("bounds concurrent requests per token", async () => {
    let active = 0;
    let maximum = 0;
    const client = new ClickUpClient({
      token: "test-clickup-token",
      maxConcurrency: 2,
      transport: async (input) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return jsonResponse({ id: new URL(input).pathname.split("/").at(-1) });
      },
    });

    await Promise.all([1, 2, 3, 4, 5].map((id) => client.getTask(id)));
    expect(maximum).toBe(2);
  });
});

describe("recorded redacted fixture", () => {
  it("retains probe shape and counts without a secret-like field", async () => {
    const fixtureText = JSON.stringify(recordedProbe);
    expect(fixtureText).not.toMatch(/pk_[A-Za-z0-9_-]+/);
    expect(fixtureText).not.toMatch(/"(?:token|secret|authorization)"\s*:/i);
    expect(recordedProbe.inventory).toEqual({ spaces: 3, lists: 35, docs: 99 });

    const client = new ClickUpClient({
      token: "test-clickup-token",
      transport: async () => jsonResponse(recordedProbe.authorized_workspaces),
    });
    await expect(client.getAuthorizedWorkspaces()).resolves.toMatchObject([
      { id: 9000000001, name: "REDACTED WORKSPACE" },
    ]);
  });
});
