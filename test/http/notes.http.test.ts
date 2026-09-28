import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha } from "../datamechanics/helpers";
import { BASE_URL, seedMemberEmail } from "./http-helpers";
import { noteCounts, noteFixture, noteMember, noteRequest, noteSql } from "../datamechanics/note-fixture";

const endpoint = `${BASE_URL}/api/v1/actions/submit`;
const post = (headers: Record<string, string>, body: unknown, url = endpoint) =>
  fetch(url, { method: "POST", headers, body: JSON.stringify(body) });

async function success(headers: Record<string, string>, request: unknown) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await post(headers, request);
    const body = await response.json();
    if (response.status === 503 && body.error?.code === "unavailable" || ["requested", "running"].includes(body.status)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    expect(response.status).toBe(200);
    expect(body.status).toBe("succeeded");
    return body;
  }
  throw new Error("note did not complete within bounded retries");
}

// This file belongs to the enabled-governed HTTP invocation. Missing production
// registration is a failure, never replaced by an injected consumer or fixture route.
describe.runIf(process.env.AIOS_GOVERNED_ACTIONS_ENABLED === "true")("governed notes production HTTP", () => {
  it("advertises note.append and returns exact accepted content through the normal item read", async () => {
    const f = await noteFixture();
    const me = await fetch(`${BASE_URL}/api/v1/me`, { headers: f.headers });
    expect((await me.json()).capabilities.actions).toContain("note.append");
    const request = noteRequest(f.projectId, "  Literal <script> title 🧠  ", " \r\nExact e\u0301 body\r\n");
    const result = await success(f.headers, request);
    expect(result.entity).toEqual({ kind: "note", id: expect.any(String), revision: expect.any(String) });
    expect(result.sync).toEqual({ state: "not_applicable", providers: [] });
    const read = await fetch(`${BASE_URL}/api/v1/items/${result.entity.id}`, { headers: f.headers });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id: result.entity.id, kind: "note", access: "team", body: request.params.body, frontmatter: { title: request.params.title } });
    const status = await fetch(`${BASE_URL}/api/v1/actions/${result.action_id}`, { headers: f.headers });
    expect(await status.json()).toEqual(result);
  });

  it("rejects extra authority fields, over-limit codepoints, NUL and invalid Unicode before acceptance", async () => {
    const f = await noteFixture();
    for (const request of [
      { ...f.request, actor: "forged" },
      { ...f.request, params: { ...f.request.params, access: "external" } },
      noteRequest(f.projectId, "🧠".repeat(201)),
      noteRequest(f.projectId, "Title", "🧠".repeat(25001)),
      noteRequest(f.projectId, "bad\0title"),
      noteRequest(f.projectId, "Title", "bad\ud800body"),
    ]) {
      const response = await post(f.headers, request);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_payload" } });
    }
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 0, identities: 0 });
    await success(f.headers, noteRequest(f.projectId, "🧠".repeat(200), "🧠".repeat(25000)));
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 1, versions: 1 });
  });

  it("concurrent retries converge to one accepted note and persisted revision", async () => {
    const f = await noteFixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => success(f.headers, f.request)));
    for (const result of results) expect(result).toEqual(results[0]);
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 1, versions: 1, origins: 1, identities: 1, succeeded: 1 });
  });

  it("recovers after the committed HTTP response is lost, without a second note", async () => {
    const f = await noteFixture();
    let committed: unknown;
    let proxyError: unknown;
    const proxy = createServer(async (incoming, outgoing) => {
      try {
        const parts: Buffer[] = [];
        for await (const part of incoming) parts.push(Buffer.from(part));
        const response = await fetch(endpoint, { method: "POST", headers: f.headers, body: Buffer.concat(parts) });
        committed = await response.json();
      } catch (error) { proxyError = error; }
      finally { outgoing.destroy(); }
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const address = proxy.address();
      if (!address || typeof address === "string") throw new Error("proxy failed to listen");
      await expect(post(f.headers, f.request, `http://127.0.0.1:${address.port}`)).rejects.toThrow();
      expect(proxyError).toBeUndefined();
      expect(committed).toMatchObject({ status: "succeeded" });
      expect(await success(f.headers, f.request)).toEqual(committed);
      expect(await noteCounts(f.teamId)).toMatchObject({ notes: 1, versions: 1, origins: 1, succeeded: 1 });
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects external/delegated callers and missing destinations without a note", async () => {
    const f = await noteFixture();
    const external = await noteMember(f, "member", "external");
    await noteSql("insert into group_members(team_id,group_id,member_id) values($1,$2,$3)", [f.teamId, f.groupId, external.id]);
    expect((await post(external.headers, f.request)).status).toBe(403);
    expect((await post({ ...f.headers, Authorization: `Bearer aiosd_${randomUUID()}_synthetic` }, f.request)).status).toBe(401);
    expect((await post(f.headers, noteRequest(randomUUID()))).status).toBe(404);
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 0 });
  });

  it("rechecks destination access for replay, status and reads after revocation", async () => {
    const f = await noteFixture();
    const result = await success(f.headers, f.request);
    await noteSql("delete from project_groups where project_id=$1", [f.projectId]);
    expect((await post(f.headers, f.request)).status).toBe(404);
    expect((await fetch(`${BASE_URL}/api/v1/actions/${result.action_id}`, { headers: f.headers })).status).toBe(404);
    expect((await fetch(`${BASE_URL}/api/v1/items/${result.entity.id}`, { headers: f.headers })).status).toBe(404);
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 1, versions: 1 });
  });

  it("rejects legacy note edits, reclassification and fresh reserved-path squatting", async () => {
    const f = await noteFixture();
    const result = await success(f.headers, f.request);
    const read = await fetch(`${BASE_URL}/api/v1/items/${result.entity.id}`, { headers: f.headers });
    const { project, path, kind, access, frontmatter, body, content_sha256, actor } = await read.json();
    const echo = { project, path, kind, access, frontmatter, body, content_sha256, actor };
    const unchanged = await post(f.headers, echo, `${BASE_URL}/api/v1/items`);
    expect(unchanged.status).toBe(200);
    expect(await unchanged.json()).toMatchObject({ status: "unchanged", id: result.entity.id });
    for (const edit of [
      { ...echo, frontmatter: { ...frontmatter, title: "Replacement" } },
      { ...echo, body: "Replacement", content_sha256: sha("Replacement") },
      { ...echo, kind: "artifact" },
      { ...echo, access: "external" },
      { ...echo, path: `1-inbox/governed/note/${randomUUID()}.md` },
    ]) {
      const response = await post(f.headers, edit, `${BASE_URL}/api/v1/items`);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "immutable_origin" } });
    }
    const retained = await fetch(`${BASE_URL}/api/v1/items/${result.entity.id}`, { headers: f.headers });
    expect(await retained.json()).toMatchObject(echo);
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 1, versions: 1, origins: 1 });
  });

  it("renders the escaped title to an authorized dashboard member and hides it from a General-only member", async () => {
    const f = await noteFixture();
    const title = "Private note <script>alert(1)</script>";
    const result = await success(f.headers, noteRequest(f.projectId, title));
    const allowed = await seedMemberEmail(f);
    const denied = await seedMemberEmail(f);
    await noteSql("insert into group_members(team_id,group_id,member_id) values($1,$2,$3)", [f.teamId, f.groupId, allowed.memberId]);
    for (const user of [allowed, denied]) {
      const login = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user.email, password: user.password }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")?.split(";")[0];
      if (!cookie) throw new Error("login cookie missing");
      const page = await fetch(`${BASE_URL}/t/${f.teamSlug}/library/${result.entity.id}`, { headers: { cookie } });
      const html = await page.text();
      if (user === allowed) {
        expect(page.status).toBe(200);
        expect(html).toContain("Private note &lt;script&gt;alert(1)&lt;/script&gt;");
        expect(html).not.toContain("<script>alert(1)</script>");
      } else expect(html).not.toContain("Private note");
    }
  });
});
