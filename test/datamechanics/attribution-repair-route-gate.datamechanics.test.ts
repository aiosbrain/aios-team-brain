import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db/pg/pool";
import { issueApiKey } from "@/lib/admin/keys";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { AttributionRepairPendingError, authorizationEpoch, revocationEpoch } from "@/lib/access/authorization-epoch";
import { advanceAuthorizationEpoch } from "@/lib/access/authorization-epoch";
import { getSessionUser } from "@/lib/auth/session";
import { serverClient } from "@/lib/db/server";
import { removeMemberIdentity, setMemberIdentity } from "@/lib/identity/member-identities";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { convergeIdentityAttribution, db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1167 — the identity-attribution repair gate, at the route boundary (real Postgres).
 *
 * Spec. While a team's attribution repair is pending (any roster change on a team with items marks
 * it so), a payload that attributes work to PEOPLE must not be served — neither the old one nor a
 * partial rebuild — and the refusal is the established retryable contract: 503
 * `temporarily_unavailable`, never a raw 500. A read that publishes no person attribution (graph
 * facts) is not taken down by the repair: it stays bound to the revocation barrier alone.
 */

vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/db/server", () => ({ serverClient: vi.fn() }));

// The REAL Timeline builder, with one optional scheduling point after it has read everything and
// before the route publishes: a test commits a real identity mutation or revocation there, so the
// long-window arm's publication check meets genuine mid-read churn. Only the watched team's
// long-window builds are counted, so a cache refresh still running from another test cannot shift
// the count. No watched team = pass-through.
const build = vi.hoisted(() => ({
  teamId: null as string | null,
  during: null as null | ((build: number) => Promise<void>),
  count: 0,
}));
vi.mock("@/lib/dashboard/work-timeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dashboard/work-timeline")>();
  return {
    ...actual,
    getWorkTimeline: async (...args: Parameters<typeof actual.getWorkTimeline>) => {
      const built = await actual.getWorkTimeline(...args);
      const [, teamId, , windowDays] = args;
      if (build.teamId !== null && teamId === build.teamId && (windowDays ?? 0) > actual.WINDOW_DAYS) {
        build.count += 1;
        if (build.during) await build.during(build.count);
      }
      return built;
    },
  };
});

const PENDING = {
  code: "temporarily_unavailable",
  message: "attribution repair is in progress; retry shortly",
};
const TIMELINE_CHANGED = {
  code: "temporarily_unavailable",
  message: "timeline authorization changed; retry the request",
};

/** Committed two days ago: inside both the 7-day and the 30-day window. */
const RECENT = new Date(Date.now() - 2 * 86_400_000).toISOString();
/** The evidence title the long-window fixture credits to the seed member through `items.member_id`. */
const CREDIT_MARKER = "feat: long-window mapped credit marker (LW-1)";

/** A task-linked commit credited (by `items.member_id`) to the ingesting seed member. */
async function mappedCredit(seed: Seed): Promise<void> {
  const anchor = await ingest(seed, {
    kind: "artifact", path: `commits/repo/${randomUUID()}.md`, access: "team",
    body: "seed", frontmatter: { source: "git", committed_at: RECENT },
  });
  const source = await ingest(seed, {
    kind: "deliverable", path: `task-docs/${randomUUID()}.md`, access: "team",
    body: "task source LW-1", frontmatter: { source: "linear" },
  });
  const { error } = await db().from("tasks").insert({
    team_id: seed.teamId, project_id: anchor.projectId, row_key: "LW-1", title: "Long window rollout",
    assignee: "Tester", status: "in_progress", audience: "team", origin: "sync", source_item_id: source.id,
  });
  if (error) throw new Error(error.message);
  await ingest(seed, {
    kind: "artifact", path: `commits/repo/${randomUUID()}.md`, access: "team",
    body: CREDIT_MARKER, frontmatter: { source: "git", committed_at: RECENT },
  });
}

async function repairStatus(seed: Seed): Promise<string> {
  const { rows } = await getPool().query<{ repair_status: string }>(
    `select repair_status from team_identity_authority where team_id=$1`, [seed.teamId]);
  return rows[0]?.repair_status ?? "complete";
}

async function sessionMember(fixtures?: (seed: Seed) => Promise<void>) {
  const seed = await seedTeam();
  await ingest(seed, { path: "team.md", body: "team payments", access: "team", project: "src" });
  await fixtures?.(seed);
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  await backfillTeamContext(db(), seed.teamId);
  await convergeIdentityAttribution(seed);
  const { key } = await issueApiKey(db(), seed.teamId, seed.memberId, "attribution-repair-route-gate");
  const authUserId = randomUUID();
  await getPool().query(`insert into auth_users(id,email) values($1,$2)`, [authUserId, `${randomUUID()}@test.local`]);
  // auth_user_id is not an attribution dependency: this binding leaves the repair complete.
  await getPool().query(`update members set auth_user_id=$1 where id=$2 and team_id=$3`, [authUserId, seed.memberId, seed.teamId]);
  vi.mocked(getSessionUser).mockResolvedValue({ id: authUserId } as Awaited<ReturnType<typeof getSessionUser>>);
  vi.mocked(serverClient).mockResolvedValue(db() as unknown as Awaited<ReturnType<typeof serverClient>>);
  expect(await repairStatus(seed)).toBe("complete");
  return { seed, key };
}

/** A roster change on a team with items: the attribution repair is now pending. */
async function makeRepairPending(seed: Seed): Promise<void> {
  const { error } = await db().from("members").insert({
    team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "Roster change",
    actor_handle: `r-${randomUUID().slice(0, 10)}`, role: "member", tier: "team", status: "active",
  });
  if (error) throw new Error(error.message);
  expect(await repairStatus(seed)).toBe("pending");
}

type Attributed =
  | "dashboard-timeline"
  | "dashboard-timeline-30d"
  | "team-work"
  | "v1-timeline"
  | "events"
  | "arcs"
  | "arcs-recompute";

async function call(route: Attributed | "facts", seed: Seed, key: string): Promise<Response> {
  const q = `team=${encodeURIComponent(seed.teamSlug)}`;
  switch (route) {
    case "dashboard-timeline": {
      const { GET } = await import("@/app/api/dashboard/timeline/route");
      return GET(new Request(`http://test/api/dashboard/timeline?${q}`) as unknown as NextRequest);
    }
    case "dashboard-timeline-30d": {
      // days > 7: the fresh-build arm, which bypasses the cache layer.
      const { GET } = await import("@/app/api/dashboard/timeline/route");
      return GET(new Request(`http://test/api/dashboard/timeline?${q}&days=30`) as unknown as NextRequest);
    }
    case "arcs-recompute": {
      const { POST } = await import("@/app/api/brain/arcs/recompute/route");
      return POST(new Request("http://test/api/brain/arcs/recompute", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          team: seed.teamSlug,
          sourceGroup: `${seed.teamSlug}_team`,
          corrections: [{ arc_id: "arc-1", corrected_text: "the payments work moved" }],
        }),
      }) as unknown as NextRequest);
    }
    case "team-work": {
      const { GET } = await import("@/app/api/dashboard/team-work/route");
      return GET(new Request(`http://test/api/dashboard/team-work?${q}`) as unknown as NextRequest);
    }
    case "v1-timeline": {
      const { GET } = await import("@/app/api/v1/timeline/route");
      return GET(new Request("http://test/api/v1/timeline", {
        headers: { authorization: `Bearer ${key}`, "X-AIOS-Team": seed.teamSlug },
      }) as unknown as NextRequest);
    }
    case "events": {
      const { GET } = await import("@/app/api/brain/events/route");
      return GET(new Request(`http://test/api/brain/events?${q}`) as unknown as NextRequest);
    }
    case "arcs": {
      const { POST } = await import("@/app/api/brain/arcs/route");
      return POST(new Request("http://test/api/brain/arcs", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ team: seed.teamSlug }),
      }) as unknown as NextRequest);
    }
    case "facts": {
      const { GET } = await import("@/app/api/brain/facts/route");
      return GET(new Request(`http://test/api/brain/facts?${q}`) as unknown as NextRequest);
    }
  }
}

beforeEach(() => {
  vi.mocked(getSessionUser).mockReset();
  vi.mocked(serverClient).mockReset();
  build.teamId = null;
  build.during = null;
  build.count = 0;
});

describe("AIO-1167 attribution repair gate at the route boundary (real Postgres)", () => {
  it.each(["dashboard-timeline", "dashboard-timeline-30d", "team-work", "v1-timeline", "events", "arcs", "arcs-recompute"] as const)(
    "%s: a pending repair is a retryable 503, not a 500 and not a stale ledger",
    async (route) => {
      const { seed, key } = await sessionMember();
      await makeRepairPending(seed);

      const res = await call(route, seed, key);

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: { ...PENDING, request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      });
    },
  );

  it.each(["dashboard-timeline", "dashboard-timeline-30d", "team-work", "v1-timeline"] as const)(
    "%s: once the repair converges, the same fixture is served",
    async (route) => {
      const { seed, key } = await sessionMember();
      await makeRepairPending(seed);
      await convergeIdentityAttribution(seed);
      expect(await repairStatus(seed)).toBe("complete");

      const res = await call(route, seed, key);

      expect(res.status).toBe(200);
    },
  );

  it("days>7: a pending link, remap or unlink never serves the stale mapped credit; convergence serves it again", async () => {
    const { seed, key } = await sessionMember(mappedCredit);
    const longWindow = async () => {
      const res = await call("dashboard-timeline-30d", seed, key);
      return { status: res.status, text: await res.text() };
    };
    // Non-vacuous: with the repair complete, the long window really serves the mapped credit.
    const open = await longWindow();
    expect(open.status).toBe(200);
    expect(open.text).toContain(CREDIT_MARKER);

    const mutations: Array<[string, () => Promise<unknown>]> = [
      ["link", () => setMemberIdentity(db(), seed.teamId, seed.memberId, { provider: "slack", externalId: "U_LONG_WINDOW" })],
      // A remap of the member's own mapped email (an attribution key), straight on the row.
      ["remap", () => getPool().query(`update members set email=$1 where id=$2 and team_id=$3`,
        [`${randomUUID()}@test.local`, seed.memberId, seed.teamId])],
      ["unlink", () => removeMemberIdentity(db(), seed.teamId, { provider: "slack", externalId: "U_LONG_WINDOW" })],
    ];
    for (const [name, mutate] of mutations) {
      await mutate();
      expect(await repairStatus(seed), `${name} marks the repair pending`).toBe("pending");

      const fenced = await longWindow();
      expect(fenced.status, name).toBe(503);
      expect(JSON.parse(fenced.text), name).toEqual({ error: { ...PENDING, request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
      expect(fenced.text, name).not.toContain(CREDIT_MARKER);

      await convergeIdentityAttribution(seed);
      const served = await longWindow();
      expect(served.status, name).toBe(200);
      expect(served.text, name).toContain(CREDIT_MARKER);
    }
  });

  it("days>7: a mapping change committed DURING the build is refused at publication, not served", async () => {
    const { seed, key } = await sessionMember(mappedCredit);
    build.teamId = seed.teamId;
    build.during = async (n) => {
      if (n === 1) await setMemberIdentity(db(), seed.teamId, seed.memberId, { provider: "slack", externalId: "U_MID_READ" });
    };

    const res = await call("dashboard-timeline-30d", seed, key);
    const text = await res.text();

    expect(build.count).toBe(1); // the real build ran, read the old credit, and was not published
    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ error: { ...PENDING, request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
    expect(text).not.toContain(CREDIT_MARKER);
  });

  it("days>7: one revocation during the build rebuilds once; a revocation during every build is the retryable 503", async () => {
    const { seed, key } = await sessionMember(mappedCredit);
    build.teamId = seed.teamId;

    build.during = async (n) => {
      if (n === 1) await advanceAuthorizationEpoch(seed.teamId);
    };
    const once = await call("dashboard-timeline-30d", seed, key);
    expect(once.status).toBe(200);
    expect(build.count).toBe(2);
    expect(await once.text()).toContain(CREDIT_MARKER);

    build.count = 0;
    build.during = async () => {
      await advanceAuthorizationEpoch(seed.teamId);
    };
    const churn = await call("dashboard-timeline-30d", seed, key);
    const text = await churn.text();
    expect(build.count).toBe(2);
    expect(churn.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ error: { ...TIMELINE_CHANGED, request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
    expect(text).not.toContain(CREDIT_MARKER);
  });

  it("facts publish no person attribution: a pending repair neither fails nor degrades them", async () => {
    const { seed, key } = await sessionMember();
    await makeRepairPending(seed);

    const res = await call("facts", seed, key);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ degraded: false, stale: false });
  });

  it("the revocation barrier is the same counter, readable while the attribution gate is closed", async () => {
    const { seed } = await sessionMember();
    const open = await authorizationEpoch(db(), seed.teamId);
    // The roster change marks the repair pending AND advances the shared epoch (it is a visibility
    // change too), so the ungated read must observe that advance, not the earlier value.
    await makeRepairPending(seed);
    const { rows } = await getPool().query<{ epoch: string | number }>(
      `select epoch from team_authorization_epochs where team_id=$1`, [seed.teamId]);
    const current = rows[0] ? Number(rows[0].epoch) : 1;

    await expect(authorizationEpoch(db(), seed.teamId)).rejects.toBeInstanceOf(AttributionRepairPendingError);
    expect(await revocationEpoch(db(), seed.teamId)).toBe(current);
    expect(current).toBeGreaterThan(open);
  });
});
