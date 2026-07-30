import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pins the CALL SITE, not just the helpers.
 *
 * `shouldScheduleMeetingBackfill` and `createMeetingBackfillScheduler` are unit-tested on their own, but
 * deleting the whole `if (shouldScheduleMeetingBackfill(...)) after(...)` block from the push route left
 * every one of those tests green — the wiring was pinned by nothing, and an unwired feature is the exact
 * failure this repo has hit before (a selector with 14 tests whose one call-site argument was removed).
 * So this drives the real route handler and asserts the scheduler is actually reached.
 */

const h = vi.hoisted(() => ({
  schedule: vi.fn(),
  ingestStatus: "created" as "created" | "updated" | "unchanged",
  afterCallbacks: [] as (() => unknown)[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: async () => true }));
vi.mock("@/lib/attribution/resolve-authors", () => ({ attributeIncomingItem: async () => ({ opts: {} }) }));
vi.mock("@/lib/pm-sync", () => ({ projectChangedTasksAfterWrite: async () => {} }));
vi.mock("@/lib/ingest", () => ({
  ingestItem: async () => ({ status: h.ingestStatus, id: "item-1" }),
}));
vi.mock("@/lib/api/auth", () => ({
  authenticateApiKey: async () => ({
    teamId: "team-1",
    memberId: "member-1",
    apiKeyId: "key-1",
    memberTier: "team",
    memberRole: "lead",
  }),
}));
vi.mock("@/lib/meetings/schedule-backfill", async (importOriginal) => ({
  // Keep the REAL predicate — the point is to prove the route applies it, not to restate it here.
  ...(await importOriginal<typeof import("@/lib/meetings/schedule-backfill")>()),
  meetingBackfillScheduler: { schedule: h.schedule, idle: async () => {} },
}));
// `after()` throws outside a request scope; capture the callbacks so the test can drain them.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (cb: () => unknown) => void h.afterCallbacks.push(cb),
}));

const { POST } = await import("@/app/api/v1/items/route");

function push(kind: string, frontmatter: Record<string, unknown>) {
  const body = "# Notes\nwe talked";
  return new Request("https://brain.example.com/api/v1/items", {
    method: "POST",
    headers: { Authorization: "Bearer aios_key1_secret", "Content-Type": "application/json" },
    body: JSON.stringify({
      project: "chetan-workspace",
      path: `2-work/transcripts/2026-07-30-demo.md`,
      content_sha256: createHash("sha256").update(body).digest("hex"),
      access: "team",
      kind,
      frontmatter,
      body,
    }),
  });
}

async function drainAfter() {
  const cbs = [...h.afterCallbacks];
  h.afterCallbacks.length = 0;
  for (const cb of cbs) await cb();
}

describe("POST /api/v1/items — meeting backfill wiring", () => {
  beforeEach(() => {
    h.schedule.mockReset();
    h.afterCallbacks.length = 0;
    h.ingestStatus = "created";
  });

  it("schedules a backfill for the team when a granola transcript is pushed", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(push("transcript", { source: "granola" }) as any);
    expect(res.status).toBe(201);
    await drainAfter();
    expect(h.schedule).toHaveBeenCalledWith("team-1");
  });

  it("does NOT schedule for a Slack thread pushed as a transcript", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(push("transcript", { source: "slack" }) as any);
    await drainAfter();
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it("does NOT schedule when the push was a byte-identical no-op", async () => {
    h.ingestStatus = "unchanged";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(push("transcript", { source: "granola" }) as any);
    await drainAfter();
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it("does NOT schedule for a non-transcript kind, and does not crash on absent frontmatter", async () => {
    // Guards the `frontmatter?.source` access across the discriminated union.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(push("deliverable", {}) as any);
    expect(res.status).toBe(201);
    await drainAfter();
    expect(h.schedule).not.toHaveBeenCalled();
  });
});
