import "server-only";
import { isOpenStatus } from "@/lib/tasks/activity-policy";
import { runSql } from "@/lib/db/pg/pool";
import { newSqlParams, provenanceRowSqlFromIds } from "@/lib/access/provenance-sql";
import type { DbClient } from "@/lib/db/types";
import { rangeDays, type Range } from "./range";
import { getSpendDailyUsd, getSpendTotalUsdBetween } from "./llm-spend";
import {
  scopeQueryLog,
  visibleItems,
  type ViewerTier,
} from "@/lib/auth/visibility";

/**
 * Range-aware dashboard metrics. In postgres mode there is NO RLS, so row-level scoping is NOT
 * automatic — it is all applied here in app code (CLAUDE.md §5):
 *   • query_log / llm_usage via `scopeQueryLog` / `scopeLlmUsage` — a member sees only their own
 *     queries/spend, an admin the whole team's (role-scoped).
 *   • items / tasks via `visibleItems` / `visibleTasks` — a restricted (`external`) viewer sees only
 *     `access='external'` items and `audience='external'` tasks (tier-scoped). The home page routes
 *     any member with their own API key into the dashboard, INCLUDING an external one, so these
 *     aggregates MUST be tier-scoped — an unfiltered team-wide count quantifies internal activity
 *     (knowledge growth by kind, the task funnel) to a client collaborator.
 *
 * Aggregation is done in JS over rows fetched within the window. That is fine
 * at MVP volumes; if the corpus grows large, move the day-bucketing into SQL
 * RPCs (kept out of v1 to avoid new migrations).
 *
 * Range constants/types live in ./range (client-safe) so client components
 * like the range selector can import them without pulling in `server-only`.
 */

export type KpiAccent = "violet" | "blue" | "cyan" | "amber" | "emerald";

export interface Kpi {
  key: string;
  label: string;
  value: string;
  /** Percent change vs. the prior equal-length window; null when not meaningful. */
  delta: number | null;
  /** Daily series across the window, for a sparkline. */
  spark: number[];
  hint?: string;
  /** Plain-language "what is this / how is it computed" copy for the "?" popover. */
  help?: string;
  /** When set, the whole stat card links here (e.g. Spend → the costs breakdown page). */
  href?: string;
  accent: KpiAccent;
}

/** One item-kind stacked into the knowledge-growth chart. */
export const ITEM_KINDS = [
  "deliverable",
  "transcript",
  "decision",
  "task",
  "artifact",
  "skill",
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export interface KnowledgePoint {
  date: string;
  deliverable: number;
  transcript: number;
  decision: number;
  task: number;
  artifact: number;
  skill: number;
}

export interface UsagePoint {
  date: string;
  queries: number;
  cost: number;
}

export interface FunnelPoint {
  status: string;
  label: string;
  count: number;
}

export interface PulseMetrics {
  kpis: Kpi[];
  knowledge: KnowledgePoint[];
  usage: UsagePoint[];
  funnel: FunnelPoint[];
}

// ── date bucketing ──────────────────────────────────────────────────────────

interface Bucket {
  key: string; // YYYY-MM-DD (UTC)
  label: string; // e.g. "Jun 4"
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Normalize a timestamptz to an ISO string. CRITICAL: the postgres adapter (the deployed backend)
 * returns timestamptz columns as **Date objects**, whereas the legacy Supabase-js client returned
 * ISO strings. The window math below compares/slices these as strings, and `Date >= isoString`
 * coerces the string to NaN (→ always false), which silently bucketed every recent row as "prior" —
 * the dashboard read 0 with ↓100% on postgres. Mirrors lib/query/retrieve.ts. Still accepts
 * `string | Date` so a caller passing either shape normalizes correctly.
 */
function toIso(v: string | Date): string {
  return typeof v === "string" ? v : new Date(v).toISOString();
}

/** One bucket per day, oldest → newest, ending today. */
function buildBuckets(days: number, now: Date): Bucket[] {
  const out: Bucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    out.push({
      key: isoDay(d),
      label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    });
  }
  return out;
}

function pctDelta(current: number, prior: number): number | null {
  if (prior === 0) return current === 0 ? 0 : null;
  return Math.round(((current - prior) / prior) * 100);
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

const FUNNEL_ORDER: { status: string; label: string }[] = [
  { status: "backlog", label: "Backlog" },
  { status: "ready", label: "Ready" },
  { status: "in_progress", label: "In progress" },
  { status: "in_review", label: "In review" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];



// ── main ─────────────────────────────────────────────────────────────────────

export async function getPulseMetrics(
  db: DbClient,
  teamId: string,
  range: Range,
  viewer: {
    isAdmin: boolean;
    memberId: string;
    tier: ViewerTier;
    /** ENFB-2 §2.2: the viewer's oracle ctx — DISPLAYED counts compute over the visible sets
     *  (per-kind item growth and the task funnel were team-wide volume disclosures). Absent →
     *  fail closed (empty sets → zero counts). */
    provCtx?: { visibleItemIds: ReadonlySet<string>; teamPosture: boolean; principal?: "member" | "token" };
  }
): Promise<PulseMetrics> {
  const { isAdmin, tier } = viewer;
  // Member-only surface (AUDITFIX-1 §2a): the Pulse dashboard is session-authenticated.
  const provCtx = viewer.provCtx ?? { visibleItemIds: new Set<string>(), teamPosture: false, principal: "member" as const };
  const days = rangeDays(range);
  const now = new Date();
  const windowStart = new Date(now.getTime() - days * 86_400_000);
  const priorStart = new Date(now.getTime() - 2 * days * 86_400_000);
  const buckets = buildBuckets(days, now);
  const order = buckets.map((b) => b.key);
  const index = new Map(order.map((k, i) => [k, i]));

  // Fetch each source once over the combined [prior, now] window where a delta
  // is needed, then split current vs. prior in JS.
  const [itemsRes, queryRes, tasksRes] = await Promise.all([
    // Knowledge growth reads `created_at` (first-seen), NOT `synced_at`: the scheduler bumps synced_at
    // on every 30-min tick, so windowing on it plots re-sync churn (≈all items look "new") rather than
    // real growth. created_at is set once on insert and never bumped. See postgres migration items_created_at.
    // Only the current window is needed (the prior-window delta died with the removed "Items synced" KPI).
    // ENFB-2 §2.2: growth counts only VISIBLE items (the per-kind team-wide volume was the
    // disclosure); the posture helper stays a conjunct via the id set (which posture already
    // scoped upstream).
    visibleItems(
      db
        .from("items")
        .select("kind, created_at")
        .eq("team_id", teamId)
        .in("id", [...provCtx.visibleItemIds])
        .gte("created_at", windowStart.toISOString())
        .order("created_at", { ascending: false })
        .limit(10_000),
      tier
    ),
    scopeQueryLog(
      db
        .from("query_log")
        .select("cost_usd, created_at")
        .eq("team_id", teamId)
        .gte("created_at", priorStart.toISOString())
        .order("created_at", { ascending: false })
        .limit(10_000),
      viewer
    ),
    // ENFB-2 §2.2: the funnel counts only provenance-visible tasks, IN-QUERY (a post-filtered
    // 5,000-row sample would be starvable AND biased; the audience conjunct is preserved).
    (() => {
      const p = newSqlParams();
      const access = tier === "team" ? "" : `and t.audience = 'external'`;
      return runSql<{ status: string; updated_at: string | Date | null }>(
        `select t.status, t.updated_at from tasks t
          where t.team_id = ${p.add(teamId)} ${access}
            and ${provenanceRowSqlFromIds("t", p, provCtx)}
          limit 5000`,
        p.values
      )
        .then((r) => ({ data: r.rows, error: null }))
        .catch((e) => {
          // LOUD on failure (Fable diff L12): the old shape merely didn't check its error;
          // this one must not make failure unreportable by construction.
          console.warn("[pulse] task funnel read failed:", e instanceof Error ? e.message : e);
          return { data: [] as { status: string; updated_at: string | Date | null }[], error: null };
        });
    })(),
  ]);

  // Brain SPEND is ALL inference (Q&A + arcs + meetings + timeline + social + titles + cron), read
  // from the `llm_usage` ledger — NOT `query_log`, which only meters the interactive Query box. The
  // Queries KPI above still counts query_log (adoption); spend is the total cost of running the brain.
  //
  // Aggregated in Postgres via `lib/metrics/llm-spend`. This previously fetched up to 50,000 rows and
  // summed them here, which silently under-reported once the window held more: production showed
  // $18.62 against a true $98.84, while the /costs page's larger 100k cap showed $88.33 for the SAME
  // window. One shared aggregate is what keeps the two surfaces from disagreeing again.
  const [spendCurrent, spendPrior, spendByDay] = await Promise.all([
    getSpendTotalUsdBetween(db, teamId, windowStart.toISOString(), null, viewer),
    getSpendTotalUsdBetween(db, teamId, priorStart.toISOString(), windowStart.toISOString(), viewer),
    getSpendDailyUsd(db, teamId, windowStart.toISOString(), viewer),
  ]);

  // NB: the pg adapter returns timestamptz as Date (legacy Supabase-js returned string). Normalize via toIso below.
  const itemRows = (itemsRes.data ?? []) as { kind: string; created_at: string | Date }[];
  const queryRows = (queryRes.data ?? []) as { cost_usd: number | string; created_at: string | Date }[];
  const taskRows = (tasksRes.data ?? []) as { status: string; updated_at: string | Date }[];

  const winStartIso = windowStart.toISOString();
  const inWindow = (iso: string) => iso >= winStartIso;

  // ── knowledge growth (new items / day, by first-seen created_at) ──
  const knowledge: KnowledgePoint[] = buckets.map((b) => ({
    date: b.label,
    deliverable: 0,
    transcript: 0,
    decision: 0,
    task: 0,
    artifact: 0,
    skill: 0,
  }));
  for (const row of itemRows) {
    const createdIso = toIso(row.created_at);
    if (!inWindow(createdIso)) continue;
    const i = index.get(createdIso.slice(0, 10));
    if (i !== undefined) {
      const kind = (ITEM_KINDS as readonly string[]).includes(row.kind)
        ? (row.kind as ItemKind)
        : "artifact";
      knowledge[i][kind]++;
    }
  }

  // ── brain usage: queries per day (adoption) from query_log ──
  const usage: UsagePoint[] = buckets.map((b) => ({ date: b.label, queries: 0, cost: 0 }));
  const querySpark = new Array(order.length).fill(0);
  let queriesCurrent = 0;
  let queriesPrior = 0;
  for (const row of queryRows) {
    const createdIso = toIso(row.created_at);
    if (inWindow(createdIso)) {
      queriesCurrent++;
      const i = index.get(createdIso.slice(0, 10));
      if (i !== undefined) {
        querySpark[i]++;
        usage[i].queries++;
      }
    } else {
      queriesPrior++;
    }
  }

  // ── brain SPEND: total inference cost per day from llm_usage (all sources, not just Q&A) ──
  const spendSpark = new Array(order.length).fill(0);
  for (const [day, cost] of spendByDay) {
    const i = index.get(day);
    if (i === undefined) continue; // a day outside the rendered buckets still counts in the total
    // Daily $ spend for the sparkline (the Sparkline normalizes, so raw dollars are fine — it
    // shows the shape of spend under the Spend KPI).
    spendSpark[i] += cost;
    usage[i].cost += cost;
  }

  // ── tasks: funnel + in-flight KPI + activity spark ──
  const statusCounts = new Map<string, number>();
  const taskSpark = new Array(order.length).fill(0);
  let inFlight = 0;
  let blocked = 0;
  for (const row of taskRows) {
    statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
    if (isOpenStatus(row.status)) inFlight++;
    if (row.status === "blocked") blocked++;
    const updatedIso = toIso(row.updated_at);
    if (inWindow(updatedIso)) {
      const i = index.get(updatedIso.slice(0, 10));
      if (i !== undefined) taskSpark[i]++;
    }
  }
  const funnel: FunnelPoint[] = FUNNEL_ORDER.map((f) => ({
    ...f,
    count: statusCounts.get(f.status) ?? 0,
  }));

  const usageLabel = isAdmin ? "Team queries" : "Your queries";
  const spendLabel = isAdmin ? "Team spend" : "Your spend";
  const scopeWord = isAdmin ? "the whole team's" : "your";

  // KPI band = the meaningful set only. "Items synced" was dropped: it counted synced_at (re-sync
  // churn), so it read ≈the whole corpus every window — no signal. Real new-knowledge is the
  // "Knowledge growth" chart (created_at). What's left are the numbers that actually move: adoption
  // (queries), spend, and work-in-flight.
  const kpis: Kpi[] = [
    {
      key: "queries",
      label: usageLabel,
      value: fmtNum(queriesCurrent),
      delta: pctDelta(queriesCurrent, queriesPrior),
      spark: querySpark,
      hint: `last ${days}d`,
      help: `How many questions were asked to the brain in the last ${days} days (${scopeWord} queries — admins see the team's, everyone else their own). Every answered query writes one row to the query log; this counts them. The arrow is the change vs. the previous ${days}-day window.`,
      accent: "blue",
    },
    {
      key: "tasks",
      label: "Tasks in flight",
      value: fmtNum(inFlight),
      delta: null,
      spark: taskSpark,
      hint: blocked > 0 ? `${blocked} blocked` : "none blocked",
      help: "Open tasks that are actively moving — those in Ready, In progress, In review, or Blocked (Backlog and Done are excluded). The number is a live snapshot across all the team's tasks, so the date range doesn't change it (only the sparkline, which tracks recent task activity per day, does). \"N blocked\" calls out how many of these are stuck.",
      accent: "cyan",
    },
    {
      key: "spend",
      label: spendLabel,
      value: fmtUsd(spendCurrent),
      delta: pctDelta(Math.round(spendCurrent * 1000), Math.round(spendPrior * 1000)),
      spark: spendSpark,
      hint: `last ${days}d`,
      help: `Total LLM inference cost over the last ${days} days (${scopeWord} spend) — every generation the brain makes, not just the Query box: Q&A, meeting extraction, narrative arcs, timeline summaries, social content, chat titles. Each call records its cost — the real charge on OpenRouter (usage.cost), a list-price estimate on Anthropic. Click for the full breakdown by what's costing what. Only spend after metering shipped is captured.`,
      accent: "emerald",
    },
  ];

  return { kpis, knowledge, usage, funnel };
}
