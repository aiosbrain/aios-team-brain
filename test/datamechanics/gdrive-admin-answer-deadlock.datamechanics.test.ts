import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * AIO-1167 R89 — a Drive Admin publication and a protected answer publication never deadlock
 * (real Postgres, real publishers, deterministic barriers and lock evidence — no sleeps).
 *
 * Spec (Astra R89 adjudication). A protected answer holds the revocation epoch `for share`
 * (`withOutputPublication`) and then needs a foreign-key KEY SHARE on its member's row for the message
 * insert (`appendMessage`). A Drive Admin publication holds that same member's row through
 * `lockActiveTeamAdmin` and then advances the epoch — a save that narrows a claimed audience
 * (`applyGdriveConnectionAudience`) or an OAuth publication whose verified roster match creates a fresh
 * mapping. With the Admin row locked `for update` the cycle answer→member→epoch aborts one side with
 * 40P01; `for no key update` admits the key share, so the answer commits and the Drive publication's
 * epoch advance follows. Both commit, the message keeps its ORIGINAL epoch and a public reader
 * suppresses it. Controls: a role update still blocks behind the Admin lock (a sanctioned Everyone
 * removal is pinned in gdrive-admin-everyone-gate).
 */

import { revocationEpoch } from "@/lib/access/authorization-epoch";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { addMemberToGroup, createGroup, grantProjectToGroup } from "@/lib/access/groups";
import { appendMessage, getConversation } from "@/lib/chat/store";
import { getPool, runSql } from "@/lib/db/pg/pool";
import { saveGdriveConnectionConfig } from "@/lib/integrations/gdrive-authority";
import { publishGoogleDriveOAuthCredential } from "@/lib/integrations/gdrive-oauth";
import { setIntegrationSecret, upsertIntegration } from "@/lib/integrations/manage";
import { recordGdriveItemClaim } from "@/lib/projects/context/gdrive-claims";
import { withOutputPublication } from "@/lib/query/output-provenance";
import { db, driveFixture, externalMember, placeMemberByTier, seedTeam, type Seed } from "./helpers";
import { createRunSafety, currentRunSafety, type RunSafety } from "./run-fatal-latch";

/** Per test: fixture setup, sequential ~10 s evidence waits, completion, and the bounded settlement below. */
const RACE_TIMEOUT_MS = 60_000;
/** How long a scope waits for every operation it started to settle before it stops the run. */
const SETTLE_MS = 20_000;

interface RaceScope {
  /** Own a started operation: it is joined (all-settled) before the scope ends, whatever happened. */
  track<T>(operation: Promise<T>): Promise<T>;
  /** Something to run first at cleanup (releasing a barrier), so the tracked operations can finish. */
  onCleanup(release: () => void): void;
  /**
   * R91: a session this scope owns could NOT be proven clean (its rollback failed). STICKY: the run is
   * stopped at once and the scope's marker is kept — settlement of the tracked promises proves nothing
   * about that session, so the scope never disarms.
   */
  failCleanup(reason: string): void;
}

/**
 * R90 — the tier's run-safety convention (`run-fatal-latch`, as `identity-race-harness` applies it):
 * the scope's in-flight marker is ARMED before any concurrent database work, and DISARMED only once
 * every operation it started is proven settled. On every path — a failed assertion, a rejected
 * operation — the barriers are released and the operations joined with all-settlement, then the
 * original outcome is reported. Settlement that cannot be proven within the bound stops the run
 * (`setFatal`) and leaves the marker, so shared teardown never truncates around work still in flight;
 * so does an outer timeout that interrupts the scope before it could conclude.
 */
async function raceScope<T>(
  name: string,
  body: (scope: RaceScope) => Promise<T>,
  safety: RunSafety = currentRunSafety(),
): Promise<T> {
  const tag = `r89-${name}-${randomUUID().slice(0, 8)}`;
  safety.arm(tag, `R89 answer/Drive Admin race (${name})`); // FIRST: nothing below runs if it cannot be written
  const started: Promise<unknown>[] = [];
  const releases: (() => void)[] = [];
  let cleanupFailure: string | null = null;
  const scope: RaceScope = {
    track: (operation) => {
      started.push(operation);
      operation.catch(() => undefined); // owned: joined below, so never an unhandled rejection
      return operation;
    },
    onCleanup: (release) => { releases.push(release); },
    failCleanup: (reason) => {
      if (cleanupFailure !== null) return; // sticky: the first reason stands
      cleanupFailure = reason;
      safety.setFatal(reason);
    },
  };
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await body(scope) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  for (const release of releases) release();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    Promise.allSettled(started).then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), SETTLE_MS); }),
  ]);
  clearTimeout(timer);
  // Disarm ONLY when every tracked operation settled AND no owned session failed its cleanup.
  if (settled && cleanupFailure === null) safety.disarm(tag);
  else if (!settled) safety.setFatal(`R89 race ${tag}: ${started.length} started operation(s) did not settle within ${SETTLE_MS} ms; `
    + "sessions that may still hold locks must not be truncated around");
  if (!outcome.ok) throw outcome.error;
  if (cleanupFailure !== null) throw new Error(cleanupFailure);
  if (!settled) throw new Error(`R89 race ${tag}: started operations did not settle`);
  return outcome.value;
}

const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";

/** A deferred: `wait` resolves once `fire` is called. */
function barrier() {
  let fire!: () => void;
  const wait = new Promise<void>((resolve) => { fire = resolve; });
  return { wait, fire };
}

/** Poll lock evidence (never a sleep that orders events): bounded at ~10 s. */
async function eventually(check: () => Promise<boolean>): Promise<boolean> {
  for (let tries = 0; tries < 400; tries++) {
    if (await check()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
const waitsOnLock = (pattern: string) => eventually(async () => (await getPool().query<{ n: number }>(
  `select count(*)::int as n from pg_stat_activity
    where datname=current_database() and wait_event_type='Lock' and query ilike $1`, [pattern])).rows[0].n > 0);
/** Some backend is blocked on THIS backend's locks (precise, whatever statement it waits in). */
const blockedOn = (pid: number) => eventually(async () => (await getPool().query<{ n: number }>(
  `select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))`, [pid])).rows[0].n > 0);

/** The slice of a pooled client the probe uses (a seam: the harness test injects a failing one). */
interface ProbeClient {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  release(error?: Error): void;
}

/**
 * Lock evidence without waiting: is the member row held by a conflicting (no key update) lock?
 * Only `55P03` from the lock attempt is positive evidence; any other lock-query error is reported.
 *
 * R91: the probe's WHOLE acquisition/query/cleanup is owned by the scope. Its session is returned to
 * the pool only after a rollback that succeeded. A failed rollback is NOT cleanup: the scope is told
 * (`failCleanup` — the run is stopped, its marker kept), the client is destroyed with
 * `release(error)` exactly once — which only begins termination, and is never taken as proof of it —
 * and the original lock-query error, if there was one, still wins over the cleanup error.
 */
function memberRowHeld(
  memberId: string,
  scope: RaceScope,
  connect: () => Promise<ProbeClient> = () => getPool().connect(),
): Promise<boolean> {
  return scope.track((async () => {
    const probe = await connect();
    let held = false;
    let lockError: { error: unknown } | null = null;
    try {
      await probe.query("begin");
      await probe.query(`select id from members where id=$1 for no key update nowait`, [memberId]);
    } catch (error) {
      if ((error as { code?: string }).code === "55P03") held = true;
      else lockError = { error };
    }
    try {
      await probe.query("rollback");
    } catch (rollbackError) {
      const reason = `R89 race probe: rollback failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}); `
        + "its session may still hold an open transaction and must not be truncated around";
      scope.failCleanup(reason);
      probe.release(rollbackError instanceof Error ? rollbackError : new Error(reason));
      throw lockError ? lockError.error : new Error(reason);
    }
    probe.release();
    if (lockError) throw lockError.error;
    return held;
  })());
}

const epochOf = async (teamId: string) => Number((await getPool().query<{ e: string }>(
  `select coalesce((select epoch from team_authorization_epochs where team_id=$1), 1)::text as e`, [teamId])).rows[0].e);

/**
 * A protected answer for the Admin's own conversation, published through the real gate: it share-locks
 * the epoch, then waits at `release` BEFORE its `appendMessage` (whose FK key-shares the Admin's row).
 */
async function heldProtectedAnswer(seed: Seed, text: string, scope: RaceScope) {
  const owner = { teamId: seed.teamId, memberId: seed.memberId };
  const { rows } = await getPool().query<{ id: string }>(
    `insert into conversations(team_id, member_id, title) values ($1,$2,'t') returning id`, [seed.teamId, seed.memberId]);
  const convo = rows[0].id;
  const provenance = { epoch: await revocationEpoch(db(), seed.teamId) };
  const holding = barrier();
  const release = barrier();
  let pid = 0;
  scope.onCleanup(release.fire);
  const done = scope.track(withOutputPublication(seed.teamId, provenance, async () => {
    pid = (await runSql<{ pid: number }>("select pg_backend_pid() as pid", [])).rows[0].pid;
    holding.fire(); // the epoch share lock is held
    await release.wait;
    return appendMessage(db(), owner, convo, "assistant", text, {}, provenance);
  }));
  // Readiness rejects if the publication settles before it ever held the epoch — never a hang.
  await Promise.race([
    holding.wait,
    done.then(
      () => { throw new Error("the protected answer finished before holding the epoch"); },
      (error: unknown) => { throw error; },
    ),
  ]);
  const stored = async () => (await getPool().query<{ e: string }>(
    `select context_authorization_epoch::text as e from chat_messages where conversation_id=$1`, [convo])).rows;
  const readable = async () => (await getConversation(db(), owner, convo))!.messages.map((m) => m.content);
  return { done, release: release.fire, provenance, stored, readable, pid: () => pid };
}

/** A converged team whose Admin has a Drive connection with ONE claimed item placed in two projects. */
async function claimedAudience() {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  const project = async () => {
    const { data } = await db().from("projects")
      .insert({ team_id: seed.teamId, slug: `drive-${randomUUID().slice(0, 8)}`, name: "Audience", kind: "initiative" })
      .select("id").single();
    const projectId = (data as { id: string }).id;
    const group = await createGroup(db(), seed.teamId, `aud-${randomUUID().slice(0, 8)}`, "Audience", seed.memberId);
    const member = await externalMember(seed);
    expect((await addMemberToGroup(db(), seed.teamId, group.groupId!, member, seed.memberId)).ok).toBe(true);
    expect((await grantProjectToGroup(db(), seed.teamId, projectId, group.groupId!, seed.memberId)).ok).toBe(true);
    return projectId;
  };
  const kept = await project();
  const dropped = await project();
  const name = `drive-${randomUUID().slice(0, 8)}`;
  const config = (audienceProjectIds: string[]) => ({
    fileIds: ["doc"], folderIds: [], sharedDriveIds: [], recursive: false,
    selectionState: "selected", authMode: "service_account", audienceProjectIds,
  });
  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name, status: "enabled", config: config([kept, dropped]),
  });
  const item = await driveFixture(seed, {
    project: "drive-storage", path: "gdrive/doc-race.md", body: "Drive body",
    frontmatter: { source: "gdrive", source_id: "doc-race" },
  }, { unclaimed: true });
  await recordGdriveItemClaim(db(), {
    teamId: seed.teamId, integrationId: row.id, providerId: "doc-race", itemId: item.id, generation: 1,
    audienceProjectIds: [kept, dropped],
  });
  const claimProjects = async () => (await getPool().query<{ project_id: string }>(
    `select project_id from gdrive_item_claim_projects where integration_id=$1 and provider_id='doc-race'`, [row.id]))
    .rows.map((r) => r.project_id).sort();
  return { seed, name, integrationId: row.id, kept, dropped, config, claimProjects };
}

describe("R89: a protected answer and a Drive Admin epoch advance both commit", () => {
  // Repeated: the interleaving is forced by barriers and lock evidence, so every round must agree.
  it.each(Array.from({ length: 5 }, (_, n) => n + 1))("audience-narrowing save, round %i", { timeout: RACE_TIMEOUT_MS }, async () => {
    const w = await claimedAudience();
    expect(await w.claimProjects()).toEqual([w.kept, w.dropped].sort());
    const original = await epochOf(w.seed.teamId);
    const answer = await raceScope("save", async (scope) => {
      const answer = await heldProtectedAnswer(w.seed, "falconmere protected answer", scope);
      const save = scope.track(saveGdriveConnectionConfig(db(), { teamId: w.seed.teamId, memberId: w.seed.memberId }, {
        name: w.name, config: w.config([w.kept]),
      }));
      expect(await blockedOn(answer.pid()), "the save is blocked by the answer's epoch share").toBe(true);
      expect(await waitsOnLock("%team_authorization_epochs%do update%")).toBe(true);
      expect(await memberRowHeld(w.seed.memberId, scope), "while holding the Admin's member row").toBe(true);
      answer.release(); // the answer's message insert key-shares that same member row
      await expect(answer.done).resolves.toBeTruthy();
      await expect(save).resolves.toMatchObject({ id: w.integrationId });
      return answer;
    });

    expect(await w.claimProjects(), "the audience was narrowed").toEqual([w.kept]);
    expect(await epochOf(w.seed.teamId), "the barrier advanced").toBeGreaterThan(original);
    expect(await answer.stored()).toEqual([{ e: String(answer.provenance.epoch) }]);
    expect(await answer.readable(), "suppressed by the public reader").toEqual([]);
  });

  it.each(Array.from({ length: 5 }, (_, n) => n + 1))("OAuth publication creating a verified mapping, round %i", { timeout: RACE_TIMEOUT_MS }, async () => {
    const seed = await seedTeam();
    await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
    const email = `roster-${randomUUID().slice(0, 8)}@example.com`;
    const { data: roster } = await db().from("members").insert({
      team_id: seed.teamId, email, display_name: "Roster", actor_handle: `r-${randomUUID().slice(0, 8)}`,
      role: "member", tier: "team", status: "active",
    }).select("id").single();
    const rosterId = (roster as { id: string }).id;
    await placeMemberByTier(seed.teamId, rosterId, "team");
    const auth = { teamId: seed.teamId, memberId: seed.memberId };
    const name = `oauth-${randomUUID().slice(0, 8)}`;
    const row = await upsertIntegration(db(), auth, {
      type: "gdrive", name, status: "enabled",
      config: { fileIds: ["Kept"], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
        access: "team", authMode: "oauth", authenticatedAccount: "old@example.com", authenticatedAccountId: "subject:old" },
    });
    await setIntegrationSecret(db(), auth, row.id, JSON.stringify({
      client_id: "oauth-client", client_secret: "stored", refresh_token: "stored-refresh", account_subject: "subject:old",
      scopes: ["openid", DRIVE_FILE], grant_mode: "files",
    }));
    const mappings = async () => (await getPool().query(
      `select 1 from member_identities where team_id=$1 and member_id=$2 and provider='gdrive'`, [seed.teamId, rosterId])).rows.length;
    expect(await mappings()).toBe(0);
    const original = await epochOf(seed.teamId);
    const answer = await raceScope("oauth", async (scope) => {
      const answer = await heldProtectedAnswer(seed, "kestrelvane protected answer", scope);
      const oauth = scope.track(publishGoogleDriveOAuthCredential({
        teamId: seed.teamId, memberId: seed.memberId, integrationName: name, clientId: "oauth-client",
        clientSecret: "new-secret", subject: `acct-${randomUUID().slice(0, 8)}`, email, emailVerified: true,
        refreshToken: "new-refresh", scopes: [DRIVE_FILE], grantMode: "files",
      }));
      expect(await blockedOn(answer.pid()), "the publication is blocked by the answer's epoch share").toBe(true);
      expect(await memberRowHeld(seed.memberId, scope), "while holding the Admin's member row").toBe(true);
      answer.release();
      await expect(answer.done).resolves.toBeTruthy();
      await expect(oauth).resolves.toBeTruthy();
      return answer;
    });

    expect(await mappings(), "the verified roster mapping was created").toBeGreaterThan(0);
    expect(await epochOf(seed.teamId), "identity state advanced the barrier").toBeGreaterThan(original);
    expect(await answer.stored()).toEqual([{ e: String(answer.provenance.epoch) }]);
    expect(await answer.readable()).toEqual([]);
  });

  it("control: a role update still blocks behind the Admin lock until the publication commits", { timeout: RACE_TIMEOUT_MS }, async () => {
    const w = await claimedAudience();
    await raceScope("control", async (scope) => {
      const answer = await heldProtectedAnswer(w.seed, "ospreyline protected answer", scope);
      const save = scope.track(saveGdriveConnectionConfig(db(), { teamId: w.seed.teamId, memberId: w.seed.memberId }, {
        name: w.name, config: w.config([w.kept]),
      }));
      expect(await blockedOn(answer.pid())).toBe(true); // the save holds the Admin lock, waiting on the epoch
      const demotion = scope.track(getPool().query(`update members set role='member' where id=$1 /* r89-demote */`, [w.seed.memberId]));
      expect(await waitsOnLock("%r89-demote%"), "the role update waits on the Admin lock").toBe(true);
      answer.release();
      await expect(answer.done).resolves.toBeTruthy();
      await expect(save).resolves.toBeTruthy();
      await demotion;
    });
    const { rows } = await getPool().query<{ role: string }>(`select role from members where id=$1`, [w.seed.memberId]);
    expect(rows[0].role).toBe("member");
  });
});

/**
 * R91 — the probe's cleanup branches, exactly. A fake client (no database) and an ISOLATED run-safety
 * directory, so a stopped run here stops nothing else: a failed rollback keeps the scope armed and the
 * run stopped whatever else settled; a lock-query error survives a failed cleanup; only a proven
 * rollback lets the scope disarm; the client is released exactly once, destroyed after a failure.
 */
describe("R91: a probe whose rollback fails keeps the scope armed and stops the run", () => {
  const isolatedSafety = () => createRunSafety(mkdtempSync(join(tmpdir(), "r91-run-safety-")));
  function fakeProbe(lock: "free" | "held" | "error", rollback: "ok" | "fail") {
    const released: (Error | undefined)[] = [];
    const client: ProbeClient = {
      async query(sql: string) {
        if (sql === "rollback" && rollback === "fail") throw new Error("r91 rollback refused");
        if (sql.includes("nowait") && lock === "held") throw Object.assign(new Error("lock not available"), { code: "55P03" });
        if (sql.includes("nowait") && lock === "error") throw Object.assign(new Error("r91 lock query broke"), { code: "XX000" });
        return {};
      },
      release: (error?: Error) => { released.push(error); },
    };
    return { connect: async () => client, released };
  }
  const run = (safety: RunSafety, probe: ReturnType<typeof fakeProbe>) =>
    raceScope("probe", (scope) => memberRowHeld("member", scope, probe.connect), safety);

  it("rollback fails after positive lock evidence: the cleanup error is reported, the run stopped, the marker kept", async () => {
    const safety = isolatedSafety();
    const probe = fakeProbe("held", "fail");
    await expect(run(safety, probe)).rejects.toThrow(/rollback failed \(r91 rollback refused\)/);
    expect(safety.fatal()).toMatch(/rollback failed/);
    expect(safety.armed()).toHaveLength(1);
    expect(probe.released).toHaveLength(1);
    expect(probe.released[0]).toBeInstanceOf(Error); // destroyed, never returned to the pool
  });

  it("rollback fails after a lock-query error: the ORIGINAL lock error is reported; still stopped and armed", async () => {
    const safety = isolatedSafety();
    const probe = fakeProbe("error", "fail");
    await expect(run(safety, probe)).rejects.toThrow("r91 lock query broke");
    expect(safety.fatal()).toMatch(/rollback failed/);
    expect(safety.armed()).toHaveLength(1);
    expect(probe.released).toHaveLength(1);
    expect(probe.released[0]).toBeInstanceOf(Error);
  });

  it("controls: a proven rollback disarms — 55P03 is positive evidence, a free row is not, a lock-query error is reported", async () => {
    for (const [lock, expected] of [["held", true], ["free", false]] as const) {
      const safety = isolatedSafety();
      const probe = fakeProbe(lock, "ok");
      await expect(run(safety, probe)).resolves.toBe(expected);
      expect(safety.fatal()).toBeNull();
      expect(safety.armed()).toEqual([]);
      expect(probe.released).toEqual([undefined]); // returned to the pool exactly once
    }
    const safety = isolatedSafety();
    const probe = fakeProbe("error", "ok");
    await expect(run(safety, probe)).rejects.toThrow("r91 lock query broke");
    expect(safety.fatal()).toBeNull();
    expect(safety.armed()).toEqual([]);
    expect(probe.released).toEqual([undefined]);
  });
});
