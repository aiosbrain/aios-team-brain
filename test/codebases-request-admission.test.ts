import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { fullMetrics } from "./fixtures/codebase-scan";

/**
 * AUDITFIX-17 / AIO-1136 — AC17-05 (401/403/429 keep their precedence and read no body; an
 * accepted scan keeps its 201 envelope) and the route half of "reject before ingest": the two
 * functions that own every scan-domain write, `ingestCodebaseScan` and `recordIngestRun`, are
 * never ENTERED on a rejection.
 *
 * Spec: docs/design/auditfix17-request-bounds.md. Sibling of test/codebases-rate-limit.test.ts,
 * which owns the Retry-After contract itself and stays green untouched.
 *
 * WHY THIS TIER, AND NOT THE HTTP ONE. Two claims here are unobservable over a socket:
 *   - "429 does not consume the body" — the body is instrumented, so a read is COUNTED. Tripping
 *     the real bucket would need 60 requests a minute against a shared server and still would not
 *     show whether the handler read anything.
 *   - "ingest was never entered" — a spy proves the call did not happen. Real rows prove only that
 *     nothing was written, which is the complementary claim and lives in the HTTP tier
 *     (test/http/codebases-request-bounds.http.test.ts).
 */

const h = vi.hoisted(() => ({
  auth: null as null | {
    teamId: string;
    memberId: string;
    apiKeyId: string;
    memberTier: "team" | "external";
  },
  rateLimitWithReset: vi.fn(),
  ingestCodebaseScan: vi.fn(),
  recordIngestRun: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/lib/api/auth", () => ({ authenticateApiKey: async () => h.auth }));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimitWithReset: h.rateLimitWithReset }));
vi.mock("@/lib/codebases/ingest", () => ({ ingestCodebaseScan: h.ingestCodebaseScan }));
vi.mock("@/lib/ingest/runs", () => ({ recordIngestRun: h.recordIngestRun }));

const { POST } = await import("@/app/api/v1/codebases/route");

// Verbatim from the canonical admission supplement (vendored at
// test/fixtures/contract/codebase-request-limits-v1.json). Spelled out as literals so this file
// states the wire contract; test/guards/codebase-request-limits-contract.test.ts ties the strings
// to the shared artifact.
const BYTES_MESSAGE =
  "body: at most 2400000 bytes per scan; reduce the scan payload and retry; do not split a snapshot across pushes";
const COUNT_MESSAGE =
  "metrics.recent_commits: at most 100 entries per scan; send a complete scan with a smaller recent-commit window; do not split a snapshot across pushes";

const encoder = new TextEncoder();

function commits(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    sha: i.toString(16).padStart(40, "0"),
    author: "Jo <jo@example.com>",
    author_email: "jo@example.com",
    message: `commit ${i}`,
    committed_at: "2026-09-01T10:00:00Z",
    ai: false,
  }));
}

const scanPayload = (recent_commits: unknown[]) => ({
  codebase: { slug: "admission-repo", full_name: "acme/admission-repo", provider: "github" },
  metrics: fullMetrics({ recent_commits }),
});

/**
 * A request whose body READS ARE COUNTED. `chunks` are served in order; after them the stream
 * closes. `declaredLength` sets `Content-Length` without changing what is delivered.
 */
function request(options: {
  chunks?: string[];
  declaredLength?: number;
  headers?: Record<string, string>;
} = {}): { req: NextRequest; probe: { reads: number } } {
  const { chunks = ["{}"], declaredLength, headers = {} } = options;
  const probe = { reads: 0 };
  let next = 0;
  const reader = {
    read(): Promise<{ done: boolean; value?: Uint8Array }> {
      probe.reads++;
      return next < chunks.length
        ? Promise.resolve({ done: false, value: encoder.encode(chunks[next++]) })
        : Promise.resolve({ done: true });
    },
    releaseLock() {},
    cancel: () => Promise.resolve(),
  };

  const headerInit: Record<string, string> = {
    Authorization: "Bearer aios_key-1_secret",
    "Content-Type": "application/json",
    ...headers,
  };
  if (declaredLength !== undefined) headerInit["Content-Length"] = String(declaredLength);

  return {
    req: {
      headers: new Headers(headerInit),
      body: { getReader: () => reader },
    } as unknown as NextRequest,
    probe,
  };
}

const jsonRequest = (payload: unknown) => request({ chunks: [JSON.stringify(payload)] });

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

/** Nothing in the scan domain was entered. */
function expectNoScanWork() {
  expect(h.ingestCodebaseScan).not.toHaveBeenCalled();
  expect(h.recordIngestRun).not.toHaveBeenCalled();
}

beforeEach(() => {
  h.auth = { teamId: "team-1", memberId: "member-1", apiKeyId: "key-1", memberTier: "team" };
  h.rateLimitWithReset.mockReset().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  h.ingestCodebaseScan.mockReset().mockResolvedValue({ contributions: 1, issues: 0 });
  h.recordIngestRun.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/v1/codebases — admission precedence (AC17-05)", () => {
  it("401 outranks an oversized body, and reads none of it", async () => {
    h.auth = null;
    const { req, probe } = request({ chunks: ["x".repeat(3_000_000)] });

    const response = await POST(req);

    expect(response.status).toBe(401);
    expect(probe.reads).toBe(0);
    expect(h.rateLimitWithReset).not.toHaveBeenCalled();
    expectNoScanWork();
  });

  it("403 outranks an oversized body, and reads none of it", async () => {
    h.auth = { ...h.auth!, memberTier: "external" };
    const { req, probe } = request({ chunks: ["x".repeat(3_000_000)] });

    const response = await POST(req);

    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("forbidden_tier");
    expect(probe.reads).toBe(0);
    expect(h.rateLimitWithReset).not.toHaveBeenCalled();
    expectNoScanWork();
  });

  it("429 keeps its Retry-After and consumes no body", async () => {
    // The bound sits AFTER the rate limiter, so an exhausted key is told to come back rather than
    // being handed a size verdict — and the request body is never read to decide that.
    h.rateLimitWithReset.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    const { req, probe } = request({ chunks: ["x".repeat(3_000_000)] });

    const response = await POST(req);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect((await errorOf(response)).code).toBe("rate_limited");
    expect(probe.reads).toBe(0);
    expectNoScanWork();
  });

  it("an oversized body is refused with the named 413, before any scan work", async () => {
    // Three 1,000,000-byte chunks: the third crosses 2,400,000, and the reader stops there.
    const { req, probe } = request({ chunks: Array.from({ length: 3 }, () => "x".repeat(1_000_000)) });

    const response = await POST(req);

    expect(response.status).toBe(413);
    expect(await errorOf(response)).toMatchObject({
      code: "payload_too_large",
      message: BYTES_MESSAGE,
    });
    expect(probe.reads).toBe(3);
    expectNoScanWork();
  });

  it("a Content-Length above the ceiling is refused without reading the body", async () => {
    const { req, probe } = request({ chunks: ['{"a":1}'], declaredLength: 2_400_001 });

    const response = await POST(req);

    expect(response.status).toBe(413);
    expect((await errorOf(response)).message).toBe(BYTES_MESSAGE);
    expect(probe.reads).toBe(0);
    expectNoScanWork();
  });

  it("101 commits are refused with the named 422, before any scan work", async () => {
    const { req } = jsonRequest(scanPayload(commits(101)));

    const response = await POST(req);

    expect(response.status).toBe(422);
    expect(await errorOf(response)).toMatchObject({
      code: "invalid_payload",
      message: COUNT_MESSAGE,
    });
    expectNoScanWork();
  });

  it("a malformed body keeps the existing 422, not a new error class", async () => {
    const { req } = request({ chunks: ['{"codebase":'] });

    const response = await POST(req);

    expect(response.status).toBe(422);
    expect(await errorOf(response)).toMatchObject({
      code: "invalid_payload",
      message: "body must be JSON",
    });
    expectNoScanWork();
  });

  it("an ordinary scan at the ceiling still ingests and returns the 201 envelope", async () => {
    // Non-vacuity for every `expectNoScanWork()` above: the spies DO fire when a request is
    // admitted, so their silence elsewhere means the request was refused, not that the route was
    // never exercised.
    const { req } = jsonRequest(scanPayload(commits(100)));

    const response = await POST(req);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ status: "ok", contributions: 1 });
    expect(h.ingestCodebaseScan).toHaveBeenCalledOnce();
    expect(h.recordIngestRun).toHaveBeenCalledOnce();
    const scan = h.ingestCodebaseScan.mock.calls[0][2] as {
      metrics: { recent_commits: unknown[] };
    };
    expect(scan.metrics.recent_commits).toHaveLength(100);
    expect(h.recordIngestRun.mock.calls[0][1]).toMatchObject({ source: "scan", ok: true });
  });
});
