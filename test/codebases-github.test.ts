import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRepoHeadSha } from "@/lib/codebases/github";

// Unit spec for the W1.3 freshness probe: parse the HEAD SHA from the GitHub commits API,
// validate owner/repo, send auth, and surface non-2xx as an error (the page degrades to
// "unknown"). `fetch` is mocked — no network.

afterEach(() => vi.unstubAllGlobals());

function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(impl as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>);
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("fetchRepoHeadSha", () => {
  it("returns the sha and hits the commits/<ref> endpoint with a bearer token", async () => {
    const spy = mockFetch(() => new Response(JSON.stringify({ sha: "abc123def456" }), { status: 200 }));
    const sha = await fetchRepoHeadSha("acme/widgets", "ghp_TOKEN", "main");
    expect(sha).toBe("abc123def456");

    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/repos/acme/widgets/commits/main");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ghp_TOKEN");
  });

  it("defaults the ref to main and honors a custom branch", async () => {
    const spy = mockFetch(() => new Response(JSON.stringify({ sha: "s" }), { status: 200 }));
    await fetchRepoHeadSha("a/b", "t");
    expect(String(spy.mock.calls[0][0])).toBe("https://api.github.com/repos/a/b/commits/main");
    await fetchRepoHeadSha("a/b", "t", "develop");
    expect(String(spy.mock.calls[1][0])).toBe("https://api.github.com/repos/a/b/commits/develop");
  });

  it("rejects a malformed full_name without calling the network", async () => {
    const spy = mockFetch(() => new Response("{}", { status: 200 }));
    await expect(fetchRepoHeadSha("not-a-repo", "t")).rejects.toThrow(/expected owner\/repo/);
    await expect(fetchRepoHeadSha("too/many/parts", "t")).rejects.toThrow(/expected owner\/repo/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws on a non-2xx response (caller degrades to unknown)", async () => {
    mockFetch(() => new Response("nope", { status: 404 }));
    await expect(fetchRepoHeadSha("acme/missing", "t")).rejects.toThrow(/→ 404/);
  });

  it("throws when the response has no sha", async () => {
    mockFetch(() => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    await expect(fetchRepoHeadSha("acme/widgets", "t")).rejects.toThrow(/no sha/);
  });
});
