import { describe, expect, it } from "vitest";
import { validateGithubToken, checkRepoAccess } from "./github-validate";

/**
 * Spec: the private-repo connect flow must give immediate, honest feedback. `validateGithubToken`
 * confirms a token works (and whose account it is) before we store it; `checkRepoAccess` reports
 * whether a linked repo is public, private-and-reachable, or unreachable with the current token —
 * so a private repo's syncability is knowable BEFORE a sync runs. Both take an injectable fetch.
 */

/** A fetch stub that maps URL → { status, body }. */
function fakeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  return async (url: string | URL): Promise<Response> => {
    const key = url.toString();
    const r = routes[key];
    if (!r) return new Response("not stubbed", { status: 500 });
    return new Response(r.body ? JSON.stringify(r.body) : "", { status: r.status });
  };
}

const USER = "https://api.github.com/user";
const repoUrl = (r: string) => `https://api.github.com/repos/${r}`;

describe("validateGithubToken", () => {
  it("returns the login on a valid token", async () => {
    const f = fakeFetch({ [USER]: { status: 200, body: { login: "octocat" } } });
    expect(await validateGithubToken("good", f)).toEqual({ ok: true, login: "octocat" });
  });

  it("reports an invalid/expired token (401) without throwing", async () => {
    const f = fakeFetch({ [USER]: { status: 401, body: { message: "Bad credentials" } } });
    const res = await validateGithubToken("bad", f);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid|expired|credential/i);
  });

  it("rejects an empty token before calling the network", async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const res = await validateGithubToken("  ", f);
    expect(res.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe("checkRepoAccess", () => {
  it("classifies a public repo", async () => {
    const f = fakeFetch({ [repoUrl("acme/api")]: { status: 200, body: { private: false } } });
    expect(await checkRepoAccess("acme/api", "t", f)).toEqual({ repo: "acme/api", state: "public" });
  });

  it("classifies a private repo the token can read", async () => {
    const f = fakeFetch({ [repoUrl("acme/secret")]: { status: 200, body: { private: true } } });
    expect(await checkRepoAccess("acme/secret", "t", f)).toEqual({ repo: "acme/secret", state: "private" });
  });

  it("reports no_access on 404 (private-without-access or missing — GitHub hides which)", async () => {
    const f = fakeFetch({ [repoUrl("acme/hidden")]: { status: 404, body: { message: "Not Found" } } });
    expect(await checkRepoAccess("acme/hidden", "t", f)).toEqual({ repo: "acme/hidden", state: "no_access" });
  });
});
