import "server-only";
import type { DbClient } from "@/lib/db/types";
import type { MaturitySnapshotPayload } from "@/lib/api/schemas";
import { canSeeMaturity, type ViewerTier } from "@/lib/metrics/individual-maturity-visibility";

/**
 * Canonical AEM individual-scope scoring + the single write path for
 * `agentic_maturity_snapshots`. The client (`scripts/analyze/aem.mjs`) computes a
 * PROVISIONAL placement for its local report; the brain RECOMPUTES the canonical
 * placement here from the pushed signals so team rollups have one authority. The
 * thresholds below MUST stay in sync with aem.mjs (mirrored intentionally — there
 * is no shared runtime between a Node CLI and this TS service).
 *
 * Maps to agentic-engineering-maturity/04-assessment-rubrics.md §1.
 */

export type AemSignals = MaturitySnapshotPayload["signals"];
export type AemAxes = {
  verification: number;
  context_hygiene: number;
  autonomy: number;
  learning: number;
  cost_governance: number;
};
export type AemPlacement = { axes: AemAxes; spine: string; overall: number };

/** Axis order + labels for the radar (one source of truth for the UI). */
export const AXIS_META: { key: keyof AemAxes; label: string }[] = [
  { key: "verification", label: "Verification" },
  { key: "context_hygiene", label: "Context hygiene" },
  { key: "autonomy", label: "Autonomy / leash" },
  { key: "learning", label: "Learning / compounding" },
  { key: "cost_governance", label: "Cost & governance" },
];

/** Weakest axis → the next pattern to work on (mirrors the CLI report). */
export const PRESCRIPTION: Record<keyof AemAxes, string> = {
  verification: "B2 — give the agent a check it can run (tests/build) before you accept",
  context_hygiene: "curate a CLAUDE.md and /clear between tasks; isolate exploration in subagents",
  autonomy: "earn a longer leash: auto-accept low-risk actions behind a check",
  learning: "feed corrections back into CLAUDE.md / build a reusable skill",
  cost_governance: "tighten tokens-per-task: smaller fresh context, cheaper model tier",
};

/** First threshold whose `min` the value clears (bands sorted high→low). */
function band(value: number, bands: [number, number][]): number {
  for (const [min, score] of bands) if (value >= min) return score;
  return 0;
}

// Verification: rate of verification-tool (shell) invocations — the agent running
// checks it can act on. Coarse proxy (command bodies are intentionally invisible).
export function scoreVerification(s: AemSignals): number {
  return band(s.verify_tool_rate, [[0.25, 4], [0.12, 3], [0.04, 2], [0.005, 1]]);
}
// Context hygiene: prompt-cache hit rate (reuse of a maintained context).
export function scoreContextHygiene(s: AemSignals): number {
  return band(s.cache_hit_rate, [[0.7, 4], [0.5, 3], [0.3, 2], [0.05, 1]]);
}
// Autonomy / leash: delegation ratio + active permission management.
export function scoreAutonomy(s: AemSignals): number {
  const byDelegation = band(s.delegation_ratio, [[0.25, 4], [0.1, 3], [0.02, 2]]);
  const floor = s.subagent_usage > 0 ? 1 : 0;
  return Math.max(byDelegation, floor);
}
// Learning / compounding: tool-diversity proxy, CAPPED at 3 (logs can't observe
// cross-session rule write-back).
export function scoreLearning(s: AemSignals): number {
  return Math.min(3, band(s.tool_diversity, [[6, 3], [3, 2], [1, 1]]));
}
// Cost & governance: fresh tokens per task (cache reads excluded), inverted bands.
export function scoreCostGovernance(s: AemSignals): number {
  if (s.tokens_per_task <= 0) return 0;
  if (s.tokens_per_task <= 40_000) return 4;
  if (s.tokens_per_task <= 90_000) return 3;
  if (s.tokens_per_task <= 180_000) return 2;
  return 1;
}

const VERIFICATION_GATE = 1; // cap Spine at L3 when verification ≤ this

export function scoreAxes(s: AemSignals): AemAxes {
  return {
    verification: scoreVerification(s),
    context_hygiene: scoreContextHygiene(s),
    autonomy: scoreAutonomy(s),
    learning: scoreLearning(s),
    cost_governance: scoreCostGovernance(s),
  };
}

/** Spine L1–L5 with the rubric's verification gate. Mirrors aem.mjs.spineLevel. */
export function spineLevel(axes: AemAxes, s: AemSignals): string {
  let level = 1;
  if (axes.cost_governance >= 2 || axes.learning >= 1) level = 2;
  if (axes.context_hygiene >= 2) level = 3;
  if (axes.verification >= 2 && axes.autonomy >= 2) level = 4;
  if (axes.autonomy >= 3 && axes.verification >= 3 && axes.learning >= 3 && s.subagent_usage >= 0.3) {
    level = 5;
  }
  if (axes.verification <= VERIFICATION_GATE) level = Math.min(level, 3);
  return `L${level}`;
}

export function placement(s: AemSignals): AemPlacement {
  const axes = scoreAxes(s);
  const overall = Math.round((Object.values(axes).reduce((a, b) => a + b, 0) / 5) * 100) / 100;
  return { axes, spine: spineLevel(axes, s), overall };
}

// ── Dashboard reads (tier-gated; team-only, no RLS backstop) ─────────────────

const AXIS_COLS = [
  "canonical_verification", "canonical_context_hygiene", "canonical_autonomy",
  "canonical_learning", "canonical_cost_governance",
] as const;

// Postgres `date` columns arrive as Date objects (at local midnight) via the pg
// adapter; naive toISOString() is off-by-one. Format from local components, or
// pass through an already-string value. Mirrors lib/metrics/codebases.dayStr.
function dayStr(v: string | Date): string {
  if (typeof v === "string") return v.slice(0, 10);
  return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
}

type SnapshotRow = {
  member_id: string;
  snapshot_date: string | Date;
  canonical_spine: string;
  canonical_overall: number;
  canonical_verification: number;
  canonical_context_hygiene: number;
  canonical_autonomy: number;
  canonical_learning: number;
  canonical_cost_governance: number;
  ce_band: number | null;
  tasks: number;
  sessions: number;
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
};

function rowAxes(r: SnapshotRow): AemAxes {
  return {
    verification: Number(r.canonical_verification),
    context_hygiene: Number(r.canonical_context_hygiene),
    autonomy: Number(r.canonical_autonomy),
    learning: Number(r.canonical_learning),
    cost_governance: Number(r.canonical_cost_governance),
  };
}

export type MemberMaturityCard = {
  member_id: string;
  handle: string;
  name: string;
  avatar_url: string | null;
  date: string;
  spine: string;
  overall: number;
  ce_band: number | null;
  axes: AemAxes;
  tasks: number;
  sessions: number;
  total_cost_usd: number;
  total_tokens: number;
  weakest: keyof AemAxes;
};

export type TeamMaturity = {
  asOf: string | null;
  members: MemberMaturityCard[];
  teamAxes: AemAxes;
  spineDistribution: Record<string, number>;
};

function weakestOf(axes: AemAxes): keyof AemAxes {
  return (Object.entries(axes) as [keyof AemAxes, number][]).sort((a, b) => a[1] - b[1])[0][0];
}

function averageAxes(rows: AemAxes[]): AemAxes {
  const sum: AemAxes = { verification: 0, context_hygiene: 0, autonomy: 0, learning: 0, cost_governance: 0 };
  for (const a of rows) for (const k of Object.keys(sum) as (keyof AemAxes)[]) sum[k] += a[k];
  const n = rows.length || 1;
  for (const k of Object.keys(sum) as (keyof AemAxes)[]) sum[k] = Math.round((sum[k] / n) * 100) / 100;
  return sum;
}

/**
 * Team view: each member's LATEST snapshot, the team-average axes (radar), and the
 * Spine distribution. Team-tier only — an external viewer gets an empty board.
 */
export async function getTeamMaturity(
  supabase: DbClient,
  teamId: string,
  tier: ViewerTier
): Promise<TeamMaturity> {
  if (!canSeeMaturity(tier)) return { asOf: null, members: [], teamAxes: averageAxes([]), spineDistribution: {} };

  const { data: snaps } = await supabase
    .from("agentic_maturity_snapshots")
    .select(
      `member_id, snapshot_date, canonical_spine, canonical_overall, ce_band, tasks, sessions,
       total_cost_usd, input_tokens, output_tokens, cache_read_tokens, ${AXIS_COLS.join(", ")}`
    )
    .eq("team_id", teamId)
    .eq("metric", "aem-individual")
    .order("snapshot_date", { ascending: false });

  const rows = (snaps ?? []) as unknown as SnapshotRow[];
  // latest snapshot per member (rows already date-desc)
  const latest = new Map<string, SnapshotRow>();
  for (const r of rows) if (!latest.has(r.member_id)) latest.set(r.member_id, r);

  const memberIds = [...latest.keys()];
  const nameById = new Map<string, { handle: string; name: string; avatar: string | null }>();
  if (memberIds.length) {
    const { data: members } = await supabase
      .from("members")
      .select("id, actor_handle, display_name, avatar_url")
      .in("id", memberIds);
    for (const m of (members ?? []) as { id: string; actor_handle: string; display_name: string; avatar_url: string | null }[]) {
      nameById.set(m.id, { handle: m.actor_handle, name: m.display_name, avatar: m.avatar_url });
    }
  }

  const cards: MemberMaturityCard[] = [...latest.values()].map((r) => {
    const axes = rowAxes(r);
    const info = nameById.get(r.member_id);
    return {
      member_id: r.member_id,
      handle: info?.handle ?? "unknown",
      name: info?.name ?? "Unknown",
      avatar_url: info?.avatar ?? null,
      date: dayStr(r.snapshot_date),
      spine: r.canonical_spine,
      overall: Number(r.canonical_overall),
      ce_band: r.ce_band == null ? null : Number(r.ce_band),
      axes,
      tasks: Number(r.tasks),
      sessions: Number(r.sessions),
      total_cost_usd: Number(r.total_cost_usd ?? 0),
      total_tokens: Number(r.input_tokens ?? 0) + Number(r.output_tokens ?? 0) + Number(r.cache_read_tokens ?? 0),
      weakest: weakestOf(axes),
    };
  }).sort((a, b) => b.overall - a.overall);

  const spineDistribution: Record<string, number> = {};
  for (const c of cards) spineDistribution[c.spine] = (spineDistribution[c.spine] ?? 0) + 1;

  return {
    asOf: cards.length ? cards.map((c) => c.date).sort().at(-1)! : null,
    members: cards,
    teamAxes: averageAxes(cards.map((c) => c.axes)),
    spineDistribution,
  };
}

export type MemberTimelinePoint = { date: string } & AemAxes & {
  overall: number;
  ce_band: number | null;
};
export type MemberMaturity = {
  handle: string;
  name: string;
  avatar_url: string | null;
  latest: MemberMaturityCard;
  timeline: MemberTimelinePoint[];
  teamAxes: AemAxes;
  prescription: string;
};

/**
 * Member deep-dive: their snapshot timeline + latest placement + the team average
 * (for the comparison radar) + the weakest-axis prescription. Team-tier only.
 */
export async function getMemberMaturity(
  supabase: DbClient,
  teamId: string,
  handle: string,
  tier: ViewerTier
): Promise<MemberMaturity | null> {
  if (!canSeeMaturity(tier)) return null;

  const { data: member } = await supabase
    .from("members")
    .select("id, actor_handle, display_name, avatar_url")
    .eq("team_id", teamId)
    .eq("actor_handle", handle)
    .maybeSingle();
  if (!member) return null;
  const m = member as { id: string; actor_handle: string; display_name: string; avatar_url: string | null };

  const { data: snaps } = await supabase
    .from("agentic_maturity_snapshots")
    .select(
      `member_id, snapshot_date, canonical_spine, canonical_overall, ce_band, tasks, sessions,
       total_cost_usd, input_tokens, output_tokens, cache_read_tokens, ${AXIS_COLS.join(", ")}`
    )
    .eq("team_id", teamId)
    .eq("member_id", m.id)
    .eq("metric", "aem-individual")
    .order("snapshot_date", { ascending: true });

  const rows = (snaps ?? []) as unknown as SnapshotRow[];
  if (!rows.length) return null;

  const timeline: MemberTimelinePoint[] = rows.map((r) => ({
    date: dayStr(r.snapshot_date),
    overall: Number(r.canonical_overall),
    ce_band: r.ce_band == null ? null : Number(r.ce_band),
    ...rowAxes(r),
  }));
  const last = rows[rows.length - 1];
  const axes = rowAxes(last);
  const weakest = weakestOf(axes);
  const latest: MemberMaturityCard = {
    member_id: m.id, handle: m.actor_handle, name: m.display_name, avatar_url: m.avatar_url,
    date: dayStr(last.snapshot_date), spine: last.canonical_spine, overall: Number(last.canonical_overall),
    ce_band: last.ce_band == null ? null : Number(last.ce_band),
    axes, tasks: Number(last.tasks), sessions: Number(last.sessions),
    total_cost_usd: Number(last.total_cost_usd ?? 0),
    total_tokens: Number(last.input_tokens ?? 0) + Number(last.output_tokens ?? 0) + Number(last.cache_read_tokens ?? 0),
    weakest,
  };

  // team average for the comparison overlay (reuse the team read, tier already checked)
  const team = await getTeamMaturity(supabase, teamId, tier);

  return {
    handle: m.actor_handle,
    name: m.display_name,
    avatar_url: m.avatar_url,
    latest,
    timeline,
    teamAxes: team.teamAxes,
    prescription: PRESCRIPTION[weakest],
  };
}
