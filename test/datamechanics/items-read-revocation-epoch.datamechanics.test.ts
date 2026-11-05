import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

/**
 * AIO-1167 R95 P1-A — the direct item reads (`GET /api/v1/items`, `GET /api/v1/items/<id>`) bind the
 * principal's scope to ONE revocation epoch (real Postgres, the real routes, the production Google
 * reconciliation owner, deterministic pause points).
 *
 * Connections A and B both claim one Google document. Reader A sees it only through A's claim; reader B
 * only through B's. Only A is retired (`reconcileGdriveItems`), so the canonical row stays — B still reads
 * it — while A's in-flight request must not publish its restricted body/title/path/provenance:
 *   · paused after authorization, before the row read;
 *   · paused after the row read, before publication;
 *   · an agent paused after its effective scope resolved;
 * and the reverse: a publication that took the epoch lock first is served (the revocation waits on it),
 * after which reads deny. Repeated epoch changes and an unreadable/unlockable epoch fail closed (503), and
 * no failed or retried response carries a stale row or cursor.
 */

type Hook = (pid?: number) => Promise<void>;
const hooks = vi.hoisted(() => ({
  afterVisibleIds: null as null | ((pid?: number) => Promise<void>),
  afterProbe: null as null | ((pid?: number) => Promise<void>),
  afterEffective: null as null | ((pid?: number) => Promise<void>),
  beforeBarrier: null as null | ((pid?: number) => Promise<void>),
  insideBarrier: null as null | ((pid?: number) => Promise<void>),
  /** Keep a hook armed for every call (the repeated-change arm); otherwise each fires once. */
  persistent: false,
  epochReadFailures: 0,
  barrierFailures: 0,
}));

async function fire(slot: "afterVisibleIds" | "afterProbe" | "afterEffective" | "beforeBarrier", pid?: number) {
  const hook = hooks[slot];
  if (!hook) return;
  if (!hooks.persistent) hooks[slot] = null;
  await hook(pid);
}

vi.mock("@/lib/access/enforce", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/access/enforce")>();
  return {
    ...real,
    visibleItemIdsForProjects: async (...args: Parameters<typeof real.visibleItemIdsForProjects>) => {
      const result = await real.visibleItemIdsForProjects(...args);
      await fire("afterVisibleIds");
      return result;
    },
    canSeeItem: async (...args: Parameters<typeof real.canSeeItem>) => {
      const result = await real.canSeeItem(...args);
      await fire("afterProbe");
      return result;
    },
  };
});

vi.mock("@/lib/access/oracle", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/access/oracle")>();
  return {
    ...real,
    effectiveVisibleProjects: async (...args: Parameters<typeof real.effectiveVisibleProjects>) => {
      const result = await real.effectiveVisibleProjects(...args);
      await fire("afterEffective");
      return result;
    },
  };
});

vi.mock("@/lib/access/authorization-epoch", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/access/authorization-epoch")>();
  return {
    ...real,
    revocationEpoch: async (...args: Parameters<typeof real.revocationEpoch>) => {
      if (hooks.epochReadFailures > 0) {
        hooks.epochReadFailures -= 1;
        throw new Error("authorization epoch read failed (injected)");
      }
      return real.revocationEpoch(...args);
    },
    lockedRevocationEpoch: async (teamId: string) => {
      if (hooks.barrierFailures > 0) {
        hooks.barrierFailures -= 1;
        throw new Error("authorization epoch lock failed (injected)");
      }
      await fire("beforeBarrier");
      const epoch = await real.lockedRevocationEpoch(teamId);
      const inside = hooks.insideBarrier;
      if (inside) {
        hooks.insideBarrier = null;
        const { runSql } = await import("@/lib/db/pg/pool");
        await inside((await runSql<{ pid: number }>("select pg_backend_pid() as pid", [])).rows[0].pid);
      }
      return epoch;
    },
  };
});

import { advanceAuthorizationEpoch } from "@/lib/access/authorization-epoch";
import { mintAgentToken } from "@/lib/access/agent-tokens";
import { issueApiKey } from "@/lib/admin/keys";
import { getPool } from "@/lib/db/pg/pool";
import { ensureProjectGraphPointer } from "@/lib/graph/project-pointer";
import { reconcileGdriveItems } from "@/lib/ingest/source-reconcile";
import { upsertIntegration } from "@/lib/integrations/manage";
import { recordGdriveItemClaim } from "@/lib/projects/context/gdrive-claims";
import { convergeIdentityAttribution, db, driveFixture, placeMemberByTier, seedTeam, type Seed } from "./helpers";

const TIMEOUT = 60_000;
const PROVIDER = "r95-shared-doc";
// Non-hex marker: response ids are random UUIDs, so a hex marker could appear by chance.
const MARKER = "quokka";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** A pause point: `hook` signals `entered` (with its backend pid when known) and waits for `release`. */
function pausePoint() {
  const entered = deferred<number | undefined>();
  const release = deferred();
  const hook: Hook = async (pid?: number) => {
    entered.resolve(pid);
    await release.promise;
  };
  return { entered, release, hook };
}

async function eventually(check: () => Promise<boolean>): Promise<boolean> {
  for (let tries = 0; tries < 400; tries++) {
    if (await check()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

const blockedBy = (holder: number) => eventually(async () => (await getPool().query<{ n: number }>(
  `select count(*)::int as n from pg_stat_activity
    where wait_event_type='Lock' and $1 = any(pg_blocking_pids(pid))`, [holder])).rows[0].n > 0);

const epochOf = async (teamId: string) => Number((await getPool().query<{ e: string }>(
  `select coalesce((select epoch from team_authorization_epochs where team_id=$1), 1)::text as e`, [teamId])).rows[0].e);

function resetHooks() {
  hooks.afterVisibleIds = null;
  hooks.afterProbe = null;
  hooks.afterEffective = null;
  hooks.beforeBarrier = null;
  hooks.insideBarrier = null;
  hooks.persistent = false;
  hooks.epochReadFailures = 0;
  hooks.barrierFailures = 0;
}

/** Run `body`; on every path release the pause points, disarm the hooks and join every operation. */
async function joined<T>(releases: (() => void)[], operations: Promise<unknown>[], body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } finally {
    for (const release of releases) release();
    resetHooks();
    await Promise.allSettled(operations);
  }
}

async function member(seed: Seed, name: string): Promise<string> {
  const { data } = await db().from("members").insert({
    team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: name,
    actor_handle: `r95-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active",
  }).select("id").single();
  const id = (data as { id: string }).id;
  await placeMemberByTier(seed.teamId, id, "team");
  return id;
}

/** A restricted project granted to ONE member's person group (the audience-claims fixture shape). */
async function privateAudience(seed: Seed, memberId: string, slug: string): Promise<string> {
  const { data: group } = await db().from("groups").insert({
    team_id: seed.teamId, slug: `person-${randomUUID()}`, name: slug, person_member_id: memberId,
  }).select("id").single();
  await db().from("group_members").insert({
    team_id: seed.teamId, group_id: (group as { id: string }).id, member_id: memberId,
  });
  const { data: project } = await db().from("projects").insert({
    team_id: seed.teamId, slug, name: slug, kind: "initiative",
  }).select("id").single();
  const projectId = (project as { id: string }).id;
  await db().from("project_groups").insert({
    team_id: seed.teamId, project_id: projectId, group_id: (group as { id: string }).id,
  });
  const pointer = await ensureProjectGraphPointer(db(), { teamId: seed.teamId, projectId });
  if (!pointer.ok) throw new Error(pointer.error);
  return projectId;
}

async function connection(seed: Seed, name: string, audienceProjectId: string): Promise<string> {
  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name, status: "enabled",
    config: {
      fileIds: [PROVIDER], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", authMode: "service_account", audienceProjectIds: [audienceProjectId],
    },
  });
  return row.id;
}

async function world() {
  const seed = await seedTeam();
  const readerA = await member(seed, "Reader A");
  const readerB = await member(seed, "Reader B");
  await convergeIdentityAttribution(seed);
  const suffix = randomUUID().slice(0, 8);
  const projectA = await privateAudience(seed, readerA, `r95-a-${suffix}`);
  const projectB = await privateAudience(seed, readerB, `r95-b-${suffix}`);
  const connectionA = await connection(seed, `r95-connection-a-${suffix}`, projectA);
  const connectionB = await connection(seed, `r95-connection-b-${suffix}`, projectB);
  const item = await driveFixture(seed, {
    project: `r95-drive-${suffix}`, path: `gdrive/${PROVIDER}.md`,
    body: `Restricted ${MARKER} roadmap body`,
    frontmatter: { source: "gdrive", source_id: PROVIDER, title: `Restricted ${MARKER} plan` },
  }, { unclaimed: true });
  for (const [integrationId, projectId] of [[connectionA, projectA], [connectionB, projectB]] as const) {
    await recordGdriveItemClaim(db(), {
      teamId: seed.teamId, integrationId, providerId: PROVIDER, itemId: item.id,
      generation: 1, audienceProjectIds: [projectId],
    });
  }
  const keyA = (await issueApiKey(db(), seed.teamId, readerA, "r95-a")).key;
  const keyB = (await issueApiKey(db(), seed.teamId, readerB, "r95-b")).key;
  const revokeA = () => reconcileGdriveItems(db(), seed.teamId, {
    connectionId: connectionA, removedProviderIds: [PROVIDER], reason: "R95: connection A lost the document",
  });
  return { seed, readerA, readerB, itemId: item.id, keyA, keyB, revokeA };
}

async function list(key: string): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const { GET } = await import("@/app/api/v1/items/route");
  const res = await GET(new Request("http://test/api/v1/items?since=1970-01-01T00:00:00Z", {
    headers: { authorization: `Bearer ${key}` },
  }) as unknown as NextRequest);
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

async function byId(key: string, id: string): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const { GET } = await import("@/app/api/v1/items/[id]/route");
  const res = await GET(new Request(`http://test/api/v1/items/${id}`, {
    headers: { authorization: `Bearer ${key}` },
  }) as unknown as NextRequest, { params: Promise.resolve({ id }) });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

const listed = (body: Record<string, unknown>) => (body.items as Array<{ id: string }> | undefined) ?? [];

/** A failed-closed answer: the retryable 503, no rows, no cursor, no restricted text. */
function expectUnavailable(response: { status: number; body: Record<string, unknown>; text: string }) {
  expect(response.status).toBe(503);
  expect(response.text).toContain("temporarily_unavailable");
  expect(response.text).not.toContain(MARKER);
  expect(response.body).not.toHaveProperty("items");
  expect(response.body).not.toHaveProperty("next_cursor");
}

describe("R95 P1-A: direct item reads bind the principal's scope to one revocation epoch", () => {
  it("controls: each reader sees the doubly-claimed document through its own connection", { timeout: TIMEOUT }, async () => {
    const w = await world();
    for (const key of [w.keyA, w.keyB]) {
      const page = await list(key);
      expect(page.status).toBe(200);
      expect(listed(page.body).map((row) => row.id)).toContain(w.itemId);
      expect(page.text).toContain(MARKER);
      const one = await byId(key, w.itemId);
      expect(one.status).toBe(200);
      expect(one.text).toContain(MARKER);
    }
  });

  it("list: revoked after authorization, before the row read → A gets no restricted row; B still reads", { timeout: TIMEOUT }, async () => {
    const w = await world();
    const pause = pausePoint();
    const operations: Promise<unknown>[] = [];
    await joined([pause.release.resolve], operations, async () => {
      hooks.afterVisibleIds = pause.hook;
      const read = list(w.keyA);
      operations.push(read);
      await pause.entered.promise; // A's visible ids are materialized; the page is not read yet
      const before = await epochOf(w.seed.teamId);
      await w.revokeA();
      expect(await epochOf(w.seed.teamId), "the production reconciliation advanced the epoch").toBeGreaterThan(before);
      pause.release.resolve();
      const page = await read;
      expect(page.status).toBe(200);
      expect(listed(page.body).map((row) => row.id)).not.toContain(w.itemId);
      expect(page.text).not.toContain(MARKER);
      expect(page.body.next_cursor, "the cursor is the retried page's, not the stale one's").toBeNull();
    });
    const pageB = await list(w.keyB);
    expect(listed(pageB.body).map((row) => row.id)).toContain(w.itemId);
  });

  it("list: revoked after the row read, before publication → the candidate is discarded", { timeout: TIMEOUT }, async () => {
    const w = await world();
    const pause = pausePoint();
    const operations: Promise<unknown>[] = [];
    await joined([pause.release.resolve], operations, async () => {
      hooks.beforeBarrier = pause.hook;
      const read = list(w.keyA);
      operations.push(read);
      await pause.entered.promise; // the page holding the restricted row is built, not yet published
      await w.revokeA();
      pause.release.resolve();
      const page = await read;
      expect(page.status).toBe(200);
      expect(listed(page.body).map((row) => row.id)).not.toContain(w.itemId);
      expect(page.text).not.toContain(MARKER);
    });
    expect((await list(w.keyB)).text).toContain(MARKER);
  });

  it("by id: revoked after the membership probe, before the row read → the same 404 as an absent id", { timeout: TIMEOUT }, async () => {
    const w = await world();
    const absent = await byId(w.keyA, randomUUID());
    expect(absent.status).toBe(404);
    const pause = pausePoint();
    const operations: Promise<unknown>[] = [];
    await joined([pause.release.resolve], operations, async () => {
      hooks.afterProbe = pause.hook;
      const read = byId(w.keyA, w.itemId);
      operations.push(read);
      await pause.entered.promise; // canSeeItem said yes under A's old scope
      await w.revokeA();
      pause.release.resolve();
      const one = await read;
      expect(one.status).toBe(404);
      // Indistinguishable from an absent id: the same status, code and message. Only the per-request
      // `request_id` differs, and each response must still carry one.
      const envelope = (body: Record<string, unknown>) => body.error as { code: unknown; message: unknown; request_id: unknown };
      expect(envelope(one.body).request_id).toEqual(expect.any(String));
      expect(String(envelope(one.body).request_id)).not.toBe("");
      expect(envelope(absent.body).request_id).toEqual(expect.any(String));
      expect(String(envelope(absent.body).request_id)).not.toBe("");
      expect(envelope(absent.body).code, "the comparison is about a real not-found envelope").toBe("not_found");
      expect(
        { status: one.status, code: envelope(one.body).code, message: envelope(one.body).message },
        "indistinguishable from an absent id",
      ).toEqual({ status: absent.status, code: envelope(absent.body).code, message: envelope(absent.body).message });
      expect(one.text).not.toContain(MARKER);
    });
    const oneB = await byId(w.keyB, w.itemId);
    expect(oneB.status).toBe(200);
    expect(oneB.text).toContain(MARKER);
  });

  it("by id: revoked after the row read, before publication → 404, never the row", { timeout: TIMEOUT }, async () => {
    const w = await world();
    const pause = pausePoint();
    const operations: Promise<unknown>[] = [];
    await joined([pause.release.resolve], operations, async () => {
      hooks.beforeBarrier = pause.hook;
      const read = byId(w.keyA, w.itemId);
      operations.push(read);
      await pause.entered.promise;
      await w.revokeA();
      pause.release.resolve();
      const one = await read;
      expect(one.status).toBe(404);
      expect(one.text).not.toContain(MARKER);
    });
    expect((await byId(w.keyB, w.itemId)).status).toBe(200);
  });

  it("agent list: the launcher is revoked after the agent's effective scope resolved → no restricted row", { timeout: TIMEOUT }, async () => {
    const w = await world();
    const minted = await mintAgentToken(db(), w.seed.teamId, {
      memberId: w.readerA, scope: { kind: "all-reachable" }, name: "r95-agent",
    }, w.seed.memberId);
    expect(minted.ok, minted.error).toBe(true);
    const agentKey = minted.token!;
    // Control: the agent reads the document through its launcher's grant.
    expect((await list(agentKey)).text).toContain(MARKER);
    const pause = pausePoint();
    const operations: Promise<unknown>[] = [];
    await joined([pause.release.resolve], operations, async () => {
      hooks.afterEffective = pause.hook;
      const read = list(agentKey);
      operations.push(read);
      await pause.entered.promise; // the effective set still holds A's restricted project
      await w.revokeA();
      pause.release.resolve();
      const page = await read;
      expect(page.status).toBe(200);
      expect(listed(page.body).map((row) => row.id)).not.toContain(w.itemId);
      expect(page.text).not.toContain(MARKER);
    });
  });

  it("reverse order: a publication holding the epoch lock is served; the revocation waits, then reads deny", { timeout: TIMEOUT }, async () => {
    const w = await world();
    const pause = pausePoint();
    const operations: Promise<unknown>[] = [];
    let revocation: Promise<unknown> | null = null;
    await joined([pause.release.resolve], operations, async () => {
      hooks.insideBarrier = pause.hook;
      const read = list(w.keyA);
      operations.push(read);
      const barrierPid = await pause.entered.promise; // the epoch is share-locked by the publication
      expect(barrierPid, "the publication reached its locked check").toBeTypeOf("number");
      revocation = w.revokeA();
      operations.push(revocation);
      expect(await blockedBy(barrierPid!), "the revocation waits on the publication's epoch lock").toBe(true);
      pause.release.resolve();
      const page = await read;
      expect(page.status, "linearized before the revocation: served").toBe(200);
      expect(page.text).toContain(MARKER);
      await revocation;
    });
    expect(revocation, "the revocation ran").not.toBeNull();
    const after = await list(w.keyA);
    expect(listed(after.body).map((row) => row.id)).not.toContain(w.itemId);
    expect((await byId(w.keyA, w.itemId)).status).toBe(404);
  });

  it("repeated epoch changes exhaust the bounded retry and fail closed — list and by id", { timeout: TIMEOUT }, async () => {
    const w = await world();
    await joined([], [], async () => {
      hooks.persistent = true;
      hooks.afterVisibleIds = async () => { await advanceAuthorizationEpoch(w.seed.teamId); };
      expectUnavailable(await list(w.keyA));
    });
    await joined([], [], async () => {
      hooks.persistent = true;
      hooks.afterProbe = async () => { await advanceAuthorizationEpoch(w.seed.teamId); };
      expectUnavailable(await byId(w.keyA, w.itemId));
    });
    // Nothing was revoked: once the changes stop, the reader is served again.
    expect((await list(w.keyA)).text).toContain(MARKER);
  });

  it("an unreadable or unlockable epoch fails closed — list and by id", { timeout: TIMEOUT }, async () => {
    const w = await world();
    for (const read of [() => list(w.keyA), () => byId(w.keyA, w.itemId)]) {
      await joined([], [], async () => {
        hooks.epochReadFailures = 1;
        expectUnavailable(await read());
      });
      await joined([], [], async () => {
        hooks.barrierFailures = 1;
        expectUnavailable(await read());
      });
    }
  });
});
