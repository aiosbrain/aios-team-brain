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
 *   · B refuses the old text to reader A — from memory and from its persisted row alike;
 *   · B still serves reader B, whose own claim stands;
 *   · a cold rebuild B started BEFORE the revocation and published AFTER it is refused, and what B
 *     serves and persists afterwards carries no old text.
 */

const TITLE = `Multi-process revocation ${randomUUID().slice(0, 8)}`;
const CHILD = resolve(__dirname, "processes/timeline-reader.ts");

class Reader {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly queue: Array<(value: Record<string, unknown>) => void> = [];
  private readonly pending: Record<string, unknown>[] = [];

  constructor() {
    this.child = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", CHILD], {
      env: process.env, stdio: ["pipe", "pipe", "pipe"],
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let value: Record<string, unknown>;
      try { value = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      const waiter = this.queue.shift();
      if (waiter) waiter(value); else this.pending.push(value);
    });
  }

  next(timeoutMs = 60_000): Promise<Record<string, unknown>> {
    const ready = this.pending.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolveValue, reject) => {
      const timer = setTimeout(() => reject(new Error("reader process did not answer")), timeoutMs);
      this.queue.push((value) => { clearTimeout(timer); resolveValue(value); });
    });
  }

  send(command: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async read(teamId: string, memberId: string): Promise<string> {
    this.send({ op: "read", teamId, memberId });
    const reply = await this.next();
    if (!reply.ok) return `ERROR:${String(reply.error)}`;
    return String(reply.payload);
  }

  stop(): void {
    try { this.send({ op: "exit" }); } catch { /* already gone */ }
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
    expect(await processB.read(w.seed.teamId, w.readerA)).toContain(TITLE);
    expect(await processB.read(w.seed.teamId, w.readerB)).toContain(TITLE);
    // Served again from process B's memory, still authorized.
    expect(await processB.read(w.seed.teamId, w.readerA)).toContain(TITLE);

    await revokeA(w); // process A: the production revocation writer, which advances the epoch

    const afterA = await processB.read(w.seed.teamId, w.readerA);
    expect(afterA).not.toContain(TITLE);
    expect(afterA.startsWith("ERROR:")).toBe(false);
    expect(await processB.read(w.seed.teamId, w.readerB)).toContain(TITLE);
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
