import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// AIO-1208 AC-06: the dashboard conversation handlers are owner-scoped with NO RLS backstop, so
// each method must refuse a caller with no resolved owner BEFORE any store/run operation, and an
// admitted caller must reach the store with exactly the authenticated owner pair. Every request
// here carries a valid UUID and a valid payload, so a parser refusal can never stand in for the
// owner refusal. The owner resolver's own behaviour is proved in test/auth-wrapper-evidence.test.ts.

const h = vi.hoisted(() => ({
  owner: null as { teamId: string; memberId: string } | null,
  resolveChatOwner: vi.fn(),
  getConversation: vi.fn(),
  renameConversation: vi.fn(),
  archiveConversation: vi.fn(),
  latestRun: vi.fn(),
  db: { marker: "admin-client" },
}));

vi.mock("@/lib/chat/session", () => ({ resolveChatOwner: h.resolveChatOwner }));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => h.db }));
vi.mock("@/lib/chat/store", () => ({
  getConversation: h.getConversation,
  renameConversation: h.renameConversation,
  archiveConversation: h.archiveConversation,
}));
vi.mock("@/lib/query/turn-runs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/query/turn-runs")>("@/lib/query/turn-runs");
  return { ...actual, latestRun: h.latestRun };
});

const conversation = await import("@/app/api/dashboard/conversations/[id]/route");
const run = await import("@/app/api/dashboard/conversations/[id]/run/route");

const ID = "11111111-2222-4333-8444-555555555555";
const OWNER = { teamId: "team-1", memberId: "member-1" };
const context = { params: Promise.resolve({ id: ID }) };
const url = (suffix = "") => `http://localhost/api/dashboard/conversations/${ID}${suffix}?team=acme`;

const operations = {
  "GET conversation": () => conversation.GET(new NextRequest(url()), context),
  "PATCH conversation": () =>
    conversation.PATCH(
      new NextRequest(url(), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ team: "acme", title: "Renamed thread" }),
      }),
      context,
    ),
  "DELETE conversation": () => conversation.DELETE(new NextRequest(url(), { method: "DELETE" }), context),
  "GET run": () => run.GET(new NextRequest(url("/run")), context),
} as const;
type Operation = keyof typeof operations;
const names = Object.keys(operations) as Operation[];
const stores = [h.getConversation, h.renameConversation, h.archiveConversation, h.latestRun];

beforeEach(() => {
  h.owner = OWNER;
  h.resolveChatOwner.mockReset().mockImplementation(async () => h.owner);
  h.getConversation.mockReset().mockResolvedValue({ id: ID, title: "Thread", messages: [] });
  h.renameConversation.mockReset().mockResolvedValue(true);
  h.archiveConversation.mockReset().mockResolvedValue(true);
  h.latestRun.mockReset().mockResolvedValue(null);
});

describe("dashboard conversation handlers refuse without a resolved owner", () => {
  it.each(names)("%s → 403 before any store or run operation", async (name) => {
    h.owner = null;
    const response = await operations[name]();
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
    expect(h.resolveChatOwner).toHaveBeenCalledExactlyOnceWith("acme");
    for (const store of stores) expect(store).not.toHaveBeenCalled();
  });
});

describe("dashboard conversation handlers keep the authenticated owner pair", () => {
  it("GET reads the thread as its owner", async () => {
    const response = await operations["GET conversation"]();
    expect(response.status).toBe(200);
    expect(h.getConversation).toHaveBeenCalledExactlyOnceWith(h.db, OWNER, ID);
  });

  it("PATCH renames as its owner", async () => {
    const response = await operations["PATCH conversation"]();
    expect(response.status).toBe(200);
    expect(h.renameConversation).toHaveBeenCalledExactlyOnceWith(h.db, OWNER, ID, "Renamed thread");
  });

  it("DELETE archives as its owner", async () => {
    const response = await operations["DELETE conversation"]();
    expect(response.status).toBe(200);
    expect(h.archiveConversation).toHaveBeenCalledExactlyOnceWith(h.db, OWNER, ID);
  });

  it("GET run reads the latest run as its owner", async () => {
    const response = await operations["GET run"]();
    expect(response.status).toBe(200);
    expect(h.latestRun).toHaveBeenCalledExactlyOnceWith(h.db, OWNER, ID);
  });

  it("each admitted method touches only its own store operation", async () => {
    const expected: Record<Operation, (typeof stores)[number]> = {
      "GET conversation": h.getConversation,
      "PATCH conversation": h.renameConversation,
      "DELETE conversation": h.archiveConversation,
      "GET run": h.latestRun,
    };
    for (const name of names) {
      for (const store of stores) store.mockClear();
      await operations[name]();
      for (const store of stores) expect(store, name).toHaveBeenCalledTimes(store === expected[name] ? 1 : 0);
    }
  });
});
