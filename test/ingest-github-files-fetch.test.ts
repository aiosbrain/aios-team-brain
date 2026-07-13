import { describe, it, expect } from "vitest";
import { fetchGithubRepoFiles } from "@/lib/ingest/sources/github-files";

/**
 * Spec: the file fetcher attaches each file's LAST-COMMIT author (login + git email + name) so the
 * runner can attribute the deliverable to a real person — a repo file has no inherent author, so we
 * take the most recent commit touching its path. A commits-lookup failure leaves the file
 * unattributed (undefined author), never mis-attributed.
 */

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

/** Minimal GitHub API mock: default branch, one-file tree, file contents, per-path last commit. */
function mockFetch(commitOk = true): typeof fetch {
  return (async (url: string | URL) => {
    const u = url.toString();
    if (u.endsWith("/repos/acme/App")) return json({ default_branch: "main" });
    if (u.includes("/git/trees/")) return json({ tree: [{ type: "blob", path: "docs/x.md" }] });
    if (u.includes("/contents/")) return json({ encoding: "base64", content: b64("hello"), html_url: "h" });
    if (u.includes("/commits?path=")) {
      return commitOk
        ? json([{ author: { login: "chetan-gh" }, commit: { author: { email: "c@acme.dev", name: "Chetan" } } }])
        : new Response("nope", { status: 500 });
    }
    return new Response("unmatched", { status: 404 });
  }) as typeof fetch;
}
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("fetchGithubRepoFiles — author attribution", () => {
  it("attaches the file's last-commit author", async () => {
    const out = await fetchGithubRepoFiles({ owner: "acme", repo: "App", fetchImpl: mockFetch() });
    expect(out.files).toHaveLength(1);
    expect(out.files[0]).toMatchObject({
      path: "docs/x.md",
      authorLogin: "chetan-gh",
      authorEmail: "c@acme.dev",
      authorName: "Chetan",
    });
  });

  it("leaves the author undefined when the commits lookup fails (file still imported)", async () => {
    const out = await fetchGithubRepoFiles({ owner: "acme", repo: "App", fetchImpl: mockFetch(false) });
    expect(out.files).toHaveLength(1);
    expect(out.files[0].authorEmail).toBeUndefined();
    expect(out.files[0].body).toBe("hello"); // still ingested, just unattributed
  });
});
