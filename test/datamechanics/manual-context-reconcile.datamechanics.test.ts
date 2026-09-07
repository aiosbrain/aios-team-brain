import { describe, expect, it, beforeEach, vi } from "vitest";

/**
 * AUDITFIX-14 — the manual/admin context reconciliation, against REAL Postgres.
 *
 * `docs/design/auditfix14-manual-context-reconcile.md`. The claim this ticket exists for is an
 * OUTCOME, not a call: after a manual import the newly-imported item is READABLE through the
 * existing permission oracle without waiting for a scheduled tick — and with the poller disabled
 * there is no tick to wait for. So the acceptance evidence has to be a real unit + a real current
 * `include` membership + `canSeeItem` returning true, which the in-memory fake cannot state.
 *
 * WHAT IS REAL HERE: `ingestItem`, the context primitives, the candidate predicate, the permission
 * oracle, the `ingest_runs` ledger and `getPipelineHealth`.
 * WHAT IS STUBBED: the four connector runners (they perform a REAL `ingestItem` and then return a
 * summary — a remote provider is not the subject), the Linear inbound stage, the admin auth guard,
 * `revalidatePath`, and the unrelated heavy imports of the admin actions module.
 *
 * Two narrow SEAMS are installed and are off by default:
 *   • `seams.afterSelection` — runs once immediately after the candidate query returns, so AC14-02
 *     can commit a candidate that the in-flight pass could not have selected.
 *   • `seams.failItemId` — makes ONE item's reconcile fail, so AC14-05 can prove the completed
 *     memberships survive and the failed candidate is retried rather than skipped.
 * Neither is a fake of the thing under test: both wrap the real implementation.
 */

import { db, ingest, seedTeam, type Seed } from "./helpers";
import { GENERAL_SLUG } from "@/lib/access/bootstrap";

type Source = "slack" | "plane" | "linear" | "github";

interface RunCounts {
  ok: boolean;
  integrations: number;
  channels: number;
  projects: number;
  items: number;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  errors: string[];
  skipped?: boolean;
}

const state = vi.hoisted(() => ({
  teamId: "",
  memberId: "",
  /** Per-source: what the stubbed runner writes (real ingest) before returning. */
  writeOnRun: {} as Record<string, (() => Promise<void>) | undefined>,
  /** Per-source: the summary it returns, or "throw" to throw AFTER any write above. */
  result: {} as Record<string, unknown>,
  /** Runs once after the candidate query returns, then disarms itself. */
  afterSelection: null as null | (() => Promise<void>),
  /** Fail exactly this item's reconcile. */
  failItemId: null as string | null,
  /** What the inbound stage does (a synthetic writer — production inbound writes no items). */
  inboundWrite: null as null | (() => Promise<void>),
  inboundThrows: false,
}));

const unconfigured = (): RunCounts => ({
  ok: true,
  integrations: 0,
  channels: 0,
  projects: 0,
  items: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  deleted: 0,
  errors: [],
});

const configuredClean = (over: Partial<RunCounts> = {}): RunCounts => ({
  ...unconfigured(),
  integrations: 1,
  channels: 1,
  projects: 1,
  ...over,
});

function runnerFor(source: Source) {
  return async () => {
    const write = state.writeOnRun[source];
    if (write) await write();
    const r = state.result[source];
    if (r === "throw") throw new Error(`${source}: import threw after writing`);
    return (r as RunCounts | undefined) ?? unconfigured();
  };
}

vi.mock("@/lib/ingest/run", () => ({
  runSlackIngestion: vi.fn(runnerFor("slack")),
  runPlaneIngestion: vi.fn(runnerFor("plane")),
  runLinearIngestion: vi.fn(runnerFor("linear")),
  runGithubIngestion: vi.fn(runnerFor("github")),
}));

vi.mock("@/lib/pm-sync/inbound", () => ({
  runLinearInbound: vi.fn(async () => {
    if (state.inboundWrite) await state.inboundWrite();
    if (state.inboundThrows) throw new Error("inbound: lock held");
    return {
      ok: true,
      teams: 1,
      applied: 0,
      adopted: 0,
      noops: 0,
      conflicts: 0,
      errors: [] as string[],
      skipped: false,
      skippedReasons: [] as string[],
    };
  }),
}));

vi.mock("@/lib/auth/guard", () => ({
  requireTeamAdmin: vi.fn(async () => ({ teamId: state.teamId, memberId: state.memberId })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// The candidate-query seam (AC14-02) — wraps the REAL predicate, never replaces it.
vi.mock("@/lib/projects/context/backfill-candidates", async (orig) => {
  const real = await orig<typeof import("@/lib/projects/context/backfill-candidates")>();
  return {
    ...real,
    selectCandidateItemIds: async (teamId: string, opts: Parameters<typeof real.selectCandidateItemIds>[1]) => {
      const page = await real.selectCandidateItemIds(teamId, opts);
      const hook = state.afterSelection;
      state.afterSelection = null;
      if (hook) await hook();
      return page;
    },
  };
});

// The per-item reconcile seam (AC14-05) — one item fails, everything else is the real reconcile.
vi.mock("@/lib/projects/context/reconcile-item", async (orig) => {
  const real = await orig<typeof import("@/lib/projects/context/reconcile-item")>();
  return {
    ...real,
    reconcileItemContext: async (...args: Parameters<typeof real.reconcileItemContext>) => {
      if (state.failItemId && args[2] === state.failItemId) {
        return { ok: false, error: "injected reconcile failure" };
      }
      return real.reconcileItemContext(...args);
    },
  };
});

// Unrelated heavy imports of the admin actions module — none of these actions is exercised here.
vi.mock("@/lib/graph/run", () => ({ runGraphProjection: vi.fn() }));
vi.mock("@/lib/graph/projection-run", () => ({
  projectionRunInput: vi.fn(),
  shouldRecordProjectionRun: vi.fn(() => false),
}));
vi.mock("@/lib/integrations/github-estimate", () => ({ estimateGithubImport: vi.fn() }));
vi.mock("@/lib/metrics/graph-efficiency", () => ({ getGraphEfficiency: vi.fn() }));
vi.mock("@/lib/integrations/github-validate", () => ({ validateGithubToken: vi.fn(), checkRepoAccess: vi.fn() }));
vi.mock("@/lib/integrations/slack-validate", () => ({ checkSlackChannels: vi.fn(), privateChannelRejection: vi.fn() }));
vi.mock("@/lib/llm/structured-output-support", () => ({
  checkStructuredOutputSupport: vi.fn(),
  structuredOutputWarning: vi.fn(),
}));

import { runManualSync } from "@/lib/ingest/manual-sync";
import {
  syncGithubNow,
  syncLinearNow,
  syncPlaneNow,
  syncSlackNow,
} from "@/app/t/[team]/admin/integrations/actions";
import { canSeeItem } from "@/lib/access/enforce";
import { recordIngestRun } from "@/lib/ingest/runs";
import { getPipelineHealth } from "@/lib/ingest/pipeline-health";
import { readTeamBackfillState } from "@/lib/projects/context/backfill-cursor";
import { runSql } from "@/lib/db/pg/pool";

/* ────────────────────────────── fixtures ────────────────────────────── */

const MIN = 60_000;

async function useTeam(): Promise<Seed> {
  const seed = await seedTeam();
  state.teamId = seed.teamId;
  state.memberId = seed.memberId;
  return seed;
}

/** A stubbed provider run that performs ONE real `ingestItem`, then reports `counts`. */
function importsOneItem(seed: Seed, source: Source, path: string, counts: RunCounts | "throw" = configuredClean({ created: 1 })) {
  state.writeOnRun[source] = async () => {
    await ingest(seed, { path, body: `body of ${path}`, access: "team", project: "src" });
  };
  state.result[source] = counts;
}

async function unitOf(teamId: string, itemId: string) {
  const { data } = await db()
    .from("project_context_units")
    .select("id, state, audience, unit_kind")
    .eq("team_id", teamId)
    .eq("source_item_id", itemId)
    .maybeSingle();
  return data as { id: string; state: string; audience: string; unit_kind: string } | null;
}

async function currentMemberships(teamId: string, unitId: string) {
  const { data } = await db()
    .from("project_context_memberships")
    .select("id, project_id, decision, mode, method, valid_to")
    .eq("team_id", teamId)
    .eq("context_unit_id", unitId)
    .is("valid_to", null);
  return (data ?? []) as { id: string; project_id: string; decision: string; mode: string; method: string }[];
}

/**
 * A FULL-ROW snapshot of one unit and its whole membership history — what AC14-06's "untouched"
 * claim actually needs. The projections above hide the fields a regression would move: a changed
 * `updated_at`/`content_sha256`/`audience` on the unit, a re-decided `decided_by`, a replaced row
 * with a new `id`, or a historical generation being closed/reopened. Historical rows are INCLUDED
 * (no `valid_to` filter) and ordered by primary key so the comparison is deterministic.
 *
 * A read error THROWS rather than degrading to null/[]: "the query failed" must never be able to
 * read as "nothing changed".
 */
interface UnitSnapshot {
  unit: Record<string, unknown> | null;
  memberships: Record<string, unknown>[];
}

async function snapshotUnit(teamId: string, unitId: string): Promise<UnitSnapshot> {
  const u = await db()
    .from("project_context_units")
    .select("*")
    .eq("team_id", teamId)
    .eq("id", unitId)
    .maybeSingle();
  if (u.error) throw new Error(`unit snapshot failed: ${u.error.message}`);
  const m = await db()
    .from("project_context_memberships")
    .select("*")
    .eq("team_id", teamId)
    .eq("context_unit_id", unitId)
    .order("id", { ascending: true });
  if (m.error) throw new Error(`membership snapshot failed: ${m.error.message}`);
  return {
    unit: (u.data ?? null) as Record<string, unknown> | null,
    memberships: (m.data ?? []) as Record<string, unknown>[],
  };
}

async function generalProject(teamId: string): Promise<string> {
  const { data } = await db()
    .from("projects")
    .select("id")
    .eq("team_id", teamId)
    .eq("kind", "system")
    .eq("slug", GENERAL_SLUG)
    .single();
  return (data as { id: string }).id;
}

async function itemIdByPath(teamId: string, path: string): Promise<string> {
  const { data } = await db().from("items").select("id").eq("team_id", teamId).eq("path", path).single();
  return (data as { id: string }).id;
}

const asArray = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : typeof v === "string" ? (JSON.parse(v) as unknown[]) : [];
const asObject = (v: unknown): Record<string, unknown> =>
  typeof v === "string" ? (JSON.parse(v) as Record<string, unknown>) : ((v ?? {}) as Record<string, unknown>);

interface LedgerRow {
  id: number;
  source: string;
  trigger: string;
  ok: boolean;
  created: number;
  errors: unknown[];
  meta: Record<string, unknown>;
}

async function ledgerRows(teamId: string, source = "context_backfill", trigger = "manual"): Promise<LedgerRow[]> {
  const { data } = await db()
    .from("ingest_runs")
    .select("id, source, trigger, ok, created, errors, meta")
    .eq("team_id", teamId)
    .eq("source", source)
    .eq("trigger", trigger)
    .order("id", { ascending: true });
  return ((data ?? []) as LedgerRow[]).map((r) => ({
    ...r,
    errors: asArray(r.errors),
    meta: asObject(r.meta),
  }));
}

/** The team's newest SCHEDULER-triggered finish for a source — the staleness clock's own read. */
async function schedulerBeat(teamId: string, source = "context_backfill"): Promise<string | null> {
  const res = await runSql<{ finished_at: string }>(
    `select finished_at from ingest_runs
      where team_id = $1 and source = $2 and trigger = 'scheduler'
      order by finished_at desc, id desc limit 1`,
    [teamId, source]
  );
  return res.rows[0]?.finished_at ?? null;
}

/** The five real entry points, each with the connector whose stub does the import. */
const ENTRY_POINTS: { name: string; source: Source; run: (seed: Seed) => Promise<unknown>; entrypoint: string }[] = [
  { name: "chat /sync", source: "slack", run: (s) => runManualSync(s.teamId), entrypoint: "manual_sync" },
  { name: "admin Slack Run now", source: "slack", run: (s) => syncSlackNow(s.teamSlug), entrypoint: "slack" },
  { name: "admin Plane Run now", source: "plane", run: (s) => syncPlaneNow(s.teamSlug), entrypoint: "plane" },
  { name: "admin Linear Run now", source: "linear", run: (s) => syncLinearNow(s.teamSlug), entrypoint: "linear" },
  { name: "admin GitHub Run now", source: "github", run: (s) => syncGithubNow(s.teamSlug), entrypoint: "github" },
];

beforeEach(() => {
  state.writeOnRun = {};
  state.result = {};
  state.afterSelection = null;
  state.failItemId = null;
  state.inboundWrite = null;
  state.inboundThrows = false;
  state.teamId = "";
  state.memberId = "";
});

/* ────────────────────────── AC14-01 — five real entry points ────────────────────────── */

describe.each(ENTRY_POINTS)("AC14-01 — $name partitions its own import", ({ source, run, entrypoint }) => {
  it("the freshly-imported item ends up readable through the existing oracle", async () => {
    const seed = await useTeam();
    const other = await seedTeam();
    await ingest(other, { path: "other/secret.md", body: "other team", access: "team", project: "src" });

    importsOneItem(seed, source, "fresh/item.md");

    await run(seed);

    const itemId = await itemIdByPath(seed.teamId, "fresh/item.md");
    const unit = await unitOf(seed.teamId, itemId);
    expect(unit, "the entry point must have reconciled the item's unit").not.toBeNull();
    expect(unit!.unit_kind).toBe("item");
    expect(unit!.state).toBe("active");

    const general = await generalProject(seed.teamId);
    const current = await currentMemberships(seed.teamId, unit!.id);
    expect(current.map((m) => m.project_id), "a team item lands in General and nowhere else").toEqual([general]);
    expect(current[0].decision).toBe("include");

    expect(
      await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, itemId),
      "the authorized principal can read it without waiting for a tick"
    ).toBe(true);

    // The other team is untouched — no unit, no membership, and not readable from this team.
    const otherItemId = await itemIdByPath(other.teamId, "other/secret.md");
    expect(await unitOf(other.teamId, otherItemId), "a manual pass is one team's pass").toBeNull();
    expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, otherItemId)).toBe(false);

    // …and the pass is on the record under its own entrypoint, with the DURABLE progress this
    // fixture must produce. The numbers are read off the fixture, not off the returned outcome:
    // exactly one candidate existed (one item, freshly imported, never partitioned), so the page
    // is one item long — short of the 25 limit, hence a drained `cursor: null`.
    const rows = await ledgerRows(seed.teamId);
    expect(rows).toHaveLength(1);
    expect(rows[0].meta.entrypoint).toBe(entrypoint);
    expect(rows[0].meta.status).toBe("complete");
    expect(rows[0].ok).toBe(true);
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].created, "`created` is memberships created").toBe(1);
    expect(rows[0].meta.scanned).toBe(1);
    expect(rows[0].meta.unitsCreated).toBe(1);
    expect(rows[0].meta.membershipsCreated).toBe(1);
    expect(rows[0].meta.cursor, "a short page drained the candidate query").toBeNull();
  }, 60_000);
});

/* ────────────────────────── AC14-02 — sequencing and selection ────────────────────────── */

describe("AC14-02 — one pass, after everything settles, over what it could select", () => {
  it("covers the LAST provider write and the inbound-stage write, even though a leg failed", async () => {
    const seed = await useTeam();
    // Slack fails outright; GitHub (the last leg) writes; the inbound stage writes too.
    state.result.slack = { ...configuredClean(), ok: false, errors: ["slack: token revoked"] };
    importsOneItem(seed, "linear", "linear/item.md");
    importsOneItem(seed, "github", "github/late.md");
    state.inboundWrite = async () => {
      await ingest(seed, { path: "inbound/adopted.md", body: "adopted", access: "team", project: "src" });
    };

    await runManualSync(seed.teamId);

    for (const path of ["linear/item.md", "github/late.md", "inbound/adopted.md"]) {
      const id = await itemIdByPath(seed.teamId, path);
      const unit = await unitOf(seed.teamId, id);
      expect(unit, `${path} must be reconciled by the single pass`).not.toBeNull();
      expect(
        await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, id),
        `${path} must be readable`
      ).toBe(true);
    }
    // ONE pass, not one per leg.
    expect(await ledgerRows(seed.teamId)).toHaveLength(1);
  }, 60_000);

  it("a FUTURE-DATED eligible item is reconciled — the pass takes no clock cutoff", async () => {
    const seed = await useTeam();
    importsOneItem(seed, "slack", "future/item.md");
    state.writeOnRun.slack = async () => {
      const r = await ingest(seed, { path: "future/item.md", body: "ahead of the clock", access: "team", project: "src" });
      await runSql(`update items set created_at = now() + interval '1 day' where id = $1`, [r.id]);
    };

    await runManualSync(seed.teamId);

    const id = await itemIdByPath(seed.teamId, "future/item.md");
    expect(await unitOf(seed.teamId, id), "a Postgres-clock cutoff would have excluded this row").not.toBeNull();
    expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, id)).toBe(true);
  }, 60_000);

  it("a candidate committed AFTER the selection may wait for the next pass, and the response says so", async () => {
    const seed = await useTeam();
    importsOneItem(seed, "slack", "early/item.md");
    state.afterSelection = async () => {
      await ingest(seed, { path: "late/item.md", body: "arrived mid-pass", access: "team", project: "src" });
    };

    const r = (await runManualSync(seed.teamId)) as { summary: string };

    const early = await itemIdByPath(seed.teamId, "early/item.md");
    expect(await unitOf(seed.teamId, early)).not.toBeNull();
    const late = await itemIdByPath(seed.teamId, "late/item.md");
    expect(await unitOf(seed.teamId, late), "committed after the snapshot — next pass's work").toBeNull();
    // The response must not claim the whole corpus is covered.
    expect(r.summary).not.toMatch(/\b(all|every|everything)\b[^.]{0,40}\bvisible\b/i);

    // A second manual run picks it up with no scheduler involvement.
    state.writeOnRun.slack = undefined;
    state.result.slack = configuredClean();
    await runManualSync(seed.teamId);
    expect(await unitOf(seed.teamId, late)).not.toBeNull();
    expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, late)).toBe(true);
  }, 60_000);
});

/* ────────────────────────── AC14-03 — bounded progress ────────────────────────── */

describe("AC14-03 — 26 candidates, 25 per pass, progress without a scheduler", () => {
  it("the first pass reconciles at most 25 and reports pending; a second finishes it", async () => {
    const seed = await useTeam();
    for (let i = 0; i < 26; i++) {
      await ingest(seed, { path: `backlog/${String(i).padStart(2, "0")}.md`, body: `b${i}`, access: "team", project: "src" });
    }
    // Imports report ZERO changes: an empty import must not gate the reconciliation.
    state.result.slack = configuredClean({ created: 0, updated: 0, unchanged: 3 });

    const first = (await runManualSync(seed.teamId)) as { summary: string };

    const rows1 = await ledgerRows(seed.teamId);
    expect(rows1).toHaveLength(1);
    expect(rows1[0].meta.status).toBe("pending");
    expect(rows1[0].meta.scanned).toBe(25);
    expect(rows1[0].ok, "a bounded pass is not a failure").toBe(true);
    expect(rows1[0].errors).toEqual([]);
    expect(first.summary).toMatch(/more project-context work may remain/i);
    expect(first.summary).not.toMatch(/\b(all|every|everything)\b[^.]{0,40}\bvisible\b/i);

    const { rows: after1 } = await runSql<{ n: string }>(
      `select count(*)::text as n from project_context_units where team_id = $1`,
      [seed.teamId]
    );
    expect(Number(after1[0].n), "exactly the page, no more").toBe(25);

    const second = (await runManualSync(seed.teamId)) as { summary: string };

    const rows2 = await ledgerRows(seed.teamId);
    expect(rows2).toHaveLength(2);
    expect(rows2[1].meta.status).toBe("complete");
    expect(rows2[1].meta.scanned).toBe(1);
    expect(second.summary).not.toMatch(/more project-context work may remain/i);

    const { rows: after2 } = await runSql<{ n: string }>(
      `select count(*)::text as n from project_context_units where team_id = $1`,
      [seed.teamId]
    );
    expect(Number(after2[0].n)).toBe(26);

    // No scheduler ran: the progress came entirely from the two manual attempts.
    const { rows: sched } = await runSql<{ n: string }>(
      `select count(*)::text as n from ingest_runs where team_id = $1 and trigger = 'scheduler'`,
      [seed.teamId]
    );
    expect(Number(sched[0].n)).toBe(0);
  }, 180_000);
});

/* ────────────────────────── AC14-04 — partial / throw / busy ────────────────────────── */

describe("AC14-04 — committed items become readable even when the import reports failure", () => {
  it("a provider that WRITES and then returns errors still leaves its item readable", async () => {
    const seed = await useTeam();
    importsOneItem(seed, "plane", "partial/item.md", {
      ...configuredClean({ created: 1 }),
      ok: false,
      errors: ["plane: project 2 of 3 failed"],
    });

    const res = (await syncPlaneNow(seed.teamSlug)) as { ok: boolean; error?: string };

    const id = await itemIdByPath(seed.teamId, "partial/item.md");
    expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, id)).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.error, "the original provider diagnostic survives").toContain("project 2 of 3 failed");
  }, 60_000);

  it("a provider that WRITES and then THROWS still leaves its item readable", async () => {
    const seed = await useTeam();
    importsOneItem(seed, "github", "thrown/item.md", "throw");

    const res = (await syncGithubNow(seed.teamSlug)) as { ok: boolean; error?: string };

    const id = await itemIdByPath(seed.teamId, "thrown/item.md");
    expect(
      await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, id),
      "a throw is not proof that nothing was committed"
    ).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("import threw after writing");
    expect((await ledgerRows(seed.teamId))[0].meta.status).toBe("complete");
  }, 60_000);

  it("a SKIPPED provider still runs the pass over the older backlog", async () => {
    const seed = await useTeam();
    await ingest(seed, { path: "old/backlog.md", body: "older than this run", access: "team", project: "src" });
    state.result.linear = { ...unconfigured(), skipped: true };

    const res = (await syncLinearNow(seed.teamSlug)) as { ok: boolean; error?: string };

    const id = await itemIdByPath(seed.teamId, "old/backlog.md");
    expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, id)).toBe(true);
    expect(res.ok, "a skipped import is not a successful one").toBe(false);
    expect(res.error).toMatch(/skipped|already running/i);
  }, 60_000);
});

/* ────────────────────────── AC14-05 — failure and recovery ────────────────────────── */

describe("AC14-05 — a failing candidate blocks progress at itself, not the whole operation", () => {
  it("the completed membership survives, the failed candidate remains, and a later run reconciles it", async () => {
    const seed = await useTeam();
    const a = await ingest(seed, { path: "pair/a.md", body: "a", access: "team", project: "src" });
    const b = await ingest(seed, { path: "pair/b.md", body: "b", access: "team", project: "src" });
    // The sweep walks in `id` order, so the SECOND id is the one that fails after a success.
    const [firstId, secondId] = [a.id, b.id].sort();
    state.failItemId = secondId;
    state.result.slack = configuredClean({ created: 0 });

    const r = (await runManualSync(seed.teamId)) as { summary: string; errors: number };

    expect(await unitOf(seed.teamId, firstId), "work done before the failure is kept").not.toBeNull();
    expect(
      await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, firstId),
      "no whole-operation rollback"
    ).toBe(true);
    expect(await unitOf(seed.teamId, secondId), "the failing candidate is NOT skipped past").toBeNull();
    expect(r.summary).toMatch(/imported data was kept/i);
    expect(r.errors, "a failed context pass is one issue").toBeGreaterThanOrEqual(1);

    // The DURABLE record of a partial failure: one candidate reconciled before the fault, and the
    // cursor parked on THAT item — not on the failing one, which a resume must retry rather than
    // step over. All four numbers are fixture facts (two candidates, the second one faulted).
    const failedRow = (await ledgerRows(seed.teamId))[0];
    expect(failedRow.ok).toBe(false);
    expect(failedRow.meta.status).toBe("failed");
    expect(failedRow.errors, "the failing item's id prefixes its own diagnostic").toEqual([
      `${secondId}: injected reconcile failure`,
    ]);
    expect(failedRow.created, "`created` is memberships created").toBe(1);
    expect(failedRow.meta.scanned).toBe(1);
    expect(failedRow.meta.unitsCreated).toBe(1);
    expect(failedRow.meta.membershipsCreated).toBe(1);
    expect(failedRow.meta.cursor, "the last item that FULLY succeeded, so the retry lands on the failure").toBe(
      firstId
    );

    // Recovery: with the fault cleared, a later manual run retries the item it stopped on.
    state.failItemId = null;
    await runManualSync(seed.teamId);
    expect(await unitOf(seed.teamId, secondId)).not.toBeNull();
    expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, secondId)).toBe(true);
    expect((await ledgerRows(seed.teamId))[1].meta.status).toBe("complete");
  }, 60_000);
});

/* ────────────────────────── AC14-06 — standing decisions ────────────────────────── */

describe("AC14-06 — the manual repair honours the same standing decisions the sweep does", () => {
  it("a human's explicit exclude, a retracted unit and another team's rows all survive a manual pass", async () => {
    const seed = await useTeam();
    const other = await seedTeam();

    // Other team: fully partitioned first, so we can prove its rows are untouched.
    await ingest(other, { path: "o/keep.md", body: "keep", access: "team", project: "src" });
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    expect((await backfillTeamContext(db(), other.teamId)).ok).toBe(true);
    const otherItem = await itemIdByPath(other.teamId, "o/keep.md");
    const otherUnit = await unitOf(other.teamId, otherItem);
    const otherBefore = await currentMemberships(other.teamId, otherUnit!.id);

    // This team: one item carrying an OPERATOR's explicit exclude, one with a retracted unit,
    // and one ordinary candidate the pass is expected to repair.
    const forced = await ingest(seed, { path: "s/forced.md", body: "forced", access: "team", project: "src" });
    const retracted = await ingest(seed, { path: "s/retracted.md", body: "retracted", access: "team", project: "src" });
    expect((await backfillTeamContext(db(), seed.teamId)).ok).toBe(true);
    const general = await generalProject(seed.teamId);

    const forcedUnit = (await unitOf(seed.teamId, forced.id))!;
    await db()
      .from("project_context_memberships")
      .update({ valid_to: new Date().toISOString() })
      .eq("team_id", seed.teamId)
      .eq("project_id", general)
      .eq("context_unit_id", forcedUnit.id)
      .is("valid_to", null);
    const planted = await db().from("project_context_memberships").insert({
      team_id: seed.teamId,
      project_id: general,
      context_unit_id: forcedUnit.id,
      decision: "exclude",
      mode: "force_exclude",
      method: "manual",
    });
    expect(planted.error).toBeNull();

    const retractedUnit = (await unitOf(seed.teamId, retracted.id))!;
    await db().from("project_context_units").update({ state: "retracted" }).eq("id", retractedUnit.id);

    // The EXACT rows the pass must leave alone — every column, every membership generation — taken
    // after the fixture is fully planted and before the entry point runs.
    const forcedSnapshot = await snapshotUnit(seed.teamId, forcedUnit.id);
    const retractedSnapshot = await snapshotUnit(seed.teamId, retractedUnit.id);
    const otherSnapshot = await snapshotUnit(other.teamId, otherUnit!.id);
    // Non-vacuity: an empty/short snapshot would make "unchanged" prove nothing.
    expect(forcedSnapshot.memberships, "the closed auto include, then the planted force_exclude").toHaveLength(2);
    expect(retractedSnapshot.memberships).toHaveLength(1);
    expect(retractedSnapshot.unit!.state).toBe("retracted");
    expect(otherSnapshot.memberships).toHaveLength(1);

    // Fixture validation: both are already denied to the principal, so the after-call denials below
    // are about the pass not REVIVING them.
    const principal = { teamId: seed.teamId, memberId: seed.memberId };
    expect(await canSeeItem(db(), principal, forced.id), "the exclusion denies before the pass").toBe(false);
    expect(await canSeeItem(db(), principal, retracted.id), "the retraction denies before the pass").toBe(false);

    // A fresh import arrives; the manual pass must repair IT without touching the two above.
    importsOneItem(seed, "slack", "s/fresh.md");
    const res = (await syncSlackNow(seed.teamSlug)) as { ok: boolean; message?: string; error?: string };

    const freshId = await itemIdByPath(seed.teamId, "s/fresh.md");
    expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, freshId)).toBe(true);
    expect(res.ok, "eligible candidates all done → complete").toBe(true);

    const forcedAfter = await currentMemberships(seed.teamId, forcedUnit.id);
    expect(forcedAfter, "a recorded human decision is not repaired away").toEqual([
      expect.objectContaining({ decision: "exclude", mode: "force_exclude", method: "manual" }),
    ]);

    const retractedAfter = await unitOf(seed.teamId, retracted.id);
    expect(retractedAfter!.state, "a retracted unit is outside the pass, not revived by it").toBe("retracted");

    expect(await currentMemberships(other.teamId, otherUnit!.id), "another team's rows are untouched").toEqual(
      otherBefore
    );

    // The whole rows, not a projection: no column moved, no generation was closed or added, and no
    // row was replaced by an equivalent-looking one with a new identity.
    expect(
      await snapshotUnit(seed.teamId, forcedUnit.id),
      "the force-excluded unit and its full membership history are byte-identical"
    ).toEqual(forcedSnapshot);
    expect(
      await snapshotUnit(seed.teamId, retractedUnit.id),
      "the retracted unit and its full membership history are byte-identical"
    ).toEqual(retractedSnapshot);
    expect(await snapshotUnit(other.teamId, otherUnit!.id), "another team's full rows are byte-identical").toEqual(
      otherSnapshot
    );

    // …and neither protected item became readable.
    expect(await canSeeItem(db(), principal, forced.id), "a standing exclusion is not repaired into a read").toBe(
      false
    );
    expect(await canSeeItem(db(), principal, retracted.id), "a retracted unit is not revived into a read").toBe(
      false
    );
  }, 90_000);
});

/* ────────────────────────── AC14-07 — the ledger and its consumers ────────────────────────── */

describe("AC14-07 — the persisted row, and what pipeline health makes of it", () => {
  /** A scheduler heartbeat for this team so staleness cannot be what moves the leg. */
  async function seedSchedulerBeat(teamId: string, opts: { ok?: boolean; at?: number; cursor?: string | null } = {}) {
    await recordIngestRun(db(), {
      teamId,
      source: "context_backfill",
      trigger: "scheduler",
      ok: opts.ok ?? true,
      created: 0,
      errors: opts.ok === false ? ["scheduler leg failed"] : undefined,
      meta: { cursor: opts.cursor ?? null, scanned: 0 },
      startedAt: opts.at ?? Date.now(),
      finishedAt: opts.at ?? Date.now(),
    });
  }

  it("routine PENDING work is ok:true and creates no pipeline failure", async () => {
    const seed = await useTeam();
    await seedSchedulerBeat(seed.teamId);
    for (let i = 0; i < 26; i++) {
      await ingest(seed, { path: `p/${String(i).padStart(2, "0")}.md`, body: `p${i}`, access: "team", project: "src" });
    }
    await runManualSync(seed.teamId);

    const rows = await ledgerRows(seed.teamId);
    expect(rows[0].ok).toBe(true);
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].meta.status).toBe("pending");
    expect(rows[0].created, "`created` is memberships created").toBe(25);

    const health = await getPipelineHealth(seed.teamId);
    const leg = health.legs.find((l) => l.source === "context_backfill");
    expect(leg?.ok, "a bounded pass is not an outage").toBe(true);
    expect(health.failing.map((l) => l.source)).not.toContain("context_backfill");
  }, 180_000);

  it("one failed pass is UNCONFIRMED; two consecutive failures put the leg in `failing`", async () => {
    const seed = await useTeam();
    await seedSchedulerBeat(seed.teamId);
    const item = await ingest(seed, { path: "f/one.md", body: "one", access: "team", project: "src" });
    state.failItemId = item.id;
    state.result.slack = configuredClean();

    await runManualSync(seed.teamId);
    const afterOne = await getPipelineHealth(seed.teamId);
    const legOne = afterOne.legs.find((l) => l.source === "context_backfill");
    expect(legOne?.ok).toBe(false);
    expect(legOne?.failureClass).toBe("unconfirmed");
    expect(legOne?.error).toContain("injected reconcile failure");
    expect(afterOne.failing.map((l) => l.source)).not.toContain("context_backfill");

    await runManualSync(seed.teamId);
    const afterTwo = await getPipelineHealth(seed.teamId);
    expect(afterTwo.legs.find((l) => l.source === "context_backfill")?.failureClass).toBe("confirmed");
    expect(afterTwo.failing.map((l) => l.source)).toContain("context_backfill");
  }, 90_000);

  it("a successful PENDING manual row breaks a SCHEDULER failure streak without refreshing the beat", async () => {
    const seed = await useTeam();
    const now = Date.now();
    await seedSchedulerBeat(seed.teamId, { ok: true, at: now - 90 * MIN, cursor: "scheduler-cursor-1" });
    await seedSchedulerBeat(seed.teamId, { ok: false, at: now - 60 * MIN, cursor: "scheduler-cursor-1" });
    await seedSchedulerBeat(seed.teamId, { ok: false, at: now - 30 * MIN, cursor: "scheduler-cursor-1" });

    const before = await getPipelineHealth(seed.teamId);
    expect(before.legs.find((l) => l.source === "context_backfill")?.failureClass).toBe("confirmed");
    const beatBefore = await schedulerBeat(seed.teamId);

    for (let i = 0; i < 26; i++) {
      await ingest(seed, { path: `s/${String(i).padStart(2, "0")}.md`, body: `s${i}`, access: "team", project: "src" });
    }
    await runManualSync(seed.teamId);

    const rows = await ledgerRows(seed.teamId);
    expect(rows[0].meta.status, "the bounded pass succeeded, though backlog remains").toBe("pending");
    const after = await getPipelineHealth(seed.teamId);
    expect(after.legs.find((l) => l.source === "context_backfill")?.ok).toBe(true);
    expect(after.failing.map((l) => l.source)).not.toContain("context_backfill");

    expect(
      await schedulerBeat(seed.teamId),
      "a manual row is not evidence the poller ticked — the staleness clock must not move"
    ).toBe(beatBefore);
  }, 180_000);

  it("an existing scheduler cursor is unchanged by manual passes", async () => {
    const seed = await useTeam();
    await seedSchedulerBeat(seed.teamId, { cursor: "scheduler-cursor-1" });
    await ingest(seed, { path: "c/one.md", body: "one", access: "team", project: "src" });

    await runManualSync(seed.teamId);
    await syncSlackNow(seed.teamSlug);

    const stateAfter = await readTeamBackfillState(db(), seed.teamId);
    expect(stateAfter.cursor, "the manual pass must not consume or overwrite the scheduler's resume point").toBe(
      "scheduler-cursor-1"
    );
  }, 60_000);

  it("the manual row is written under the declared leg source and the literal manual trigger", async () => {
    const seed = await useTeam();
    await ingest(seed, { path: "l/one.md", body: "one", access: "team", project: "src" });
    await syncGithubNow(seed.teamSlug);

    const { rows } = await runSql<{ source: string; trigger: string; team_id: string }>(
      `select source, trigger, team_id from ingest_runs where team_id = $1`,
      [seed.teamId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("context_backfill");
    expect(rows[0].trigger).toBe("manual");
    expect(rows[0].team_id, "team-partitioned, never instance-wide").toBe(seed.teamId);
  }, 60_000);

  it("NON-VACUITY: a team with no manual run has no manual context row, so the reads above discriminate", async () => {
    const empty = await seedTeam();
    expect(await ledgerRows(empty.teamId)).toEqual([]);
    expect(await schedulerBeat(empty.teamId)).toBeNull();
  });
});
