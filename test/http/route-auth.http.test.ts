import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createConversation } from "@/lib/chat/store";
import { BASE_URL, db, seedMemberEmail, seedTeam, type Seed } from "./http-helpers";

// AIO-1208 AC-12: the named dashboard-conversation and governed-action routes, over the wire.
// Anonymous requests carry a valid UUID, a real team slug and a valid payload, so the documented
// refusal is the GUARD's answer — never a parser's. The session-authenticated arms then prove the
// same requests are otherwise servable and stay owner-scoped.

const CONVERSATIONS = `${BASE_URL}/api/dashboard/conversations`;

async function signIn(seed: Seed) {
  const login = await seedMemberEmail(seed);
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: login.email, password: login.password }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("fixture login cookie missing");
  return { cookie, memberId: login.memberId };
}

/** The four named conversation operations against one conversation id. */
const conversationOperations = (teamSlug: string, id: string): Array<[string, string, RequestInit]> => [
  ["GET conversation", `${CONVERSATIONS}/${id}?team=${teamSlug}`, {}],
  [
    "PATCH conversation",
    `${CONVERSATIONS}/${id}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team: teamSlug, title: "Renamed over the wire" }),
    },
  ],
  ["DELETE conversation", `${CONVERSATIONS}/${id}?team=${teamSlug}`, { method: "DELETE" }],
  ["GET run", `${CONVERSATIONS}/${id}/run?team=${teamSlug}`, {}],
];

const withCookie = (init: RequestInit, cookie: string): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string> | undefined), cookie },
});

describe("dashboard conversation routes (HTTP)", () => {
  it("refuse every anonymous request with 403 and leave the conversation untouched", async () => {
    const seed = await seedTeam();
    const created = await createConversation(db(), { teamId: seed.teamId, memberId: seed.memberId }, "Private thread");
    if (!created) throw new Error("fixture conversation missing");

    for (const [name, url, init] of conversationOperations(seed.teamSlug, created.id)) {
      const response = await fetch(url, init);
      expect(response.status, name).toBe(403);
      const body = await response.json();
      expect(body.error.code, name).toBe("forbidden");
      expect(JSON.stringify(body), name).not.toContain("Private thread");
      expect(response.headers.get("set-cookie"), name).toBeNull();
    }
    const list = await fetch(`${CONVERSATIONS}?team=${seed.teamSlug}`);
    expect(list.status).toBe(403);

    const { data } = await db().from("conversations").select("title, archived_at").eq("id", created.id).single();
    expect(data).toEqual({ title: "Private thread", archived_at: null });
  });

  it("refuse a signed-in member of a DIFFERENT team with the same 403", async () => {
    const seed = await seedTeam();
    const created = await createConversation(db(), { teamId: seed.teamId, memberId: seed.memberId }, "Private thread");
    if (!created) throw new Error("fixture conversation missing");
    const outsider = await signIn(await seedTeam());

    for (const [name, url, init] of conversationOperations(seed.teamSlug, created.id)) {
      const response = await fetch(url, withCookie(init, outsider.cookie));
      expect(response.status, name).toBe(403);
    }
    const { data } = await db().from("conversations").select("title, archived_at").eq("id", created.id).single();
    expect(data).toEqual({ title: "Private thread", archived_at: null });
  });

  it("serve the signed-in owner, and give a same-team non-owner no existence oracle", async () => {
    const seed = await seedTeam();
    const owner = await signIn(seed);
    const peer = await signIn(seed);
    const created = await createConversation(db(), { teamId: seed.teamId, memberId: owner.memberId }, "Owner thread");
    if (!created) throw new Error("fixture conversation missing");
    const [read, rename, archive, run] = conversationOperations(seed.teamSlug, created.id);

    // The same-team peer authenticates, but the owner pair scopes it out: not found, nothing changed.
    for (const [name, url, init] of [read, rename, archive]) {
      expect((await fetch(url, withCookie(init, peer.cookie))).status, name).toBe(404);
    }
    const peerRun = await fetch(run[1], withCookie(run[2], peer.cookie));
    expect(peerRun.status).toBe(200);
    expect(await peerRun.json()).toEqual({ run: null });

    const owned = await fetch(read[1], withCookie(read[2], owner.cookie));
    expect(owned.status).toBe(200);
    expect(await owned.json()).toMatchObject({ id: created.id, title: "Owner thread" });
    expect((await fetch(run[1], withCookie(run[2], owner.cookie))).status).toBe(200);
    expect((await fetch(rename[1], withCookie(rename[2], owner.cookie))).status).toBe(200);
    expect((await fetch(archive[1], withCookie(archive[2], owner.cookie))).status).toBe(200);

    const { data } = await db().from("conversations").select("title, archived_at").eq("id", created.id).single();
    expect((data as { title: string }).title).toBe("Renamed over the wire");
    expect((data as { archived_at: string | null }).archived_at).not.toBeNull();
  });
});

describe("governed action routes (HTTP)", () => {
  it("refuse anonymous status and submit with 401 before reading the request", async () => {
    const status = await fetch(`${BASE_URL}/api/v1/actions/${randomUUID()}`);
    expect(status.status).toBe(401);
    expect((await status.json()).error.code).toBe("unauthorized");

    for (const body of ["{malformed", JSON.stringify({ contract_version: "mcp-next/1", type: "task.create" })]) {
      const submit = await fetch(`${BASE_URL}/api/v1/actions/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(submit.status).toBe(401);
      expect(submit.headers.get("cache-control")).toBe("no-store");
      expect((await submit.json()).error.code).toBe("unauthorized");
    }
  });
});
