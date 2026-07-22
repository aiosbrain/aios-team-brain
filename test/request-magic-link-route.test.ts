import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  afterCbs: [] as Array<() => Promise<void> | void>,
  issueMagicToken: vi.fn(),
  sendMagicLink: vi.fn(),
  appBaseUrl: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/auth/pg-login", () => ({ issueMagicToken: h.issueMagicToken }));
vi.mock("@/lib/auth/mailer", () => ({ sendMagicLink: h.sendMagicLink, appBaseUrl: h.appBaseUrl }));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: h.rateLimit }));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({}) }));
vi.mock("next/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, after: (cb: () => Promise<void> | void) => { h.afterCbs.push(cb); } };
});

const { POST } = await import("@/app/api/auth/request-magic-link/route");

function request(email: string, next?: string): NextRequest {
  return new Request("https://brain.example.com/api/auth/request-magic-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next === undefined ? { email } : { email, next }),
  }) as unknown as NextRequest;
}

/** Run every scheduled after() callback (the route defers all lookup/issuance/delivery into these). */
async function drainAfter() {
  for (const cb of h.afterCbs) await cb();
}

beforeEach(() => {
  h.afterCbs = [];
  h.issueMagicToken.mockReset();
  h.sendMagicLink.mockReset();
  h.appBaseUrl.mockReset().mockReturnValue("https://brain.example.com");
  h.rateLimit.mockReset().mockResolvedValue(true);
});

describe("POST /api/auth/request-magic-link", () => {
  it("returns a uniform 200 and defers all work — nothing runs on the response path", async () => {
    const res = await POST(request("anyone@example.com"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(h.afterCbs).toHaveLength(1);
    expect(h.issueMagicToken).not.toHaveBeenCalled();
    expect(h.sendMagicLink).not.toHaveBeenCalled();
  });

  it("unknown email: the after-job looks up the member and stops, sending nothing", async () => {
    h.issueMagicToken.mockResolvedValue(null);

    await POST(request("unknown@example.com"));
    await drainAfter();

    expect(h.issueMagicToken).toHaveBeenCalledExactlyOnceWith("unknown@example.com", "/");
    expect(h.sendMagicLink).not.toHaveBeenCalled();
  });

  it("known email: the after-job issues a token and emails a confirm link built from APP_URL", async () => {
    h.issueMagicToken.mockResolvedValue("raw-token");

    // Email is normalized (trim + lowercase) before lookup and delivery.
    await POST(request("Known@Example.COM", "/dashboard"));
    await drainAfter();

    expect(h.issueMagicToken).toHaveBeenCalledExactlyOnceWith("known@example.com", "/dashboard");
    expect(h.sendMagicLink).toHaveBeenCalledExactlyOnceWith(
      "known@example.com",
      "https://brain.example.com/auth/confirm?token=raw-token"
    );
  });

  it("sanitizes a hostile `next` before it reaches token issuance (backslash open-redirect)", async () => {
    h.issueMagicToken.mockResolvedValue("raw-token");

    await POST(request("known@example.com", "/\\evil.com"));
    await drainAfter();

    // safeNextPath collapses the off-origin target to "/".
    expect(h.issueMagicToken).toHaveBeenCalledExactlyOnceWith("known@example.com", "/");
  });

  it("no trusted APP_URL configured: the after-job no-ops (never issues a token to email nowhere)", async () => {
    h.appBaseUrl.mockReturnValue(null);
    h.issueMagicToken.mockResolvedValue("raw-token");

    await POST(request("known@example.com"));
    await drainAfter();

    expect(h.issueMagicToken).not.toHaveBeenCalled();
    expect(h.sendMagicLink).not.toHaveBeenCalled();
  });

  it("rate-limited requests get 429 and schedule no work", async () => {
    h.rateLimit.mockResolvedValue(false);

    const res = await POST(request("known@example.com"));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: "rate_limited" });
    expect(h.afterCbs).toHaveLength(0);
  });

  it("rejects invalid email syntax before rate-limiting or scheduling work", async () => {
    const res = await POST(request("not-an-email"));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ error: "invalid_email" });
    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.afterCbs).toHaveLength(0);
  });
});
