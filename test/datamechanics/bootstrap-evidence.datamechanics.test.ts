import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { db, seedTeam, type Seed } from "./helpers";
import type { DbClient } from "@/lib/db/types";

/**
 * AUDITFIX-25 (AIO-1062) — accepted spec v3.2, the REAL-LEDGER half.
 *
 * What the base does, and what this file reds on:
 *   - the outcome carries ONE error and a census error REPLACES a simultaneous convergence error;
 *   - the census summary is pre-clamped to 200 characters before anything can budget it;
 *   - the callback writes no structured metadata, so a failed row has nothing to disclose;
 *   - a hostile message (NUL, an unpaired surrogate) makes the jsonb insert fail, and the best-effort
 *     writer swallows that — the team's row is LOST;
 *   - an empty returned/thrown message is falsy and turns a failed phase GREEN;
 *   - a fleet-level read error or throw is copied verbatim into `team_id is null` rows, which every
 *     team's reader merges in.
 *
 * Everything here goes producer → real jsonb → reader. Nothing is a fabricated envelope: that is the
 * panel unit file's job (malformed/future/legacy), and the pure builder's budgets get their own file.
 *
 * The reference shapes and the budget oracle are declared LOCALLY from the spec's tables: expected
 * values never come from `lib/access/bootstrap-evidence`. That module is imported for exactly two
 * things, both added once it existed (the checkpointed behavioural reds above predate it and did not
 * import it, so a missing module could not hide them behind a collection error):
 *   - its ordinary `buildBootstrapEvidence` export, wrapped PASS-THROUGH, so one criterion can make
 *     the real builder genuinely throw and pin the caller's third guard — no production fault flag;
 *   - its real `decodeBootstrapEvidence`, applied to rows the real reader returned.
 */

const real = vi.hoisted(() => ({
  groups: null as null | typeof import("@/lib/access/groups"),
  evidence: null as null | typeof import("@/lib/access/bootstrap-evidence"),
}));

// PASS-THROUGH as well: the REAL builder runs for every team unless the builder-fault criteria
// override it. The extractor and the decoder are never replaced.
vi.mock("@/lib/access/bootstrap-evidence", async (orig) => {
  const actual = await orig<typeof import("@/lib/access/bootstrap-evidence")>();
  real.evidence = actual;
  return { ...actual, buildBootstrapEvidence: vi.fn(actual.buildBootstrapEvidence) };
});

// PASS-THROUGH wrappers, not stubs: both run the real implementation unless one criterion overrides
// them for ONE team. They exist for the two shapes no database fault can produce — a returned result
// whose `error` is absent, non-string or a throwing accessor — and to record visit order.
vi.mock("@/lib/access/groups", async (orig) => {
  const actual = await orig<typeof import("@/lib/access/groups")>();
  real.groups = actual;
  return {
    ...actual,
    ensureBuiltins: vi.fn(actual.ensureBuiltins),
    censusTeamSystemEdges: vi.fn(actual.censusTeamSystemEdges),
  };
});

import { censusTeamSystemEdges, createGroup, ensureBuiltins } from "@/lib/access/groups";
import { ensureAccessBootstrap, ensureAccessBootstrapAllTeams, EXTERNAL_SHARED_SLUG, GENERAL_SLUG } from "@/lib/access/bootstrap";
import { runAccessBootstrapLeg } from "@/lib/ingest/access-bootstrap-leg";
import { listRecentIngestRuns } from "@/lib/ingest/runs";
import { getPipelineHealth } from "@/lib/ingest/pipeline-health";
import { legDetail, RAW_ERROR_CLIP } from "@/lib/ingest/leg-detail";
import { IngestRunsPanel } from "@/components/admin/ingest-runs-panel";
import { buildBootstrapEvidence, decodeBootstrapEvidence } from "@/lib/access/bootstrap-evidence";

afterEach(() => {
  vi.mocked(ensureBuiltins).mockReset();
  vi.mocked(ensureBuiltins).mockImplementation(real.groups!.ensureBuiltins);
  vi.mocked(censusTeamSystemEdges).mockReset();
  vi.mocked(censusTeamSystemEdges).mockImplementation(real.groups!.censusTeamSystemEdges);
  vi.mocked(buildBootstrapEvidence).mockReset();
  vi.mocked(buildBootstrapEvidence).mockImplementation(real.evidence!.buildBootstrapEvidence);
});

// ── Reference contract (spec §Typed contract and budgets) ────────────────────────────────────────

type PhaseError = { message: string; truncated: boolean };
type Sample = {
  projectId: string;
  groupId: string;
  projectSlug: string;
  groupSlug: string;
  projectSlugTruncated: boolean;
  groupSlugTruncated: boolean;
};
type Evidence = {
  version: 1;
  teamId: string;
  convergence: { status: "ok" | "failed"; error?: PhaseError };
  census: { status: "complete" | "failed"; total: number | null; error?: PhaseError };
  sample: Sample[];
  omitted: number | null;
};
type Outcome = { teamId: string; ok: boolean; error?: string; evidence?: Evidence };
type RawEdge = { projectId: string; projectSlug: string; groupId: string; groupSlug: string };

const BUDGET = {
  metaBytes: 8192,
  samples: 16,
  slugBytes: 96,
  compoundBytes: 480,
  armReserve: 224,
  dualPool: 457, // 480 − `census: ` (8) − `; convergence: ` (15)
  loneCensus: 472, // 480 − `census: `
  loneConvergence: 467, // 480 − `convergence: `
  writerClampChars: 500, // lib/ingest/runs MAX_ERROR_CHARS — must never bite
} as const;
const ELLIPSIS = "…";
/** U+FFFD, built from its code point so the source never carries a literal replacement character. */
const REPLACEMENT = String.fromCodePoint(0xfffd);
const CENSUS_HEAD = (n: number) => `${n} unsanctioned edge(s) on system projects: `;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** NUL and ISOLATED surrogate code units → U+FFFD; a valid pair is preserved. */
function normalize(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) out += REPLACEMENT;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i += 1;
      } else out += REPLACEMENT;
    } else if (c >= 0xdc00 && c <= 0xdfff) out += REPLACEMENT;
    else out += s[i];
  }
  return out;
}

/** Longest code-point prefix that, WITH its cue, fits `max` UTF-8 bytes. */
function clip(s: string, max: number): { text: string; truncated: boolean } {
  if (bytes(s) <= max) return { text: s, truncated: false };
  let out = "";
  let used = bytes(ELLIPSIS);
  for (const cp of s) {
    if (used + bytes(cp) > max) break;
    out += cp;
    used += bytes(cp);
  }
  return { text: out + ELLIPSIS, truncated: true };
}

/** Dual-failure allocation: start each arm at min(full, 224); spend the rest census-first. */
function dualCaps(censusFull: string, convergenceFull: string): { census: number; convergence: number } {
  const c = bytes(censusFull);
  const v = bytes(convergenceFull);
  let census = Math.min(c, BUDGET.armReserve);
  let convergence = Math.min(v, BUDGET.armReserve);
  let spare = BUDGET.dualPool - census - convergence;
  const toCensus = Math.min(spare, c - census);
  census += toCensus;
  spare -= toCensus;
  convergence += Math.min(spare, v - convergence);
  return { census, convergence };
}

/** Full normalized tuple order — slugs first, IDs breaking ties; never the truncated display. */
function ordered(edges: readonly RawEdge[]): RawEdge[] {
  return edges
    .map((e) => ({ ...e, projectSlug: normalize(e.projectSlug), groupSlug: normalize(e.groupSlug) }))
    .sort(
      (a, b) =>
        cmp(a.projectSlug, b.projectSlug) || cmp(a.groupSlug, b.groupSlug) || cmp(a.projectId, b.projectId) || cmp(a.groupId, b.groupId)
    );
}

function display(e: RawEdge): Sample {
  const p = clip(e.projectSlug, BUDGET.slugBytes);
  const g = clip(e.groupSlug, BUDGET.slugBytes);
  return {
    projectId: e.projectId,
    groupId: e.groupId,
    projectSlug: p.text,
    groupSlug: g.text,
    projectSlugTruncated: p.truncated,
    groupSlugTruncated: g.truncated,
  };
}

const wrapperBytes = (evidence: Evidence) => bytes(JSON.stringify({ accessBootstrapEvidence: evidence }));

const compound = (e: Evidence) =>
  [e.census.error ? `census: ${e.census.error.message}` : null, e.convergence.error ? `convergence: ${e.convergence.error.message}` : null]
    .filter((s): s is string => s !== null)
    .join("; ");

/**
 * The spec's state table as an oracle. Inputs are the EXTRACTED phase messages (the extraction table
 * is pinned literally by its own criteria below), so this owns only budgets, order and trimming.
 */
function expectedFor(input: {
  teamId: string;
  convergence: string | null;
  census: { edges: readonly RawEdge[] } | { failed: string };
}): { error: string; evidence: Evidence } {
  const convergenceFull = input.convergence === null ? null : normalize(input.convergence);
  const failed = "failed" in input.census;
  const all = failed ? [] : ordered((input.census as { edges: readonly RawEdge[] }).edges);
  const total = failed ? null : all.length;
  // The error grammar reads the first ≤16 ordered FULL pairs, BEFORE any metadata byte trimming.
  const censusFull = failed
    ? normalize((input.census as { failed: string }).failed)
    : all.length > 0
      ? CENSUS_HEAD(all.length) + all.slice(0, BUDGET.samples).map((e) => `${e.projectSlug}→${e.groupSlug}`).join(", ")
      : null;

  let caps = { census: BUDGET.loneCensus as number, convergence: BUDGET.loneConvergence as number };
  if (censusFull !== null && convergenceFull !== null) caps = dualCaps(censusFull, convergenceFull);
  const censusArm = censusFull === null ? null : clip(censusFull, caps.census);
  const convergenceArm = convergenceFull === null ? null : clip(convergenceFull, caps.convergence);

  const sample = all.slice(0, BUDGET.samples).map(display);
  const evidence: Evidence = {
    version: 1,
    teamId: input.teamId,
    convergence: convergenceArm
      ? { status: "failed", error: { message: convergenceArm.text, truncated: convergenceArm.truncated } }
      : { status: "ok" },
    census: {
      status: failed ? "failed" : "complete",
      total,
      ...(censusArm ? { error: { message: censusArm.text, truncated: censusArm.truncated } } : {}),
    },
    sample,
    omitted: total === null ? null : total - sample.length,
  };
  // Trim from the END of the deterministic order until the ACTUAL serialized wrapper fits.
  while (wrapperBytes(evidence) > BUDGET.metaBytes && evidence.sample.length > 0) {
    evidence.sample.pop();
    evidence.omitted = (total as number) - evidence.sample.length;
  }
  return { error: compound(evidence), evidence };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

/** The base's returned convergence failure for a reserved-slug initiative (lib/access/bootstrap). */
const WEDGE_ERROR = "general: a kind='initiative' project holds reserved slug 'general' — refusing to adopt it";

async function bareTeam(): Promise<Seed> {
  const seed = await seedTeam();
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok, "fixture: bootstrap must converge").toBe(true);
  return seed;
}

async function projectId(seed: Seed, slug: string): Promise<string> {
  const { data } = await db().from("projects").select("id").eq("team_id", seed.teamId).eq("slug", slug).single();
  return (data as { id: string }).id;
}

async function ordinaryGroup(seed: Seed, slug: string): Promise<string> {
  const g = await createGroup(db(), seed.teamId, slug, slug, seed.memberId);
  expect(g.ok, `fixture group '${slug}': ${g.error}`).toBe(true);
  return g.groupId as string;
}

/** A group whose slug the sanctioned writer would never be asked for — `groups.slug` is free `text`. */
async function rawGroup(seed: Seed, slug: string): Promise<string> {
  const { data, error } = await db().from("groups").insert({ team_id: seed.teamId, slug, name: "raw" }).select("id").single();
  expect(error, "fixture: the raw-slug group must insert").toBeNull();
  return (data as { id: string }).id;
}

/** A project planted out of band, as the census suite does — no writer creates these shapes. */
async function rawProject(seed: Seed, slug: string, kind: "system" | "source"): Promise<string> {
  const { data, error } = await db().from("projects").insert({ team_id: seed.teamId, slug, name: "raw", kind }).select("id").single();
  expect(error, `fixture: the ${kind} project must insert`).toBeNull();
  return (data as { id: string }).id;
}

/** Plant an edge the writer would refuse. Out of band on purpose — the writer refuses it. */
async function plant(seed: Seed, project: string, group: string): Promise<void> {
  const { error } = await db().from("project_groups").insert({ team_id: seed.teamId, project_id: project, group_id: group, added_by: null });
  expect(error, "fixture: the forbidden edge must actually be planted").toBeNull();
}

/** Returned convergence failure on a converged team: General becomes a reserved-slug initiative. */
async function wedgeGeneral(seed: Seed): Promise<void> {
  const { error } = await db().from("projects").update({ kind: "initiative" }).eq("team_id", seed.teamId).eq("slug", GENERAL_SLUG);
  expect(error, "fixture: the wedge must apply").toBeNull();
}

/**
 * Twenty findings on ONE hostile system project. The project slug sorts first ('!' precedes every
 * letter) and is enormous — quotes, backslashes, a tab, a newline, an emoji. Each group slug leads with
 * 40 control characters (240 bytes of `\u0001` once serialized) and an emoji run that straddles byte
 * 93, so a byte- or UTF-16-unit cut would split a surrogate pair.
 */
async function hostileFindings(seed: Seed): Promise<void> {
  const project = await rawProject(seed, `!"quoted"\\back\\slash\ttab\nline-😀-${"p".repeat(1500)}`, "system");
  for (let i = 0; i < 20; i++) {
    const slug = `${"\u0001".repeat(40)}"\\${"😀".repeat(20)}-${String(i).padStart(2, "0")}`;
    await plant(seed, project, await rawGroup(seed, slug));
  }
}

/** The real detector's raw result — what the oracle is fed, so it never trusts fixture bookkeeping. */
async function rawFindings(seed: Seed): Promise<RawEdge[]> {
  const census = await real.groups!.censusTeamSystemEdges(db(), seed.teamId);
  expect(census.ok, "fixture: the census itself must read").toBe(true);
  return census.edges;
}

type ReadRule = {
  table: string;
  /** Matched against the WHITESPACE-STRIPPED select spec — `projects (kind, slug)` compiles too. */
  select: (flat: string) => boolean;
  /** Only the statement filtered to this team; omitted = every team. */
  teamId?: string;
  act: { error: unknown } | { throws: unknown } | { transform: (rows: unknown[]) => unknown[] };
};

const CENSUS_SHAPE = (flat: string) => flat.includes("projects(") && flat.includes("groups(");
/** `ensureAccessBootstrap`'s builtin lookup — the one convergence read that returns `gErr.message`. */
const BUILTIN_LOOKUP_SHAPE = (flat: string) => flat === "id,slug";

/**
 * Faults or rewrites ONE read, keyed on table + select shape + team. Writes and every other read go
 * to the real database. Same construction as the census suite's injectors; a table-name key would
 * fire on the writer's existence probes and fail convergence for the wrong reason.
 */
function intercept(rules: ReadRule[]): DbClient {
  const base = db();
  return new Proxy(base as object, {
    get(target, prop, recv) {
      if (prop !== "from") return Reflect.get(target, prop, recv);
      return (name: string) => {
        const q = (target as { from: (n: string) => unknown }).from(name);
        const candidates = rules.filter((r) => r.table === name);
        if (candidates.length === 0) return q;
        let spec = "";
        let team: unknown;
        const wrap = (b: object): unknown =>
          new Proxy(b, {
            get(bt, bp, br) {
              const v = Reflect.get(bt, bp, br);
              if (bp === "then") {
                const flat = spec.replace(/\s+/g, "");
                const rule = candidates.find((r) => r.select(flat) && (r.teamId === undefined || r.teamId === team));
                if (!rule) return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(bt) : v;
                const act = rule.act;
                if ("throws" in act) throw act.throws;
                if ("error" in act) return (res: (x: unknown) => unknown) => res({ data: null, error: act.error });
                return (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) => {
                  (bt as PromiseLike<{ data: unknown[] | null; error: unknown }>).then(
                    (out) => res(out.data ? { ...out, data: act.transform(out.data) } : out),
                    rej
                  );
                };
              }
              if (typeof v !== "function") return v;
              return (...args: unknown[]) => {
                if (bp === "select") spec = String(args[0] ?? "");
                if (bp === "eq" && args[0] === "team_id") team = args[1];
                const r = (v as (...a: unknown[]) => unknown).apply(bt, args);
                return r === bt ? br : wrap(r as object);
              };
            },
          });
        return wrap(q as object);
      };
    },
  }) as DbClient;
}

const convergenceReturns = (teamId: string, error: unknown): ReadRule => ({
  table: "groups", select: BUILTIN_LOOKUP_SHAPE, teamId, act: { error },
});
const convergenceThrows = (teamId: string, value: unknown): ReadRule => ({
  table: "groups", select: BUILTIN_LOOKUP_SHAPE, teamId, act: { throws: value },
});
const censusReturns = (teamId: string, message: string): ReadRule => ({
  table: "project_groups", select: CENSUS_SHAPE, teamId, act: { error: { message } },
});
const censusThrows = (teamId: string, value: unknown): ReadRule => ({
  table: "project_groups", select: CENSUS_SHAPE, teamId, act: { throws: value },
});

// ── Ledger readers ───────────────────────────────────────────────────────────────────────────────

type LedgerRow = {
  id: number | string;
  team_id: string | null;
  source: string;
  trigger: string;
  ok: boolean;
  error_count: number;
  errors: unknown;
  meta: unknown;
};
const COLS = "id, team_id, source, trigger, ok, error_count, errors, meta";

/** jsonb arrives as a string under some adapter paths and a value under others. */
const jsonOf = <T>(v: unknown, empty: T): T => (typeof v === "string" ? (JSON.parse(v) as T) : ((v ?? empty) as T));
const errorsOf = (row: LedgerRow) => jsonOf<string[]>(row.errors, []);
const metaOf = (row: LedgerRow) => jsonOf<Record<string, unknown>>(row.meta, {});
const evidenceOf = (row: LedgerRow) => metaOf(row).accessBootstrapEvidence as Evidence | undefined;

async function teamRows(teamId: string): Promise<LedgerRow[]> {
  const { data, error } = await db()
    .from("ingest_runs").select(COLS).eq("source", "access_bootstrap").eq("team_id", teamId).order("id", { ascending: true });
  expect(error, "ledger read").toBeNull();
  return (data ?? []) as LedgerRow[];
}

async function watermark(): Promise<number> {
  const { data } = await db().from("ingest_runs").select("id").order("id", { ascending: false }).limit(1);
  return Number(((data ?? []) as { id: number | string }[])[0]?.id ?? 0);
}

/** `team_id is null` rows written after `since` — what EVERY team's reader merges in. */
async function globalRowsSince(since: number): Promise<LedgerRow[]> {
  const { data, error } = await db().from("ingest_runs").select(COLS).is("team_id", null).order("id", { ascending: true });
  expect(error, "ledger read").toBeNull();
  return ((data ?? []) as LedgerRow[]).filter((r) => Number(r.id) > since);
}

/**
 * One scheduler tick for `teamId`, observed twice: the OUTCOME the wrapper hands its callback, and
 * the ROW the shipped leg stores. Convergence is idempotent for every fixture here, so the capture
 * pass and the leg pass see the same state.
 */
async function tick(client: DbClient, teamId: string) {
  const outcomes: Outcome[] = [];
  const summary = await ensureAccessBootstrapAllTeams(client, {
    onOutcome: (o) => {
      outcomes.push(o as Outcome);
    },
  });
  const before = (await teamRows(teamId)).length;
  await runAccessBootstrapLeg(client);
  const rows = await teamRows(teamId);
  expect(rows.length - before, "exactly ONE scheduler row for this team per tick (a lost row is 0)").toBe(1);
  const row = rows[rows.length - 1];
  return { outcome: outcomes.find((o) => o.teamId === teamId), summary, row };
}

/** Relationships every stored failed envelope must satisfy, whatever produced it. */
function expectEnvelopeInvariants(row: LedgerRow, teamId: string): Evidence {
  const errors = errorsOf(row);
  const meta = metaOf(row);
  expect(row.ok, "a failing phase is a failed row").toBe(false);
  expect(row.trigger, "the staleness clock reads scheduler rows only").toBe("scheduler");
  expect(errors, "ONE compound error — one error_count contribution").toHaveLength(1);
  expect(row.error_count).toBe(1);
  expect(Object.keys(meta), "the callback's only new metadata is the namespaced envelope").toEqual(["accessBootstrapEvidence"]);
  const e = meta.accessBootstrapEvidence as Evidence;
  expect(e.version).toBe(1);
  expect(e.teamId, "the envelope names the row's own team").toBe(teamId);
  expect(row.team_id).toBe(teamId);

  expect(bytes(errors[0]), "compound error ≤ 480 UTF-8 bytes").toBeLessThanOrEqual(BUDGET.compoundBytes);
  expect(errors[0].length, "and inside the writer's 500-character clamp, so it was never cut").toBeLessThanOrEqual(BUDGET.writerClampChars);
  expect(errors[0], "the stored error IS the labelled arms the evidence carries").toBe(compound(e));
  expect(wrapperBytes(e), "JSON.stringify({accessBootstrapEvidence}) ≤ 8,192 bytes").toBeLessThanOrEqual(BUDGET.metaBytes);

  expect(e.convergence.status === "failed", "a failed phase carries its error; a clean one omits it").toBe(e.convergence.error !== undefined);
  expect(e.sample.length).toBeLessThanOrEqual(BUDGET.samples);
  if (e.census.status === "failed") {
    expect(e.census.total, "unavailable is never zero").toBeNull();
    expect(e.omitted).toBeNull();
    expect(e.sample).toEqual([]);
    expect(e.census.error).toBeDefined();
  } else {
    expect(Number.isInteger(e.census.total)).toBe(true);
    expect(e.omitted, "omitted = total − sample.length").toBe((e.census.total as number) - e.sample.length);
    expect(e.census.error !== undefined, "findings carry the census summary; zero findings carry none").toBe((e.census.total as number) > 0);
  }
  expect(e.convergence.error !== undefined || e.census.error !== undefined, "a wholly healthy state has no envelope").toBe(true);
  for (const s of e.sample) {
    expect(s.projectId).toMatch(UUID);
    expect(s.groupId).toMatch(UUID);
    expect(bytes(s.projectSlug), "display slug ≤ 96 bytes including its cue").toBeLessThanOrEqual(BUDGET.slugBytes);
    expect(bytes(s.groupSlug)).toBeLessThanOrEqual(BUDGET.slugBytes);
  }
  const serialized = JSON.stringify({ errors, meta });
  expect(serialized, "no NUL survives").not.toContain("\\u0000");
  expect(serialized, "no isolated surrogate survives").not.toMatch(/\\ud[89ab][0-9a-f]{2}|\\ud[c-f][0-9a-f]{2}/i);
  return e;
}

type Tick = Awaited<ReturnType<typeof tick>>;

/** Outcome, summary and stored row all agree with `want`, exactly. */
function expectTransport(t: Tick, teamId: string, want: { error: string; evidence: Evidence }): void {
  expect(t.outcome, "the team reported an outcome").toBeDefined();
  expect(t.outcome!.ok).toBe(false);
  expect(t.outcome!.error, "the OUTCOME's labelled compound").toBe(want.error);
  expect(t.outcome!.evidence, "the OUTCOME's typed evidence").toEqual(want.evidence);
  expect(t.summary.failed.find((f) => f.teamId === teamId)?.error, "the returned summary agrees").toBe(want.error);
  expect(errorsOf(t.row), "the STORED error — past the real writer clamp").toEqual([want.error]);
  expect(metaOf(t.row), "the STORED metadata is exactly the namespaced envelope").toEqual({ accessBootstrapEvidence: want.evidence });
  expectEnvelopeInvariants(t.row, teamId);
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** The actual panel, fed by the actual reader. Returns each `<details>` block as tag + plain text. */
async function panelFor(teamId: string) {
  const runs = await listRecentIngestRuns(db(), teamId, 30);
  const html = renderToStaticMarkup(IngestRunsPanel({ runs }));
  const text = (fragment: string) => fragment.replace(/<[^>]+>/g, " ");
  const blocks = [...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)].map((m) => ({
    attrs: m[1],
    html: m[2],
    text: text(m[2]),
    summary: text(/<summary\b[^>]*>([\s\S]*?)<\/summary>/.exec(m[2])?.[1] ?? ""),
  }));
  return { runs, html, blocks };
}

// ── AC01 ─────────────────────────────────────────────────────────────────────────────────────────

describe("AUDITFIX-25 AC01: structured evidence travels outcome → callback → jsonb row", () => {
  it("a real forbidden edge yields ONE failed row with matching typed evidence, exact IDs and the full count", async () => {
    const seed = await bareTeam();
    const general = await projectId(seed, GENERAL_SLUG);
    const vendors = await ordinaryGroup(seed, "vendors");
    await plant(seed, general, vendors);

    const t = await tick(db(), seed.teamId);

    // Spelled out, not derived: this is the contract's simplest instance and the oracle's anchor.
    expectTransport(t, seed.teamId, {
      error: "census: 1 unsanctioned edge(s) on system projects: general→vendors",
      evidence: {
        version: 1,
        teamId: seed.teamId,
        convergence: { status: "ok" },
        census: {
          status: "complete",
          total: 1,
          error: { message: "1 unsanctioned edge(s) on system projects: general→vendors", truncated: false },
        },
        sample: [
          { projectId: general, groupId: vendors, projectSlug: "general", groupSlug: "vendors", projectSlugTruncated: false, groupSlugTruncated: false },
        ],
        omitted: 0,
      },
    });
  });

  it("a clean team stays ok and carries NO evidence, on the outcome or in the row", async () => {
    const seed = await bareTeam();

    const t = await tick(db(), seed.teamId);

    expect(t.outcome, "exactly the pre-existing ok outcome — no evidence key").toEqual({ teamId: seed.teamId, ok: true });
    expect(t.summary.failed).toEqual([]);
    expect(t.row.ok).toBe(true);
    expect(t.row.error_count).toBe(0);
    expect(errorsOf(t.row)).toEqual([]);
    expect(metaOf(t.row), "a wholly healthy state writes no envelope").toEqual({});
  });
});

// ── AC02 ─────────────────────────────────────────────────────────────────────────────────────────

describe("AUDITFIX-25 AC02: convergence and census are independent phases, and BOTH arms survive", () => {
  it("returned convergence failure + census findings: the census no longer REPLACES the convergence error", async () => {
    const seed = await bareTeam();
    const externalShared = await projectId(seed, EXTERNAL_SHARED_SLUG);
    const vendors = await ordinaryGroup(seed, "vendors");
    await plant(seed, externalShared, vendors);
    await wedgeGeneral(seed);

    const t = await tick(db(), seed.teamId);

    expectTransport(t, seed.teamId, {
      error: `census: 1 unsanctioned edge(s) on system projects: external-shared→vendors; convergence: ${WEDGE_ERROR}`,
      evidence: {
        version: 1,
        teamId: seed.teamId,
        convergence: { status: "failed", error: { message: WEDGE_ERROR, truncated: false } },
        census: {
          status: "complete",
          total: 1,
          error: { message: "1 unsanctioned edge(s) on system projects: external-shared→vendors", truncated: false },
        },
        sample: [
          { projectId: externalShared, groupId: vendors, projectSlug: "external-shared", groupSlug: "vendors", projectSlugTruncated: false, groupSlugTruncated: false },
        ],
        omitted: 0,
      },
    });
  });

  it("THROWN convergence still runs the census, and the row names both", async () => {
    const seed = await bareTeam();
    const general = await projectId(seed, GENERAL_SLUG);
    const vendors = await ordinaryGroup(seed, "vendors");
    await plant(seed, general, vendors);

    const t = await tick(intercept([convergenceThrows(seed.teamId, new Error("convergence exploded"))]), seed.teamId);

    expectTransport(t, seed.teamId, {
      error: "census: 1 unsanctioned edge(s) on system projects: general→vendors; convergence: convergence exploded",
      evidence: {
        version: 1,
        teamId: seed.teamId,
        convergence: { status: "failed", error: { message: "convergence exploded", truncated: false } },
        census: {
          status: "complete",
          total: 1,
          error: { message: "1 unsanctioned edge(s) on system projects: general→vendors", truncated: false },
        },
        sample: [
          { projectId: general, groupId: vendors, projectSlug: "general", groupSlug: "vendors", projectSlugTruncated: false, groupSlugTruncated: false },
        ],
        omitted: 0,
      },
    });
  });

  it("a lone convergence failure is NAMED, and a clean census records an exact ZERO", async () => {
    const seed = await bareTeam();
    await wedgeGeneral(seed);

    const t = await tick(db(), seed.teamId);

    expectTransport(t, seed.teamId, {
      error: `convergence: ${WEDGE_ERROR}`,
      evidence: {
        version: 1,
        teamId: seed.teamId,
        convergence: { status: "failed", error: { message: WEDGE_ERROR, truncated: false } },
        census: { status: "complete", total: 0 },
        sample: [],
        omitted: 0,
      },
    });
  });

  it("a RETURNED census read failure records UNAVAILABLE counts, never zero", async () => {
    const seed = await bareTeam();

    const t = await tick(intercept([censusReturns(seed.teamId, "census exploded")]), seed.teamId);

    expectTransport(t, seed.teamId, {
      // The writer already prefixes its own read failures; one leading `system-edge census ` is stripped.
      error: "census: failed: census exploded",
      evidence: {
        version: 1,
        teamId: seed.teamId,
        convergence: { status: "ok" },
        census: { status: "failed", total: null, error: { message: "failed: census exploded", truncated: false } },
        sample: [],
        omitted: null,
      },
    });
  });

  it("a THROWN census beside a returned convergence failure keeps both, with unavailable counts", async () => {
    const seed = await bareTeam();
    await wedgeGeneral(seed);

    const t = await tick(intercept([censusThrows(seed.teamId, new Error("census exploded"))]), seed.teamId);

    expectTransport(t, seed.teamId, {
      error: `census: system-edge census threw: census exploded; convergence: ${WEDGE_ERROR}`,
      evidence: {
        version: 1,
        teamId: seed.teamId,
        convergence: { status: "failed", error: { message: WEDGE_ERROR, truncated: false } },
        census: { status: "failed", total: null, error: { message: "system-edge census threw: census exploded", truncated: false } },
        sample: [],
        omitted: null,
      },
    });
  });
});

// ── AC03 ─────────────────────────────────────────────────────────────────────────────────────────

describe("AUDITFIX-25 AC03: each arm has its own budget, and the compound never exceeds 480 bytes", () => {
  const LONG = (head: string) => `${head} ${"x".repeat(2000)}`;

  it("lone census: a raw finding PAST the legacy 200-character preclamp is still named", async () => {
    const seed = await bareTeam();
    const legacy = await rawProject(seed, "legacy-system", "system");
    const SENTINEL = "zz-sentinel-past-legacy-200";
    for (const slug of ["grp-a-padding-0123456789", "grp-b-padding-0123456789", "grp-c-padding-0123456789", "grp-d-padding-0123456789",
      "grp-e-padding-0123456789", "grp-f-padding-0123456789", "grp-g-padding-0123456789", SENTINEL]) {
      await plant(seed, legacy, await ordinaryGroup(seed, slug));
    }
    const edges = await rawFindings(seed);
    const want = expectedFor({ teamId: seed.teamId, convergence: null, census: { edges } });
    const summary = want.evidence.census.error!.message;
    // Fixture preconditions — MULTIPLE pairs, none enormous (the old first-pair fallback could exceed
    // 200 by itself), the sentinel beyond the old budget, and the whole summary inside the lone cap.
    expect(edges).toHaveLength(8);
    expect(summary.indexOf(SENTINEL), "the sentinel sits past the legacy 200-character summary").toBeGreaterThan(200);
    expect(bytes(summary), "and inside the 472-byte lone census arm").toBeLessThanOrEqual(BUDGET.loneCensus);
    expect(want.evidence.census.error!.truncated).toBe(false);

    const t = await tick(db(), seed.teamId);

    expectTransport(t, seed.teamId, want);
    expect(errorsOf(t.row)[0], "all eight pairs are named — no '+N more'").not.toMatch(/\+\d+ more/);
    expect(errorsOf(t.row)[0]).toContain(`legacy-system→${SENTINEL}`);
  });

  it("long convergence + short census: the census arm is whole and convergence takes the rest of the pool", async () => {
    const seed = await bareTeam();
    await plant(seed, await projectId(seed, GENERAL_SLUG), await ordinaryGroup(seed, "vendors"));
    const long = LONG("CONVERGENCE-HEAD");
    const edges = await rawFindings(seed);
    const want = expectedFor({ teamId: seed.teamId, convergence: long, census: { edges } });

    const t = await tick(intercept([convergenceReturns(seed.teamId, { message: long })]), seed.teamId);

    expectTransport(t, seed.teamId, want);
    const e = evidenceOf(t.row)!;
    const short = "1 unsanctioned edge(s) on system projects: general→vendors";
    expect(e.census.error, "the short arm is untouched").toEqual({ message: short, truncated: false });
    expect(e.convergence.error!.truncated).toBe(true);
    expect(bytes(e.convergence.error!.message), "457 − the census arm, exactly, cue included").toBe(BUDGET.dualPool - bytes(short));
    expect(e.convergence.error!.message.startsWith("CONVERGENCE-HEAD x")).toBe(true);
    expect(e.convergence.error!.message.endsWith(ELLIPSIS), "shortening is visible").toBe(true);
    expect(bytes(errorsOf(t.row)[0]), "the pool is fully spent: 480 bytes").toBe(BUDGET.compoundBytes);
  });

  it("long census READ error + short convergence: whole-compound clamping would lose the convergence arm", async () => {
    const seed = await bareTeam();
    await wedgeGeneral(seed);
    const long = LONG("CENSUS-READ-HEAD");
    const want = expectedFor({ teamId: seed.teamId, convergence: WEDGE_ERROR, census: { failed: `failed: ${long}` } });

    const t = await tick(intercept([censusReturns(seed.teamId, long)]), seed.teamId);

    expectTransport(t, seed.teamId, want);
    const e = evidenceOf(t.row)!;
    expect(e.convergence.error, "the short convergence arm survives whole").toEqual({ message: WEDGE_ERROR, truncated: false });
    expect(e.census.error!.truncated).toBe(true);
    expect(bytes(e.census.error!.message), "census is extended first, to 457 − the convergence arm").toBe(BUDGET.dualPool - bytes(WEDGE_ERROR));
    expect(e.census.error!.message.startsWith("failed: CENSUS-READ-HEAD x")).toBe(true);
    expect(errorsOf(t.row)[0].endsWith(`; convergence: ${WEDGE_ERROR}`), "the base stores 500 characters of census and nothing else").toBe(true);
    expect(bytes(errorsOf(t.row)[0])).toBe(BUDGET.compoundBytes);
  });

  it("long census THROW + long convergence THROW: 224 reserved each, the 9 spare bytes go census-first", async () => {
    const seed = await bareTeam();
    const censusLong = LONG("CENSUS-THROW-HEAD");
    const convergenceLong = LONG("CONVERGENCE-THROW-HEAD");
    const want = expectedFor({
      teamId: seed.teamId,
      convergence: convergenceLong,
      census: { failed: `system-edge census threw: ${censusLong}` },
    });

    const t = await tick(
      intercept([censusThrows(seed.teamId, new Error(censusLong)), convergenceThrows(seed.teamId, new Error(convergenceLong))]),
      seed.teamId
    );

    expectTransport(t, seed.teamId, want);
    const e = evidenceOf(t.row)!;
    // 457 − 224 − 224 = 9 spare; census is extended first, so 233 / 224 — not 228 / 229, not 224 / 233.
    expect(bytes(e.census.error!.message)).toBe(233);
    expect(bytes(e.convergence.error!.message)).toBe(BUDGET.armReserve);
    expect(e.census.error!.truncated && e.convergence.error!.truncated).toBe(true);
    expect(e.census.error!.message.startsWith("system-edge census threw: CENSUS-THROW-HEAD x")).toBe(true);
    expect(e.convergence.error!.message.startsWith("CONVERGENCE-THROW-HEAD x")).toBe(true);
    expect(e.census.total, "a thrown census is unavailable").toBeNull();
    expect(bytes(errorsOf(t.row)[0]), "8 + 233 + 15 + 224").toBe(BUDGET.compoundBytes);
  });

  it("MANY raw findings + a convergence failure: the census arm is cut from RAW pairs, sentinel past 200 intact", async () => {
    const seed = await bareTeam();
    const legacy = await rawProject(seed, "legacy-system", "system");
    // 20 groups of 40 characters. Sorted, the fourth pair starts past character 200 of the summary.
    const slugs = Array.from({ length: 20 }, (_, i) => `g${String(i).padStart(2, "0")}-${"m".repeat(36)}`);
    const SENTINEL = slugs[3];
    for (const slug of slugs) await plant(seed, legacy, await ordinaryGroup(seed, slug));
    await wedgeGeneral(seed);
    const edges = await rawFindings(seed);
    const want = expectedFor({ teamId: seed.teamId, convergence: WEDGE_ERROR, census: { edges } });
    const arm = want.evidence.census.error!;
    expect(edges, "fixture: twenty findings").toHaveLength(20);
    expect(arm.message.indexOf(SENTINEL), "fixture: the sentinel pair starts past the legacy 200").toBeGreaterThan(200);
    expect(arm.truncated, "fixture: sixteen 56-character pairs cannot fit the arm").toBe(true);

    const t = await tick(db(), seed.teamId);

    expectTransport(t, seed.teamId, want);
    const e = evidenceOf(t.row)!;
    expect(e.census.total, "the count is exact and unbounded-safe").toBe(20);
    expect(e.sample).toHaveLength(16);
    expect(e.omitted).toBe(4);
    expect(e.census.error!.message.startsWith(CENSUS_HEAD(20)), "the exact count head is reserved").toBe(true);
    expect(e.census.error!.message, "restoring the 200-character preformatter drops this pair").toContain(`legacy-system→${SENTINEL}`);
    expect(e.census.error!.message, "no promise of a complete list").not.toMatch(/\+\d+ more/);
    expect(bytes(e.census.error!.message)).toBe(BUDGET.dualPool - bytes(WEDGE_ERROR));
    expect(e.convergence.error).toEqual({ message: WEDGE_ERROR, truncated: false });
  });

  /** A reserved-slug SOURCE row already granted to an ordinary group: adoption refuses, with repair guidance. */
  async function adoptionRefusal(): Promise<{ seed: Seed; group: string; refusal: string }> {
    const seed = await seedTeam();
    const source = await rawProject(seed, GENERAL_SLUG, "source");
    const group = await ordinaryGroup(seed, "vendors-and-contractors-emea");
    await plant(seed, source, group);
    const r = await ensureAccessBootstrap(db(), seed.teamId);
    expect(r.ok, "fixture: adoption must be refused").toBe(false);
    const refusal = r.error as string;
    expect(refusal).toMatch(/^general: refusing to adopt 'general'/);
    expect(refusal.endsWith("(repair: AUDITFIX-21)."), "fixture: the real repair suffix is the tail").toBe(true);
    expect(bytes(refusal), "fixture: longer than one 224-byte reservation").toBeGreaterThan(BUDGET.armReserve);
    return { seed, group, refusal };
  }

  it("a real LONE adoption refusal keeps its repair suffix inside the 467-byte lone cap", async () => {
    const { seed, refusal } = await adoptionRefusal();
    expect(bytes(refusal)).toBeLessThanOrEqual(BUDGET.loneConvergence);

    const t = await tick(db(), seed.teamId);

    expectTransport(t, seed.teamId, {
      error: `convergence: ${refusal}`,
      evidence: {
        version: 1,
        teamId: seed.teamId,
        convergence: { status: "failed", error: { message: refusal, truncated: false } },
        // The granted row is still `source`, so the system-edge census has nothing to report.
        census: { status: "complete", total: 0 },
        sample: [],
        omitted: 0,
      },
    });
  });

  it("a short census beside that refusal: the UNUSED census reservation is redistributed and the suffix survives", async () => {
    const { seed, group, refusal } = await adoptionRefusal();
    const legacy = await rawProject(seed, "legacy-system", "system");
    await plant(seed, legacy, group);
    const summary = "1 unsanctioned edge(s) on system projects: legacy-system→vendors-and-contractors-emea";
    expect(bytes(summary) + bytes(refusal), "fixture: both whole arms fit the 457-byte pool").toBeLessThanOrEqual(BUDGET.dualPool);

    const t = await tick(db(), seed.teamId);

    expectTransport(t, seed.teamId, {
      // A flat 224-byte arm cap would cut the refusal before `(repair: AUDITFIX-21).`
      error: `census: ${summary}; convergence: ${refusal}`,
      evidence: {
        version: 1,
        teamId: seed.teamId,
        convergence: { status: "failed", error: { message: refusal, truncated: false } },
        census: { status: "complete", total: 1, error: { message: summary, truncated: false } },
        sample: [
          { projectId: legacy, groupId: group, projectSlug: "legacy-system", groupSlug: "vendors-and-contractors-emea", projectSlugTruncated: false, groupSlugTruncated: false },
        ],
        omitted: 0,
      },
    });
  });
});

// ── AC04 ─────────────────────────────────────────────────────────────────────────────────────────

describe("AUDITFIX-25 AC04: the SERIALIZED namespace is bounded, and hostile text still persists", () => {
  it("quote/backslash/control/non-BMP slugs: ≤ 8,192 serialized bytes, trimmed from the end, truthful flags", async () => {
    const seed = await bareTeam();
    await hostileFindings(seed);
    const edges = await rawFindings(seed);
    expect(edges, "fixture: twenty findings on the hostile project").toHaveLength(20);
    const want = expectedFor({ teamId: seed.teamId, convergence: null, census: { edges } });
    // The fixture must make the JSON measurement bite: sixteen samples' display labels are a few
    // thousand raw characters, and do NOT fit once escaped — so only a final serialized measurement
    // produces this sample size.
    const sixteen = ordered(edges).slice(0, 16).map(display);
    expect(sixteen.reduce((n, s) => n + s.projectSlug.length + s.groupSlug.length, 0), "raw label characters look small").toBeLessThan(4000);
    expect(wrapperBytes({ ...want.evidence, sample: sixteen, omitted: 4 }), "but sixteen escaped samples overflow").toBeGreaterThan(BUDGET.metaBytes);
    expect(want.evidence.sample.length).toBeLessThan(16);
    expect(want.evidence.sample.length).toBeGreaterThan(0);

    const t = await tick(db(), seed.teamId);

    expectTransport(t, seed.teamId, want);
    const e = evidenceOf(t.row)!;
    expect(e.census.total).toBe(20);
    expect(e.omitted, "omitted is recomputed after every removal").toBe(20 - e.sample.length);
    // The LAST FITTING sample: one more, in order, would not fit. Not an accidental sample size.
    const next = display(ordered(edges)[e.sample.length]);
    expect(
      wrapperBytes({ ...e, sample: [...e.sample, next], omitted: (e.omitted as number) - 1 }),
      "the next ordered sample would exceed 8,192 bytes"
    ).toBeGreaterThan(BUDGET.metaBytes);
    // Truthful flags, against the RAW slug resolved by exact id.
    const byGroup = new Map(edges.map((x) => [x.groupId, x]));
    for (const s of e.sample) {
      const raw = byGroup.get(s.groupId)!;
      expect(s.projectId, "UUID identities stay exact").toBe(raw.projectId);
      expect(s.projectSlugTruncated).toBe(s.projectSlug !== raw.projectSlug);
      expect(s.groupSlugTruncated).toBe(s.groupSlug !== raw.groupSlug);
      expect(s.projectSlugTruncated && s.groupSlugTruncated, "fixture: both exceed 96 bytes").toBe(true);
      expect(s.groupSlug.endsWith(ELLIPSIS)).toBe(true);
      expect(raw.groupSlug.startsWith(s.groupSlug.slice(0, -ELLIPSIS.length)), "a code-point prefix of the raw slug").toBe(true);
      expect(s.groupSlug.slice(0, -ELLIPSIS.length).isWellFormed(), "never half of a surrogate pair").toBe(true);
    }
    expect(e.census.error!.truncated, "the enormous first pair alone exceeds the arm").toBe(true);
    expect(bytes(e.census.error!.message)).toBeLessThanOrEqual(BUDGET.loneCensus);
  });

  it("a thrown message with NUL and isolated surrogates PERSISTS, as U+FFFD, with valid pairs intact", async () => {
    const seed = await bareTeam();
    const hostile = "bad\u0000nul \uD83D lone-high \uDE00 lone-low ok 😀 pair";
    const clean = `bad${REPLACEMENT}nul ${REPLACEMENT} lone-high ${REPLACEMENT} lone-low ok 😀 pair`;
    expect(hostile.isWellFormed(), "fixture: the thrown message really carries isolated surrogates").toBe(false);
    expect(hostile, "fixture: and a NUL").toContain(String.fromCodePoint(0));
    expect(clean.isWellFormed()).toBe(true);

    // On the base this row is LOST: jsonb rejects \u0000 and an unpaired surrogate, the insert fails,
    // and the best-effort writer swallows it — `tick` reports zero rows for the team.
    const t = await tick(intercept([convergenceThrows(seed.teamId, new Error(hostile))]), seed.teamId);

    expectTransport(t, seed.teamId, {
      error: `convergence: ${clean}`,
      evidence: {
        version: 1,
        teamId: seed.teamId,
        convergence: { status: "failed", error: { message: clean, truncated: false } },
        census: { status: "complete", total: 0 },
        sample: [],
        omitted: 0,
      },
    });
  });
});

// ── AC05 ─────────────────────────────────────────────────────────────────────────────────────────

describe("AUDITFIX-25 AC05: the sample is the first 16 by FULL tuple, whatever order the rows arrive in", () => {
  type CensusRow = {
    project_id: string;
    group_id: string;
    projects: { kind: string; slug: string } | null;
    groups: { slug: string; is_builtin: boolean } | null;
  };

  it("equal raw slug pairs tie-break on IDs, and slugs that differ only past the display cut still order by the full slug", async () => {
    const seed = await bareTeam();
    const legacy = await rawProject(seed, "legacy-system", "system");
    const planted: string[] = [];
    for (let i = 0; i < 20; i++) {
      const g = await ordinaryGroup(seed, `ordinary-${String(i).padStart(2, "0")}`);
      await plant(seed, legacy, g);
      planted.push(g);
    }
    const byId = [...planted].sort(cmp);
    const COMMON = "x".repeat(120); // every display of these is the same 96 bytes

    // unique(team_id, slug) makes an equal raw pair unreachable in Postgres, so it is injected at the
    // census read — the same seam the census suite uses for an unresolved embed. IDs stay real.
    const rewrite = (permute: (rows: CensusRow[]) => CensusRow[]) => (rows: unknown[]) => {
      const all = rows as CensusRow[];
      const mine = all.filter((r) => r.project_id === legacy).sort((a, b) => cmp(a.group_id, b.group_id));
      const rest = all.filter((r) => r.project_id !== legacy);
      const rewritten = mine.map((r, i) =>
        i < 10
          ? { ...r, projects: { kind: "system", slug: "dup-project" }, groups: { slug: "dup-group", is_builtin: false } }
          : // Suffix DEscends as the id AScends, so id order and input order both give the wrong answer.
            { ...r, projects: { kind: "system", slug: "legacy-system" }, groups: { slug: `${COMMON}-${String(29 - i)}`, is_builtin: false } }
      );
      return permute([...rest, ...rewritten]);
    };
    const forward = intercept([{ table: "project_groups", select: CENSUS_SHAPE, teamId: seed.teamId, act: { transform: rewrite((r) => r) } }]);
    const permuted = intercept([
      { table: "project_groups", select: CENSUS_SHAPE, teamId: seed.teamId, act: { transform: rewrite((r) => [...r.slice(7), ...r.slice(0, 7)].reverse()) } },
    ]);

    const a = await tick(forward, seed.teamId);
    const b = await tick(permuted, seed.teamId);

    const first = expectEnvelopeInvariants(a.row, seed.teamId);
    const second = expectEnvelopeInvariants(b.row, seed.teamId);
    expect(second, "permuted input, identical evidence").toEqual(first);
    expect(errorsOf(b.row)).toEqual(errorsOf(a.row));
    expect(first.census.total, "findings are NOT deduplicated").toBe(20);
    expect(first.sample).toHaveLength(16);
    expect(first.omitted).toBe(4);
    // Ten equal pairs in ID order, then the six smallest FULL slugs (suffixes 10..15 ⇒ ids 19..14).
    expect(first.sample.map((s) => s.groupId)).toEqual([...byId.slice(0, 10), byId[19], byId[18], byId[17], byId[16], byId[15], byId[14]]);
    expect(first.sample.slice(0, 10).every((s) => s.projectSlug === "dup-project" && s.groupSlug === "dup-group")).toBe(true);
    const cut = first.sample.slice(10);
    expect(new Set(cut.map((s) => s.groupSlug)).size, "their displays are IDENTICAL — truncation cannot have ordered them").toBe(1);
    expect(cut.every((s) => s.groupSlugTruncated && bytes(s.groupSlug) <= BUDGET.slugBytes)).toBe(true);
  });
});

// ── AC06 ─────────────────────────────────────────────────────────────────────────────────────────

describe("AUDITFIX-25 AC06: ledger compatibility and the NULL-team privacy boundary", () => {
  it("two teams, one failed and one clean: one row each per tick, one separate liveness beat, nothing team-shaped on NULL rows", async () => {
    const failing = await bareTeam();
    const clean = await bareTeam();
    const vendors = await ordinaryGroup(failing, "tenant-marker-vendors");
    await plant(failing, await projectId(failing, GENERAL_SLUG), vendors);
    const since = await watermark();

    await runAccessBootstrapLeg(db());

    const failedRows = await teamRows(failing.teamId);
    const cleanRows = await teamRows(clean.teamId);
    expect(failedRows, "one row for the failing team").toHaveLength(1);
    expect(cleanRows, "one row for the clean team").toHaveLength(1);
    const e = expectEnvelopeInvariants(failedRows[0], failing.teamId);
    expect(e.sample.map((s) => s.groupId)).toEqual([vendors]);
    expect(cleanRows[0].ok).toBe(true);
    expect(metaOf(cleanRows[0]), "the clean team's row carries no envelope").toEqual({});

    const globals = await globalRowsSince(since);
    expect(globals.map((r) => r.source), "an ordinary tick writes ONLY the liveness beat instance-wide").toEqual(["access_bootstrap_all"]);
    expect(globals[0].ok, "liveness, not correctness").toBe(true);
    expect(metaOf(globals[0]), "aggregate counts only").toEqual({ teams: 2, failedTeams: 1, fleetOk: true });
    const leaked = JSON.stringify(globals.map((r) => ({ errors: errorsOf(r), meta: metaOf(r) })));
    for (const secret of [failing.teamId, vendors, "tenant-marker-vendors", "accessBootstrapEvidence"]) {
      expect(leaked, `a NULL-team row must not carry '${secret}'`).not.toContain(secret);
    }

    await runAccessBootstrapLeg(db());
    expect(await teamRows(failing.teamId), "exactly one more on tick 2 — no duplicate summary write").toHaveLength(2);
    expect(await teamRows(clean.teamId)).toHaveLength(2);
  });

  it("the evidence row is written as each team COMPLETES — before the next team starts converging", async () => {
    const a = await bareTeam();
    const b = await bareTeam();
    for (const seed of [a, b]) await plant(seed, await projectId(seed, GENERAL_SLUG), await ordinaryGroup(seed, "vendors"));

    // A STATE oracle, not a clock: when the second team's convergence begins, what does the ledger
    // already hold for the first? A summary-after-the-loop writer holds nothing.
    const visited: string[] = [];
    let previousAtNextStart: LedgerRow[] | null = null;
    vi.mocked(ensureBuiltins).mockImplementation(async (client, teamId) => {
      if (visited.length === 1) previousAtNextStart = await teamRows(visited[0]);
      visited.push(teamId);
      return real.groups!.ensureBuiltins(client, teamId);
    });

    await runAccessBootstrapLeg(db());

    expect(visited.sort(), "both teams converged").toEqual([a.teamId, b.teamId].sort());
    expect(previousAtNextStart, "the oracle observed the first team's ledger").not.toBeNull();
    const seen = previousAtNextStart as unknown as LedgerRow[];
    expect(seen, "the first team's row already exists").toHaveLength(1);
    expect(evidenceOf(seen[0])?.teamId, "and it already carries that team's evidence").toBe(seen[0].team_id);
  });

  it("a tenant-marked FLEET read failure reaches NULL rows only as the fixed reason and counts", async () => {
    const team = await bareTeam();
    const MARKER = `relation "teams" exploded for tenant ${team.teamSlug} (${team.teamId}) slug=acme-secret-vendors`;
    const since = await watermark();

    await runAccessBootstrapLeg(intercept([{ table: "teams", select: (flat) => flat === "id", act: { error: { message: MARKER } } }]));

    const globals = await globalRowsSince(since);
    const failure = globals.filter((r) => r.source === "access_bootstrap");
    const beat = globals.filter((r) => r.source === "access_bootstrap_all");
    expect(failure, "exactly one fleet-level failure row").toHaveLength(1);
    expect(beat, "and exactly one liveness beat").toHaveLength(1);
    expect(failure[0].ok).toBe(false);
    // `listRecentIngestRuns` merges NULL-team rows into EVERY team's panel, so arbitrary adapter text
    // here is cross-tenant disclosure. The base stores `teams read failed: <that text>`.
    expect(errorsOf(failure[0]), "the fixed global reason, verbatim").toEqual(["teams read failed"]);
    expect(metaOf(failure[0])).toEqual({ teams: 0, failedTeams: 1 });
    expect(beat[0].ok, "liveness stays ok:true — one event, one broken leg").toBe(true);
    expect(metaOf(beat[0])).toEqual({ teams: 0, failedTeams: 1, fleetOk: false });
    const stored = JSON.stringify(globals.map((r) => ({ errors: errorsOf(r), meta: metaOf(r) })));
    for (const secret of [team.teamSlug, team.teamId, "acme-secret-vendors", "exploded"]) {
      expect(stored, `a NULL-team row must not carry '${secret}'`).not.toContain(secret);
    }
    expect(await teamRows(team.teamId), "no team row was invented for a fleet failure").toEqual([]);
  });

  it("a tenant-marked FLEET throw is still rethrown, and reaches NULL rows only as 'bootstrap threw'", async () => {
    const team = await bareTeam();
    const MARKER = `pool exploded while serving tenant ${team.teamSlug} (${team.teamId}) slug=acme-secret-vendors`;
    const base = db();
    const thrower = new Proxy(base as object, {
      get(target, prop, recv) {
        if (prop !== "from") return Reflect.get(target, prop, recv);
        return (name: string) => {
          if (name === "teams") throw new Error(MARKER);
          return (target as { from: (n: string) => unknown }).from(name);
        };
      },
    }) as DbClient;
    const since = await watermark();

    // Rethrow is preserved: the scheduler's own console line remains the detailed diagnostic.
    await expect(runAccessBootstrapLeg(thrower)).rejects.toThrow(MARKER);

    const globals = await globalRowsSince(since);
    const failure = globals.filter((r) => r.source === "access_bootstrap");
    const beat = globals.filter((r) => r.source === "access_bootstrap_all");
    expect(failure).toHaveLength(1);
    expect(beat).toHaveLength(1);
    expect(failure[0].ok).toBe(false);
    expect(errorsOf(failure[0]), "the fixed throw reason, verbatim").toEqual(["bootstrap threw"]);
    expect(metaOf(failure[0])).toEqual({});
    expect(beat[0].ok).toBe(true);
    expect(metaOf(beat[0]), "meta.threw is the fixed reason too").toEqual({ fleetOk: false, threw: "bootstrap threw" });
    const stored = JSON.stringify(globals.map((r) => ({ errors: errorsOf(r), meta: metaOf(r) })));
    for (const secret of [team.teamSlug, team.teamId, "acme-secret-vendors", "exploded"]) {
      expect(stored, `a NULL-team row must not carry '${secret}'`).not.toContain(secret);
    }
  });

  // ── Safe extraction (spec §Flow extraction table) ──────────────────────────────────────────────
  //
  // Each case faults ONE phase of the MIDDLE team of three. Safe extraction is NOT a builder fault:
  // it keeps normal typed evidence with the pinned fallback and truncated=false. And it must not
  // escape the per-team guards — the base reads `e.message` INSIDE its catch, so a throwing getter
  // there aborts every remaining team and lands as one fleet-level row.

  const LEAKS = ["MINED-OBJECT-MESSAGE", "THROWN-STRING-TEXT", "MESSAGE-GETTER-TEXT", "RETURNED-GETTER-TEXT"];

  const messageGetterFault = (): Error => {
    const e = new Error("replaced below");
    Object.defineProperty(e, "message", {
      get() {
        throw new Error("MESSAGE-GETTER-TEXT");
      },
    });
    return e;
  };
  const nonStringMessage = (): Error => Object.assign(new Error("replaced below"), { message: 42 as unknown as string });
  /** A returned `{ ok: false }` whose `error` accessor throws — only a collaborator can return one. */
  const returnedGetterFault = (extra: Record<string, unknown> = {}) =>
    Object.defineProperty({ ok: false, ...extra }, "error", {
      enumerable: true,
      get() {
        throw new Error("RETURNED-GETTER-TEXT");
      },
    });

  async function extractionTick(arm: (teamId: string) => DbClient) {
    const before = await bareTeam();
    const target = await bareTeam();
    const after = await bareTeam();
    const client = arm(target.teamId);
    vi.mocked(ensureBuiltins).mockClear();
    const since = await watermark();

    await expect(runAccessBootstrapLeg(client), "a phase fault is THAT team's failure — never a fleet throw").resolves.toBeUndefined();

    for (const cleanTeam of [before, after]) {
      const rows = await teamRows(cleanTeam.teamId);
      expect(rows, "every clean team still lands its own row").toHaveLength(1);
      expect(rows[0].ok).toBe(true);
      expect(metaOf(rows[0])).toEqual({});
    }
    const rows = await teamRows(target.teamId);
    expect(rows, "the faulted team lands exactly one row").toHaveLength(1);
    const globals = await globalRowsSince(since);
    expect(globals.map((r) => r.source), "and nothing is promoted to a fleet-level failure").toEqual(["access_bootstrap_all"]);
    const stored = JSON.stringify({ errors: errorsOf(rows[0]), meta: metaOf(rows[0]), globals: globals.map(metaOf) });
    for (const leak of LEAKS) expect(stored, `no exception text or mined property: '${leak}'`).not.toContain(leak);
    // Fixture precondition, checked LAST so a base-behaviour abort reports the real failure above:
    // "later progress" is only meaningful if some team was visited AFTER the faulted one.
    const order = vi.mocked(ensureBuiltins).mock.calls.map((c) => c[1]);
    expect(order.indexOf(target.teamId), "fixture: a team is converged after the faulted one").toBeLessThan(order.length - 1);
    return { target, row: rows[0] };
  }

  describe.each([
    { name: "a thrown plain object carrying a string .message", fallback: "threw", arm: (id: string) => intercept([convergenceThrows(id, { message: "MINED-OBJECT-MESSAGE" })]) },
    { name: "a thrown string", fallback: "threw", arm: (id: string) => intercept([convergenceThrows(id, "THROWN-STRING-TEXT")]) },
    { name: "a thrown Error with an EMPTY message", fallback: "threw", arm: (id: string) => intercept([convergenceThrows(id, new Error(""))]) },
    { name: "a thrown Error whose message is not a string", fallback: "threw", arm: (id: string) => intercept([convergenceThrows(id, nonStringMessage())]) },
    { name: "a thrown Error whose message GETTER throws", fallback: "threw", arm: (id: string) => intercept([convergenceThrows(id, messageGetterFault())]) },
    { name: "a returned failure with a non-string error", fallback: "unknown", arm: (id: string) => intercept([convergenceReturns(id, { message: 42 })]) },
    { name: "a returned failure with an EMPTY error", fallback: "unknown", arm: (id: string) => intercept([convergenceReturns(id, { message: "" })]) },
    { name: "a returned failure with no error at all", fallback: "unknown", arm: (id: string) => intercept([convergenceReturns(id, {})]) },
    {
      name: "a returned failure whose error ACCESSOR throws",
      fallback: "unknown",
      arm: (id: string) => {
        vi.mocked(ensureBuiltins).mockImplementation(async (client, teamId) =>
          teamId === id ? (returnedGetterFault() as never) : real.groups!.ensureBuiltins(client, teamId)
        );
        return db();
      },
    },
  ])("convergence arm — $name", ({ fallback, arm }) => {
    it(`stores 'convergence: ${fallback}' WITH evidence, and later teams still report`, async () => {
      const { target, row } = await extractionTick(arm);

      // An empty message is falsy on the base and turns this failed phase GREEN.
      expect(row.ok, "an unusable message never makes a failed phase green").toBe(false);
      expect(errorsOf(row)).toEqual([`convergence: ${fallback}`]);
      expect(metaOf(row)).toEqual({
        accessBootstrapEvidence: {
          version: 1,
          teamId: target.teamId,
          convergence: { status: "failed", error: { message: fallback, truncated: false } },
          census: { status: "complete", total: 0 },
          sample: [],
          omitted: 0,
        },
      });
      expectEnvelopeInvariants(row, target.teamId);
    });
  });

  const censusResult = (result: unknown) => (id: string) => {
    vi.mocked(censusTeamSystemEdges).mockImplementation(async (client, teamId) =>
      teamId === id ? (result as never) : real.groups!.censusTeamSystemEdges(client, teamId)
    );
    return db();
  };

  describe.each([
    { name: "a returned failure with a non-string error", fallback: "failed", arm: censusResult({ ok: false, error: 42, edges: [] }) },
    { name: "a returned failure with an EMPTY error", fallback: "failed", arm: censusResult({ ok: false, error: "", edges: [] }) },
    { name: "a returned failure with no error at all", fallback: "failed", arm: censusResult({ ok: false, edges: [] }) },
    { name: "a returned error that is ONLY the stripped prefix", fallback: "failed", arm: censusResult({ ok: false, error: "system-edge census ", edges: [] }) },
    { name: "a returned failure whose error ACCESSOR throws", fallback: "failed", arm: censusResult(returnedGetterFault({ edges: [] })) },
    { name: "a thrown plain object carrying a string .message", fallback: "system-edge census threw: threw", arm: (id: string) => intercept([censusThrows(id, { message: "MINED-OBJECT-MESSAGE" })]) },
    { name: "a thrown string", fallback: "system-edge census threw: threw", arm: (id: string) => intercept([censusThrows(id, "THROWN-STRING-TEXT")]) },
    { name: "a thrown Error with an EMPTY message", fallback: "system-edge census threw: threw", arm: (id: string) => intercept([censusThrows(id, new Error(""))]) },
    { name: "a thrown Error whose message is not a string", fallback: "system-edge census threw: threw", arm: (id: string) => intercept([censusThrows(id, nonStringMessage())]) },
    { name: "a thrown Error whose message GETTER throws", fallback: "system-edge census threw: threw", arm: (id: string) => intercept([censusThrows(id, messageGetterFault())]) },
  ])("census arm — $name", ({ fallback, arm }) => {
    it(`stores 'census: ${fallback}' WITH unavailable-count evidence, and later teams still report`, async () => {
      const { target, row } = await extractionTick(arm);

      expect(row.ok, "an unusable census reason never makes an undetermined census green").toBe(false);
      expect(errorsOf(row)).toEqual([`census: ${fallback}`]);
      expect(metaOf(row)).toEqual({
        accessBootstrapEvidence: {
          version: 1,
          teamId: target.teamId,
          convergence: { status: "ok" },
          census: { status: "failed", total: null, error: { message: fallback, truncated: false } },
          sample: [],
          omitted: null,
        },
      });
      expectEnvelopeInvariants(row, target.teamId);
    });
  });
});

// ── AC06: the caller's THIRD guard ───────────────────────────────────────────────────────────────
//
// A GENUINE builder fault: the module's ordinary `buildBootstrapEvidence` export throws, through a
// normal module mock — no production fault flag, no injected callback. This is not safe extraction
// (above), which keeps normal evidence; here there is NO evidence, and what must survive is the
// phase/count failure itself, the healthy teams' green, and every team after the faulted one.
// Removing the guard around the builder in `ensureAccessBootstrapAllTeams` lets the throw escape the
// team loop: the leg rejects, the remaining teams never report, and one fleet-level row is written.

describe("AUDITFIX-25 AC06: a genuine evidence-builder fault keeps the failure, drops the evidence, and aborts nothing", () => {
  const BUILDER_FAULT = "BUILDER-FAULT-TEXT";
  const ASCII = /^[\x20-\x7e]+$/;

  /** The real builder for everyone except `teamIds` (or for no one, when `teamIds` is "every"). */
  function faultBuilder(teamIds: readonly string[] | "every"): void {
    vi.mocked(buildBootstrapEvidence).mockImplementation((input) => {
      if (teamIds === "every" || teamIds.includes(input.teamId)) throw new TypeError(BUILDER_FAULT);
      return real.evidence!.buildBootstrapEvidence(input);
    });
  }

  /** The capture pass and the leg pass of one tick, over the WHOLE fleet. */
  async function fleetTick(client: DbClient) {
    const outcomes: Outcome[] = [];
    const summary = await ensureAccessBootstrapAllTeams(client, {
      onOutcome: (o) => {
        outcomes.push(o as Outcome);
      },
    });
    vi.mocked(ensureBuiltins).mockClear();
    const since = await watermark();
    await expect(runAccessBootstrapLeg(client), "a builder fault is never a fleet throw").resolves.toBeUndefined();
    const globals = await globalRowsSince(since);
    const order = vi.mocked(ensureBuiltins).mock.calls.map((c) => c[1]);
    return { outcomes, summary, globals, order };
  }

  it("both phases failing with findings: the fixed phase/count error, NO evidence, and a later team still lands its own evidence", async () => {
    const before = await bareTeam();
    const target = await bareTeam();
    const after = await bareTeam();
    const externalShared = await projectId(target, EXTERNAL_SHARED_SLUG);
    for (const slug of ["fault-marker-a", "fault-marker-b", "fault-marker-c"]) {
      await plant(target, externalShared, await ordinaryGroup(target, slug));
    }
    await wedgeGeneral(target);
    const vendors = await ordinaryGroup(after, "vendors");
    await plant(after, await projectId(after, GENERAL_SLUG), vendors);
    const FALLBACK =
      "census: 3 unsanctioned edge(s) on system projects (evidence unavailable); convergence: failed (evidence unavailable)";
    faultBuilder([target.teamId]);

    const { outcomes, summary, globals, order } = await fleetTick(db());

    // The fault was genuine and was reached: the real export was called for this team, with the RAW
    // phase results, and threw.
    const faulted = vi.mocked(buildBootstrapEvidence).mock.calls.map((c) => c[0]).filter((i) => i.teamId === target.teamId);
    expect(faulted.length, "the builder was called for the faulted team on both passes").toBe(2);
    expect(faulted[0].convergence, "with the full, unlabelled convergence message").toEqual({ status: "failed", message: WEDGE_ERROR });
    expect(faulted[0].census.status).toBe("complete");
    expect((faulted[0].census as { edges: RawEdge[] }).edges, "and the raw findings — not a summary").toHaveLength(3);

    // The OUTCOME: failed, the fixed named phases and the exact count, and no evidence key at all.
    const outcome = outcomes.find((o) => o.teamId === target.teamId);
    expect(outcome).toStrictEqual({ teamId: target.teamId, ok: false, error: FALLBACK });
    expect(summary.failed.find((f) => f.teamId === target.teamId)?.error).toBe(FALLBACK);
    expect(FALLBACK, "fixed ASCII").toMatch(ASCII);
    expect(bytes(FALLBACK)).toBeLessThanOrEqual(BUDGET.compoundBytes);

    // The ROW: one failed scheduler row, one error contribution, no metadata.
    const rows = await teamRows(target.teamId);
    expect(rows, "the faulted team still lands exactly one row").toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].trigger).toBe("scheduler");
    expect(rows[0].error_count).toBe(1);
    expect(errorsOf(rows[0])).toEqual([FALLBACK]);
    expect(metaOf(rows[0]), "no envelope — not a malformed one").toEqual({});
    const stored = JSON.stringify({ errors: errorsOf(rows[0]), meta: metaOf(rows[0]), globals: globals.map((r) => ({ errors: errorsOf(r), meta: metaOf(r) })) });
    for (const leak of [BUILDER_FAULT, "fault-marker", "refusing to adopt"]) {
      expect(stored, `the fallback formats nothing: '${leak}'`).not.toContain(leak);
    }

    // The fleet went on: the clean team is green, and the failing one AFTER it has normal evidence.
    const cleanRows = await teamRows(before.teamId);
    expect(cleanRows).toHaveLength(1);
    expect(cleanRows[0].ok).toBe(true);
    expect(metaOf(cleanRows[0])).toEqual({});
    const laterRows = await teamRows(after.teamId);
    expect(laterRows, "the other failing team lands its own row").toHaveLength(1);
    expect(expectEnvelopeInvariants(laterRows[0], after.teamId).sample.map((s) => s.groupId)).toEqual([vendors]);
    expect(globals.map((r) => r.source), "and nothing is promoted to a fleet-level failure").toEqual(["access_bootstrap_all"]);
    expect(globals[0].ok).toBe(true);

    // Legacy-readable: the actual reader, decoder and panel show the error and no disclosure.
    const { runs, html, blocks } = await panelFor(target.teamId);
    const own = runs.filter((r) => r.source === "access_bootstrap" && r.team_id === target.teamId);
    expect(own).toHaveLength(1);
    expect(decodeBootstrapEvidence(own[0]), "there is nothing to decode").toBeNull();
    expect(blocks, "and nothing to disclose").toEqual([]);
    expect(html).toContain("failed (1)");
    expect(html).toContain(escapeHtml(FALLBACK.slice(0, 120)));
    expect(html).toContain(`title="${escapeHtml(FALLBACK)}"`);

    // Fixture precondition, checked LAST (as the extraction criteria do): "later progress" needs a
    // team converged after the faulted one.
    expect(order.indexOf(target.teamId), "fixture: a team is converged after the faulted one").toBeLessThan(order.length - 1);
  });

  it("the builder faulting for EVERY team: a healthy team stays green, and each failing phase keeps its fixed name", async () => {
    const healthy = await bareTeam();
    const unread = await bareTeam();
    const wedged = await bareTeam();
    await wedgeGeneral(wedged);
    faultBuilder("every");

    const { outcomes, summary, globals } = await fleetTick(intercept([censusReturns(unread.teamId, "census exploded")]));

    // A formatting fault must not convert a healthy result into a failure.
    expect(outcomes.find((o) => o.teamId === healthy.teamId), "exactly the clean outcome").toStrictEqual({ teamId: healthy.teamId, ok: true });
    expect(summary.failed.some((f) => f.teamId === healthy.teamId)).toBe(false);
    const healthyRows = await teamRows(healthy.teamId);
    expect(healthyRows).toHaveLength(1);
    expect(healthyRows[0].ok, "a healthy team is not reddened by the formatter").toBe(true);
    expect(healthyRows[0].error_count).toBe(0);
    expect(errorsOf(healthyRows[0])).toEqual([]);
    expect(metaOf(healthyRows[0])).toEqual({});

    // An unreadable census is UNAVAILABLE in the fallback too — never a count, never zero.
    expect(outcomes.find((o) => o.teamId === unread.teamId)).toStrictEqual({
      teamId: unread.teamId,
      ok: false,
      error: "census: unavailable (evidence unavailable)",
    });
    const unreadRows = await teamRows(unread.teamId);
    expect(unreadRows).toHaveLength(1);
    expect(unreadRows[0].ok).toBe(false);
    expect(errorsOf(unreadRows[0])).toEqual(["census: unavailable (evidence unavailable)"]);
    expect(metaOf(unreadRows[0])).toEqual({});

    // A lone convergence failure with a clean census names convergence alone.
    expect(outcomes.find((o) => o.teamId === wedged.teamId)).toStrictEqual({
      teamId: wedged.teamId,
      ok: false,
      error: "convergence: failed (evidence unavailable)",
    });
    const wedgedRows = await teamRows(wedged.teamId);
    expect(wedgedRows).toHaveLength(1);
    expect(wedgedRows[0].ok).toBe(false);
    expect(errorsOf(wedgedRows[0])).toEqual(["convergence: failed (evidence unavailable)"]);
    expect(metaOf(wedgedRows[0])).toEqual({});

    // Every team faulted and every team still reported, so the loop survived each fault — whatever
    // order the teams were read in.
    const called = new Set(vi.mocked(buildBootstrapEvidence).mock.calls.map((c) => c[0].teamId));
    for (const seed of [healthy, unread, wedged]) expect(called.has(seed.teamId), "the builder was reached for every team").toBe(true);
    expect(globals.map((r) => r.source), "and no fleet-level failure was written").toEqual(["access_bootstrap_all"]);
    const stored = JSON.stringify([...healthyRows, ...unreadRows, ...wedgedRows].map((r) => ({ errors: errorsOf(r), meta: metaOf(r) })));
    for (const leak of [BUILDER_FAULT, "census exploded", "refusing to adopt"]) {
      expect(stored, `the fallback formats nothing: '${leak}'`).not.toContain(leak);
    }
  });
});

// ── AC07 / AC08 ──────────────────────────────────────────────────────────────────────────────────

describe("AUDITFIX-25 AC07: the real own-team-plus-NULL reader isolates evidence by team", () => {
  it("team A reads its own evidence and the safe global rows, and nothing of team B's", async () => {
    const a = await bareTeam();
    const b = await bareTeam();
    const alpha = await ordinaryGroup(a, "alpha-marker-group");
    const bravo = await ordinaryGroup(b, "bravo-marker-group");
    await plant(a, await projectId(a, GENERAL_SLUG), alpha);
    await plant(b, await projectId(b, GENERAL_SLUG), bravo);

    await runAccessBootstrapLeg(db());

    const { runs, html, blocks } = await panelFor(a.teamId);
    const own = runs.filter((r) => r.source === "access_bootstrap" && r.team_id === a.teamId);
    expect(own, "A's own failed row is returned").toHaveLength(1);
    const evidence = (jsonOf<Record<string, unknown>>(own[0].meta, {}).accessBootstrapEvidence ?? null) as Evidence | null;
    expect(evidence?.teamId, "carrying A's envelope").toBe(a.teamId);
    expect(evidence?.sample.map((s) => s.groupId)).toEqual([alpha]);

    expect(runs.every((r) => r.team_id === a.teamId || r.team_id === null), "only own-team and NULL-team rows").toBe(true);
    const beat = runs.filter((r) => r.team_id === null);
    expect(beat.map((r) => r.source), "the safe global row is merged in").toEqual(["access_bootstrap_all"]);
    expect(jsonOf<Record<string, unknown>>(beat[0].meta, {})).toEqual({ teams: 2, failedTeams: 2, fleetOk: true });
    // Dropping the reader's team filter turns every one of these red.
    for (const secret of [b.teamId, bravo, "bravo-marker-group"]) {
      expect(JSON.stringify(runs), `the reader must not return '${secret}'`).not.toContain(secret);
      expect(html, `and the panel must not render '${secret}'`).not.toContain(secret);
    }
    expect(blocks, "A's row has exactly one disclosure").toHaveLength(1);
    expect(blocks[0].text).toContain(alpha);
  });
});

describe("AUDITFIX-25 AC08: every normal state round-trips producer → jsonb → reader → the actual panel", () => {
  type State = { seed: Seed; client: DbClient; ids: string[] };

  const states: { name: string; unavailable: boolean; build: () => Promise<State> }[] = [
    {
      name: "convergence failed, census complete with zero findings",
      unavailable: false,
      build: async () => {
        const seed = await bareTeam();
        await wedgeGeneral(seed);
        return { seed, client: db(), ids: [] };
      },
    },
    {
      name: "convergence ok, census complete with findings",
      unavailable: false,
      build: async () => {
        const seed = await bareTeam();
        const project = await rawProject(seed, "legacy-system", "system");
        const group = await rawGroup(seed, `<img src=x onerror="alert('g')">&amp;`);
        await plant(seed, project, group);
        return { seed, client: db(), ids: [project, group] };
      },
    },
    {
      name: "convergence failed, census complete with findings",
      unavailable: false,
      build: async () => {
        const seed = await bareTeam();
        const project = await projectId(seed, EXTERNAL_SHARED_SLUG);
        const group = await ordinaryGroup(seed, "vendors");
        await plant(seed, project, group);
        await wedgeGeneral(seed);
        return { seed, client: db(), ids: [project, group] };
      },
    },
    {
      // Boundary trim: twenty findings, fewer than sixteen samples survive the 8,192-byte measurement.
      name: "convergence ok, census complete with a byte-trimmed hostile sample",
      unavailable: false,
      build: async () => {
        const seed = await bareTeam();
        await hostileFindings(seed);
        return { seed, client: db(), ids: [] };
      },
    },
    {
      name: "convergence ok, census failed",
      unavailable: true,
      build: async () => {
        const seed = await bareTeam();
        return { seed, client: intercept([censusReturns(seed.teamId, "census exploded")]), ids: [] };
      },
    },
    {
      name: "convergence failed, census failed",
      unavailable: true,
      build: async () => {
        const seed = await bareTeam();
        await wedgeGeneral(seed);
        return { seed, client: intercept([censusThrows(seed.teamId, new Error("census exploded"))]), ids: [] };
      },
    },
  ];

  it.each(states)("$name", async ({ build, unavailable }) => {
    const { seed, client, ids } = await build();
    const t = await tick(client, seed.teamId);
    const e = expectEnvelopeInvariants(t.row, seed.teamId);
    const error = errorsOf(t.row)[0];

    const { html, blocks } = await panelFor(seed.teamId);

    // The existing presentation is KEPT: the failed pill, the short preview and the full title.
    expect(html).toContain("failed (1)");
    expect(html, "the short error preview is still rendered").toContain(escapeHtml(error.slice(0, 120)));
    expect(html, "and the full error is still the title").toContain(`title="${escapeHtml(error)}"`);
    // …and the row ADDITIONALLY discloses its evidence. The base's error-versus-meta ternary renders
    // metadata only when a row has no errors, so a failed row shows none.
    expect(blocks, "one native <details> for the one failed evidence row").toHaveLength(1);
    expect(blocks[0].attrs, "closed by default").not.toMatch(/\bopen\b/);
    expect(blocks[0].summary, "a concise Evidence summary").toMatch(/evidence/i);
    expect(blocks[0].text).toMatch(/convergence/i);
    expect(blocks[0].text).toMatch(/census/i);
    if (unavailable) {
      expect(e.census.total).toBeNull();
      expect(blocks[0].text, "an unavailable count is SAID, never shown as zero").toMatch(/unavailable/i);
    } else {
      expect(blocks[0].text, "the exact total").toMatch(new RegExp(`\\b${e.census.total}\\b`));
      expect(blocks[0].text, "and the omitted count").toMatch(new RegExp(`\\b${e.omitted}\\b`));
      expect(blocks[0].text).not.toMatch(/unavailable/i);
    }
    for (const id of ids) expect(blocks[0].text, "sampled identities are exact UUIDs").toContain(id);
    // Hostile names are React text: never raw markup, here or anywhere else in the panel.
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/onerror="alert/);
    if (ids.length > 0 && e.sample.some((s) => s.groupSlug.includes("<img"))) {
      expect(blocks[0].html, "the hostile label is present, escaped").toContain("&lt;img src=x onerror=");
    }
  });

  // The DECODER, directly: the panel assertions above would also pass for a decoder that returned a
  // differently-shaped projection the panel happened to render. This pins identity — what the real
  // producer stored is exactly what the real decoder returns for the real reader's row — and the
  // row-scope refusals on those same produced rows, rather than on fabricated envelopes.
  it.each(states)("$name — the ACTUAL decoder returns exactly the stored envelope for the reader's row", async ({ build }) => {
    const { seed, client } = await build();
    const stranger = await bareTeam();
    const t = await tick(client, seed.teamId);
    const stored = expectEnvelopeInvariants(t.row, seed.teamId);

    const runs = await listRecentIngestRuns(db(), seed.teamId, 30);
    const own = runs.filter((r) => r.source === "access_bootstrap" && r.team_id === seed.teamId);
    expect(own, "the reader returns this team's one failed row").toHaveLength(1);

    const decoded = decodeBootstrapEvidence(own[0]);
    expect(decoded, "producer → jsonb → reader → decoder is an identity on the envelope").toStrictEqual(stored);
    expect(decoded, "and it is what the producer handed its callback").toEqual(t.outcome!.evidence);
    // The legacy JSON-string form of the SAME stored metadata decodes identically.
    const asString = typeof own[0].meta === "string" ? own[0].meta : JSON.stringify(own[0].meta);
    expect(decodeBootstrapEvidence({ ...own[0], meta: asString })).toStrictEqual(stored);

    // Row scope, on the real row: the same metadata is not evidence anywhere else.
    expect(decodeBootstrapEvidence({ ...own[0], team_id: stranger.teamId }), "another team's row").toBeNull();
    expect(decodeBootstrapEvidence({ ...own[0], team_id: null }), "a NULL-team row").toBeNull();
    expect(decodeBootstrapEvidence({ ...own[0], ok: true }), "an ok row").toBeNull();
    expect(decodeBootstrapEvidence({ ...own[0], source: "access_bootstrap_all" }), "the liveness source").toBeNull();
    // …and no other row the reader merged in decodes to anything.
    for (const other of runs.filter((r) => r !== own[0])) {
      expect(decodeBootstrapEvidence(other), `row ${other.id} (${other.source}) carries no evidence`).toBeNull();
    }
  });

  it("a clean team's row carries nothing for the decoder or the panel", async () => {
    const seed = await bareTeam();
    await tick(db(), seed.teamId);

    const { runs, blocks } = await panelFor(seed.teamId);
    const own = runs.filter((r) => r.source === "access_bootstrap" && r.team_id === seed.teamId);
    expect(own).toHaveLength(1);
    expect(own[0].ok).toBe(true);
    expect(decodeBootstrapEvidence(own[0]), "healthy means no evidence").toBeNull();
    expect(blocks).toEqual([]);
  });
});

// ── AC10 ─────────────────────────────────────────────────────────────────────────────────────────

describe("AUDITFIX-25 AC10: the team's pipeline card carries the stored compound, at the existing threshold", () => {
  it("one tick is unconfirmed; two ticks confirm ONCE, name both arms, and leave another team healthy", async () => {
    const short = await bareTeam();
    const long = await bareTeam();
    const healthy = await bareTeam();
    await plant(short, await projectId(short, EXTERNAL_SHARED_SLUG), await ordinaryGroup(short, "vendors"));
    await plant(long, await projectId(long, EXTERNAL_SHARED_SLUG), await ordinaryGroup(long, "vendors"));
    await wedgeGeneral(long);
    const client = intercept([convergenceThrows(short.teamId, new Error("groups read exploded"))]);
    const SHORT = "census: 1 unsanctioned edge(s) on system projects: external-shared→vendors; convergence: groups read exploded";
    const LONG = `census: 1 unsanctioned edge(s) on system projects: external-shared→vendors; convergence: ${WEDGE_ERROR}`;
    expect(SHORT.length, "fixture: the short compound fits the banner's raw clip").toBeLessThanOrEqual(RAW_ERROR_CLIP);
    expect(LONG.length, "fixture: the long compound exceeds it").toBeGreaterThan(RAW_ERROR_CLIP);
    const legOf = async (teamId: string) => {
      const health = await getPipelineHealth(teamId);
      return { health, leg: health.legs.find((l) => l.source === "access_bootstrap") };
    };

    await runAccessBootstrapLeg(client);
    const lone = await legOf(short.teamId);
    // ONE error contribution per tick: a second summary write would confirm after a single failure.
    expect(lone.leg?.failureClass, "a lone failed tick is not confirmed").toBe("unconfirmed");
    expect(lone.health.failing.some((l) => l.source === "access_bootstrap")).toBe(false);

    await runAccessBootstrapLeg(client);
    const confirmed = await legOf(short.teamId);
    expect(confirmed.leg?.failureClass).toBe("confirmed");
    expect(confirmed.health.failing.some((l) => l.source === "access_bootstrap"), "and it is loud").toBe(true);
    expect(confirmed.leg?.error, "the card carries the stored compound — both arms").toBe(SHORT);
    expect(legDetail(confirmed.leg!).raw, "a short compound is shown whole: both phases visibly named").toBe(SHORT);

    const clipped = await legOf(long.teamId);
    expect(clipped.leg?.failureClass).toBe("confirmed");
    expect(clipped.leg?.error, "the leg keeps the FULL stored compound").toBe(LONG);
    expect(legDetail(clipped.leg!).raw, "a long one keeps the existing 160-character clip").toBe(`${LONG.slice(0, RAW_ERROR_CLIP)}…`);

    const other = await legOf(healthy.teamId);
    expect(other.leg?.ok, "the healthy team's own row is a success").toBe(true);
    expect(other.health.failing.some((l) => l.source === "access_bootstrap")).toBe(false);
    expect(other.health.healthy).toBe(true);
  });
});
