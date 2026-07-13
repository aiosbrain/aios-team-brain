import { describe, expect, it } from "vitest";
import { typefullyProvider } from "@/lib/social/providers/typefully";

/**
 * Spec for the Typefully adapter's request shaping (stubbed fetch — no network). Derived from the
 * provider spike: v2 posts a draft to /social-sets/{id}/drafts with a Bearer key and returns the
 * draft id/preview. (The exact body is marked verify-at-build; this pins our shaping + error path.)
 */
describe("typefullyProvider", () => {
  it("posts a bearer-authed draft to the social set and maps the response", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ id: 123, status: "scheduled", preview: "https://typefully.com/t/abc" }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await typefullyProvider("KEY123", fakeFetch).publish({
      text: "we shipped it",
      platforms: ["x", "linkedin"],
      scheduleAt: null,
      socialSetId: "SET9",
    });

    expect(captured!.url).toContain("/social-sets/SET9/drafts");
    expect((captured!.init.headers as Record<string, string>).Authorization).toBe("Bearer KEY123");
    const body = JSON.parse(captured!.init.body as string);
    expect(body.scratchpad_text).toBe("we shipped it");
    expect(body.publish_at).toBe("now");
    expect(Object.keys(body.platforms).sort()).toEqual(["linkedin", "x"]);
    expect(res.externalId).toBe("123");
    expect(res.url).toBe("https://typefully.com/t/abc");
  });

  it("throws on a non-2xx response", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(
      typefullyProvider("bad", fakeFetch).publish({ text: "x", platforms: ["x"], socialSetId: "S" })
    ).rejects.toThrow(/401/);
  });

  it("refuses to publish without a social set", async () => {
    await expect(
      typefullyProvider("k").publish({ text: "x", platforms: ["x"], socialSetId: "" })
    ).rejects.toThrow(/social-set/);
  });

  it("normalizes X analytics for the matching post", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ posts: [{ draft_id: "D1", impressions: 100, likes: 9, comments: 2, reposts: 3, bookmarks: 4, link_clicks: 5 }] }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const m = await typefullyProvider("KEY", fakeFetch).getAnalytics!({ externalId: "D1", socialSetId: "S" });
    expect(m).toMatchObject({ impressions: 100, likes: 9, comments: 2, shares: 3, saves: 4, clicks: 5 });
  });

  it("returns null when no post matches the external id", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ posts: [{ draft_id: "OTHER" }] }), { status: 200 })) as unknown as typeof fetch;
    expect(await typefullyProvider("KEY", fakeFetch).getAnalytics!({ externalId: "D1", socialSetId: "S" })).toBeNull();
  });
});
