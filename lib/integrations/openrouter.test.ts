import { describe, expect, it } from "vitest";
import { validateOpenrouterKey } from "./openrouter";

/**
 * Spec: connecting OpenRouter validates the key against `GET /api/v1/key` BEFORE storing it, so a
 * bad key is rejected immediately (not at first query). Returns the key's label on success. Never
 * throws — network/HTTP errors surface as `{ ok:false, error }`. Injectable fetch for tests.
 */

function fakeFetch(status: number, body?: unknown) {
  return (async () => new Response(body ? JSON.stringify(body) : "", { status })) as typeof fetch;
}

describe("validateOpenrouterKey", () => {
  it("returns the label on a valid key", async () => {
    const res = await validateOpenrouterKey("sk-or-good", fakeFetch(200, { data: { label: "team-key" } }));
    expect(res).toEqual({ ok: true, label: "team-key" });
  });

  it("reports an invalid key (401) without throwing", async () => {
    const res = await validateOpenrouterKey("sk-or-bad", fakeFetch(401, { error: { message: "No auth" } }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid|expired|401|auth/i);
  });

  it("rejects an empty key before hitting the network", async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const res = await validateOpenrouterKey("   ", f);
    expect(res.ok).toBe(false);
    expect(called).toBe(false);
  });
});
