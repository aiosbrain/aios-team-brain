import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  auth: null as null | {
    teamId: string;
    memberId: string;
    apiKeyId: string;
    memberTier: "team" | "external";
  },
  rateLimitWithReset: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/lib/api/auth", () => ({ authenticateApiKey: async () => h.auth }));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimitWithReset: h.rateLimitWithReset }));
vi.mock("@/lib/codebases/ingest", () => ({ ingestCodebaseScan: vi.fn() }));
vi.mock("@/lib/ingest/runs", () => ({ recordIngestRun: vi.fn() }));

const { POST } = await import("@/app/api/v1/codebases/route");

function request(): NextRequest {
  return new Request("https://brain.example.com/api/v1/codebases", {
    method: "POST",
    headers: {
      Authorization: "Bearer aios_key-1_secret",
      "Content-Type": "application/json",
    },
    body: "{}",
  }) as unknown as NextRequest;
}

beforeEach(() => {
  h.auth = {
    teamId: "team-1",
    memberId: "member-1",
    apiKeyId: "key-1",
    memberTier: "team",
  };
  h.rateLimitWithReset.mockReset().mockResolvedValue({
    allowed: false,
    retryAfterSeconds: 60,
  });
});

describe("POST /api/v1/codebases rate-limit response", () => {
  it.each([60, 1])("returns a decimal-integer Retry-After boundary of %i", async (seconds) => {
    h.rateLimitWithReset.mockResolvedValue({ allowed: false, retryAfterSeconds: seconds });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(String(seconds));
    expect(response.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "rate_limited" } });
    expect(h.rateLimitWithReset).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "key-1:codebases:post",
      60,
    );
  });

  it("does not rate-limit or disclose reset guidance before authentication", async () => {
    h.auth = null;

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(response.headers.has("Retry-After")).toBe(false);
    expect(h.rateLimitWithReset).not.toHaveBeenCalled();
  });

  it("preserves the team-tier wall before rate limiting", async () => {
    h.auth = { ...h.auth!, memberTier: "external" };

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(response.headers.has("Retry-After")).toBe(false);
    expect(h.rateLimitWithReset).not.toHaveBeenCalled();
  });
});
