import "server-only";
import type { DbClient } from "@/lib/db/types";
import { rangeDays, type Range } from "./range";
import { scopeQueryLog } from "@/lib/auth/visibility";

/**
 * Range-aware dashboard metrics. In postgres mode there is NO RLS, so query_log row-level
 * scoping is NOT automatic — it is applied here in app code via `scopeQueryLog`: members see
 * only their own queries/spend, admins see the whole team's (CLAUDE.md §5). The items/tasks
 * aggregates are team-wide counts shown only to a team-tier viewer (the home page gates the
 * page on a tier-filtered item count first).
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
 * returns timestamptz columns as **Date objects**, while supabase returns ISO strings. The window
 * math below compares/ slices these as strings, and `Date >= isoString` coerces the string to NaN
 * (→ always false), which silently bucketed every recent row as "prior" — the dashboard read 0 with
 * ↓100% on postgres. Mirrors lib/query/retrieve.ts. Accepts string | Date so both backends work.
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
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

const IN_FLIGHT = new Set(["ready", "in_progress", "blocked"]);

// ── main ─────────────────────────────────────────────────────────────────────

export async function getPulseMetrics(
  supabase: DbClient,
  teamId: string,
  range: Range,
  viewer: { isAdmin: boolean; memberId: string }
): Promise<PulseMetrics> {
  const { isAdmin } = viewer;
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
    supabase
      .from("items")
      .select("kind, synced_at")
      .eq("team_id", teamId)
      .gte("synced_at", priorStart.toISOString())
      .order("synced_at", { ascending: false })
      .limit(10_000),
    scopeQueryLog(
      supabase
        .from("query_log")
        .select("cost_usd, created_at")
        .eq("team_id", teamId)
        .gte("created_at", priorStart.toISOString())
        .order("created_at", { ascending: false })
        .limit(10_000),
      viewer
    ),
    supabase
      .from("tasks")
      .select("status, updated_at")
      .eq("team_id", teamId)
      .limit(5_000),
  ]);

  // NB: the pg adapter returns timestamptz as Date; supabase as string. Normalize via toIso below.
  const itemRows = (itemsRes.data ?? []) as { kind: string; synced_at: string | Date }[];
  const queryRows = (queryRes.data ?? []) as { cost_usd: number | string; created_at: string | Date }[];
  const taskRows = (tasksRes.data ?? []) as { status: string; updated_at: string | Date }[];

  const winStartIso = windowStart.toISOString();
  const inWindow = (iso: string) => iso >= winStartIso;

  // ── knowledge growth + items KPI ──
  const knowledge: KnowledgePoint[] = buckets.map((b) => ({
    date: b.label,
    deliverable: 0,
    transcript: 0,
    decision: 0,
    task: 0,
    artifact: 0,
    skill: 0,
  }));
  const itemSpark = new Array(order.length).fill(0);
  let itemsCurrent = 0;
  let itemsPrior = 0;
  for (const row of itemRows) {
    const syncedIso = toIso(row.synced_at);
    if (inWindow(syncedIso)) {
      itemsCurrent++;
      const i = index.get(syncedIso.slice(0, 10));
      if (i !== undefined) {
        itemSpark[i]++;
        const kind = (ITEM_KINDS as readonly string[]).includes(row.kind)
          ? (row.kind as ItemKind)
          : "artifact";
        knowledge[i][kind]++;
      }
    } else {
      itemsPrior++;
    }
  }

  // ── brain usage + queries / spend KPIs ──
  const usage: UsagePoint[] = buckets.map((b) => ({ date: b.label, queries: 0, cost: 0 }));
  const querySpark = new Array(order.length).fill(0);
  let queriesCurrent = 0;
  let queriesPrior = 0;
  let spendCurrent = 0;
  let spendPrior = 0;
  for (const row of queryRows) {
    const cost = Number(row.cost_usd) || 0;
    const createdIso = toIso(row.created_at);
    if (inWindow(createdIso)) {
      queriesCurrent++;
      spendCurrent += cost;
      const i = index.get(createdIso.slice(0, 10));
      if (i !== undefined) {
        querySpark[i]++;
        usage[i].queries++;
        usage[i].cost += cost;
      }
    } else {
      queriesPrior++;
      spendPrior += cost;
    }
  }

  // ── tasks: funnel + in-flight KPI + activity spark ──
  const statusCounts = new Map<string, number>();
  const taskSpark = new Array(order.length).fill(0);
  let inFlight = 0;
  let blocked = 0;
  for (const row of taskRows) {
    statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
    if (IN_FLIGHT.has(row.status)) inFlight++;
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

  const kpis: Kpi[] = [
    {
      key: "items",
      label: "Items synced",
      value: fmtNum(itemsCurrent),
      delta: pctDelta(itemsCurrent, itemsPrior),
      spark: itemSpark,
      hint: `last ${days}d`,
      accent: "violet",
    },
    {
      key: "queries",
      label: usageLabel,
      value: fmtNum(queriesCurrent),
      delta: pctDelta(queriesCurrent, queriesPrior),
      spark: querySpark,
      hint: `last ${days}d`,
      accent: "blue",
    },
    {
      key: "tasks",
      label: "Tasks in flight",
      value: fmtNum(inFlight),
      delta: null,
      spark: taskSpark,
      hint: blocked > 0 ? `${blocked} blocked` : "none blocked",
      accent: "cyan",
    },
    {
      key: "spend",
      label: spendLabel,
      value: fmtUsd(spendCurrent),
      delta: pctDelta(Math.round(spendCurrent * 1000), Math.round(spendPrior * 1000)),
      spark: querySpark,
      hint: `last ${days}d`,
      accent: "emerald",
    },
  ];

  return { kpis, knowledge, usage, funnel };
}
