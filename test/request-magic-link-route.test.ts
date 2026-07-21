import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  afterCbs: [] as Array<() => Promise<void> | void>,
  issueMagicToken: vi.fn(),
  sendMagicLink: vi.fn(),
}));

vi.mock("@/lib/auth/pg-login", () => ({ issueMagicToken: h.issueMagicToken }));
vi.mock("@/lib/auth/mailer", () => ({ sendMagicLink: h.sendMagicLink }));
vi.mock("next/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, after: (cb: () => Promise<void> | void) => h.afterCbs.push(cb) };
});

const { POST } = await import("@/app/api/auth/request-magic-link/route");

function request(email: string, next = "/dashboard"): NextRequest {
  return new Request("https://brain.example.com/api/auth/request-magic-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, next }),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  h.afterCbs = [];
  h.issueMagicToken.mockReset();
  h.sendMagicLink.mockReset();
});

describe("POST /api/auth/request-magic-link", () => {
  it("keeps member lookup and delivery off the uniform response path", async () => {
    const unknown = await POST(request("unknown@example.com"));
    const known = await POST(request("Known@Example.COM"));

    expect(unknown.status).toBe(200);
    expect(known.status).toBe(200);
    await expect(unknown.json()).resolves.toEqual({ ok: true });
    await expect(known.json()).resolves.toEqual({ ok: true });
    expect(h.afterCbs).toHaveLength(2);
    expect(h.issueMagicToken).not.toHaveBeenCalled();
    expect(h.sendMagicLink).not.toHaveBeenCalled();

    h.issueMagicToken.mockResolvedValueOnce(null).mockResolvedValueOnce("raw-token");
    for (const cb of h.afterCbs) await cb();

    expect(h.issueMagicToken).toHaveBeenNthCalledWith(1, "unknown@example.com", "/dashboard");
    expect(h.issueMagicToken).toHaveBeenNthCalledWith(2, "known@example.com", "/dashboard");
    expect(h.sendMagicLink).toHaveBeenCalledOnce();
    expect(h.sendMagicLink).toHaveBeenCalledWith(
      "known@example.com",
      "https://brain.example.com/auth/confirm?token=raw-token"
    );
  });

  it("rejects invalid email syntax before scheduling background work", async () => {
    const response = await POST(request("not-an-email"));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "invalid_email" });
    expect(h.afterCbs).toHaveLength(0);
  });
});
