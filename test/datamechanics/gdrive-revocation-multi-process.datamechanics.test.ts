import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

import { ensureProjectGraphPointer } from "@/lib/graph/project-pointer";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { stageGdriveReconciliation } from "@/lib/ingest/source-reconcile";
import { upsertIntegration } from "@/lib/integrations/manage";
import { recordGdriveItemClaim } from "@/lib/projects/context/gdrive-claims";
import { db, driveFixture, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1167 R44 T1 — Drive revocation reaches ANOTHER application process's memory.
 *
 * Spec (accepted spec: real multi-process memory/persistent reads). Process B is a separate Node
 * process serving the Timeline through the real cache (its own process memory + the shared persisted
 * variants). After B has served a Drive document to two audience variants — reader A through
 * connection A's project, reader B through connection B's — process A (this worker) revokes
 * connection A's claim through the production reconciliation writer. Then:
 *   · B refuses the old text to reader A — from memory and from its persisted row alike. Before the
 *     revocation each path is proven to have SERVED it (R45 L8): a warm memory hit in B, and a
 *     persisted-row hit in a third process C that never had it in memory;
 *   · B still serves reader B, whose own claim stands;
 *   · a cold rebuild B started BEFORE the revocation and published AFTER it is refused, and what B
 *     serves and persists afterwards carries no old text.
 */

const TITLE = `Multi-process revocation ${randomUUID().slice(0, 8)}`;
const CHILD = resolve(__dirname, "processes/timeline-reader.ts");

const ROOT = resolve(__dirname, "../..");

class Reader {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly queue: Array<{ resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }> = [];
  private readonly pending: Record<string, unknown>[] = [];
  private stderr = "";
  private failure: Error | null = null;

  constructor() {
    // A real, separate Node process. `tsx` compiles the TypeScript and maps `@/` through the repo's
    // tsconfig (named explicitly, from the repo root, whatever the worker's cwd); `react-server`
    // resolves `server-only` to its empty module, as inside the Next server. The parent's env
    // (DATABASE_URL and the tier's other pins) is inherited.
    this.child = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", CHILD], {
      cwd: ROOT,
      env: { ...process.env, TSX_TSCONFIG_PATH: resolve(ROOT, "tsconfig.json") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Always drain stderr: an unread pipe fills and blocks the child mid-startup, which looks like a
    // hang. Keep the tail for the failure message.
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8_000); });
    this.child.on("error", (error) => this.fail(new Error(`reader process failed to start: ${error.message}`)));
    // `close`, not `exit`: it fires once stdio has closed, so the stderr tail is complete.
    this.child.on("close", (code, signal) => this.fail(new Error(
      `reader process exited (code ${code}, signal ${signal}); stderr:\n${this.stderr}`,
    )));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let value: Record<string, unknown>;
      try { value = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      const waiter = this.queue.shift();
      if (waiter) waiter.resolve(value); else this.pending.push(value);
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    while (this.queue.length) this.queue.shift()!.reject(this.failure);
  }

  next(timeoutMs = 60_000): Promise<Record<string, unknown>> {
    const ready = this.pending.shift();
    if (ready) return Promise.resolve(ready);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolveValue, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`reader process did not answer in ${timeoutMs} ms; stderr:\n${this.stderr}`)),
        timeoutMs,
      );
      this.queue.push({
        resolve: (value) => { clearTimeout(timer); resolveValue(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  send(command: Record<string, unknown>): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async read(teamId: string, memberId: string): Promise<string> {
    return (await this.served(teamId, memberId)).payload;
  }

  /** The payload AND which path served it in that process: memory, a persisted row, or a cold build. */
  async served(teamId: string, memberId: string): Promise<{ payload: string; origin: string | null }> {
    this.send({ op: "read", teamId, memberId });
    const reply = await this.next();
    if (!reply.ok) return { payload: `ERROR:${String(reply.error)}`, origin: null };
    return { payload: String(reply.payload), origin: (reply.origin as string | null) ?? null };
  }

  stop(): void {
    this.failure ??= new Error("reader stopped");
    try { this.child.stdin.write(`${JSON.stringify({ op: "exit" })}\n`); } catch { /* already gone */ }
    this.child.kill();
  }
}

const readers: Reader[] = [];
afterEach(() => { while (readers.length) readers.pop()!.stop(); });

async function startReader(): Promise<Reader> {
  const reader = new Reader();
  readers.push(reader);
  expect(await reader.next()).toEqual({ ready: true });
  return reader;
}

async function memberWithPrivateProject(seed: Seed, memberId: string, slug: string): Promise<string> {
  const { data: group } = await db().from("groups").insert({
    team_id: seed.teamId, slug: `person-${randomUUID()}`, name: slug, person_member_id: memberId,
  }).select("id").single();
  await db().from("group_members").insert({ team_id: seed.teamId, group_id: (group as { id: string }).id, member_id: memberId });
  const { data: project } = await db().from("projects").insert({
    team_id: seed.teamId, slug: `${slug}-${randomUUID().slice(0, 6)}`, name: slug, kind: "initiative",
  }).select("id").single();
  const projectId = (project as { id: string }).id;
  await db().from("project_groups").insert({ team_id: seed.teamId, project_id: projectId, group_id: (group as { id: string }).id });
  const pointer = await ensureProjectGraphPointer(db(), { teamId: seed.teamId, projectId });
  if (!pointer.ok) throw new Error(pointer.error);
  return projectId;
}

async function world() {
  const seed = await seedTeam();
  await setMemberIdentity(db(), seed.teamId, seed.memberId, { provider: "gdrive", externalId: "permission:t1-author" });
  const { data: other } = await db().from("members").insert({
    team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "Reader B",
    actor_handle: `reader-b-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active",
  }).select("id").single();
  const readerB = (other as { id: string }).id;
  const projectA = await memberWithPrivateProject(seed, seed.memberId, "t1-a");
  const projectB = await memberWithPrivateProject(seed, readerB, "t1-b");
  const connection = async (name: string, project: string) => (await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name, status: "enabled",
    config: { fileIds: ["t1-doc"], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
      authMode: "service_account", audienceProjectIds: [project] },
  })).id;
  const connectionA = await connection("t1-a", projectA);
  const connectionB = await connection("t1-b", projectB);
  const sourceAt = new Date(Date.now() - 86_400_000).toISOString();
  const item = await driveFixture(seed, {
    project: "drive-storage", path: "gdrive/t1-doc.md", body: "multi-process revocation body",
    frontmatter: {
      source: "gdrive", source_id: "t1-doc", title: TITLE, source_ts: sourceAt,
      authors: [{ provider: "gdrive", external_id: "permission:t1-author", role: "editor" }],
      contributions: [{ external_id: "permission:t1-author", role: "editor", at: sourceAt }],
    },
  }, { unclaimed: true });
  await db().from("items").update({ member_id: seed.memberId }).eq("id", item.id);
  for (const [integrationId, project] of [[connectionA, projectA], [connectionB, projectB]] as const) {
    await recordGdriveItemClaim(db(), {
      teamId: seed.teamId, integrationId, providerId: "t1-doc", itemId: item.id, generation: 1, audienceProjectIds: [project],
    });
  }
  return { seed, readerA: seed.memberId, readerB, connectionA };
}

const revokeA = (w: Awaited<ReturnType<typeof world>>) => stageGdriveReconciliation(db(), w.seed.teamId, {
  connectionId: w.connectionA, removedProviderIds: ["t1-doc"], reason: "T1 revocation",
});

describe("Drive revocation across application processes (R44 T1, real Postgres)", () => {
  it("another process's memory and persisted rows stop serving revoked text; the surviving audience keeps it", async () => {
    const w = await world();
    const processB = await startReader();
    const coldB = await processB.served(w.seed.teamId, w.readerA);
    expect(coldB).toMatchObject({ origin: "cold" });
    expect(coldB.payload).toContain(TITLE);
    expect(await processB.read(w.seed.teamId, w.readerB)).toContain(TITLE);
    // R45 L8 — the two cache paths are proven SEPARATELY before the revocation:
    // a WARM MEMORY hit in process B …
    const warm = await processB.served(w.seed.teamId, w.readerA);
    expect(warm).toMatchObject({ origin: "memory" });
    expect(warm.payload).toContain(TITLE);
    // … and, in a process with NO memory of it (process C, started cold), a PERSISTED-ROW hit.
    const processC = await startReader();
    const fromRow = await processC.served(w.seed.teamId, w.readerA);
    expect(fromRow).toMatchObject({ origin: "persisted" });
    expect(fromRow.payload).toContain(TITLE);

    await revokeA(w); // process A: the production revocation writer, which advances the epoch

    // Neither path serves the old text. C reads FIRST, while the only row is the one it served
    // before: that row is superseded, so C rebuilds cold under the new authorization.
    const afterRow = await processC.served(w.seed.teamId, w.readerA);
    expect(afterRow.payload.startsWith("ERROR:")).toBe(false);
    expect(afterRow.payload).not.toContain(TITLE);
    expect(afterRow.origin, "the superseded persisted row is not served").toBe("cold");
    // B's memory entry is superseded too: never served from memory again. (It may serve the row C
    // just wrote under the NEW authorization — which carries no revoked text.)
    const afterMemory = await processB.served(w.seed.teamId, w.readerA);
    expect(afterMemory.payload.startsWith("ERROR:")).toBe(false);
    expect(afterMemory.payload).not.toContain(TITLE);
    expect(afterMemory.origin, "the superseded memory entry is not served").not.toBe("memory");
    // The surviving audience keeps it.
    expect(await processB.read(w.seed.teamId, w.readerB)).toContain(TITLE);
    expect(await processC.read(w.seed.teamId, w.readerB)).toContain(TITLE);
  }, 120_000);

  it("a cold rebuild held across the revocation is never published with the old text", async () => {
    const w = await world();
    const processB = await startReader();
    processB.send({ op: "hold", teamId: w.seed.teamId, memberId: w.readerA });
    expect(await processB.next()).toEqual({ held: true });

    await revokeA(w);
    processB.send({ op: "release" });
    const reply = await processB.next();
    // Either rebuilt under the new authorization, or refused as changed — never the old text.
    if (reply.ok) expect(String(reply.payload)).not.toContain(TITLE);
    else expect(reply.error).toBe("TimelineAuthorizationChangedError");

    // Served afterwards — from process B's memory or its persisted row — still without it, while
    // reader B's own audience is unaffected.
    expect(await processB.read(w.seed.teamId, w.readerA)).not.toContain(TITLE);
    expect(await processB.read(w.seed.teamId, w.readerB)).toContain(TITLE);
  }, 120_000);
});
