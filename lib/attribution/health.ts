import "server-only";
import { runSql } from "@/lib/db/pg/pool";

/**
 * Attribution health — "is each data stream landing on the right person?" Every learning/arc surface
 * stands on `items.member_id`; attribution is resolved per-source at ingest and is silently wrong for
 * whole classes of input (a document source with no author signal lands on the connector; an unassigned
 * ticket lands on nobody). This read makes the gap VISIBLE — per source (how much is attributed to a
 * real human vs a connector service-account vs nobody) and per person (what kinds of things they own,
 * so misattribution jumps out). It's the data layer behind the attribution banner + the per-person
 * dashboard visual. See docs/design/attribution-architecture.md.
 *
 * Best-effort: returns empty on any error so it never breaks a page render. Read-only over `items` +
 * `members` — no bespoke per-view computation, so the banner and the dashboard read it identically.
 *
 * ⚠️ AUTHZ (for whoever wires this into a route/page): this spans ALL access tiers — it exposes
 * per-member names + per-source counts of team/admin-tier content. There is no RLS backstop (CLAUDE §5),
 * so any surface built on it MUST be admin-gated (or filtered through `lib/auth/visibility`) and carry a
 * tier-filter guard test. Do NOT expose it to an `external`-tier principal.
 */

/**
 * The canonical "source" of an item for attribution grouping: its `frontmatter.source`, normalized
 * (trimmed + lower-cased so "Granola"/"granola" don't split), falling back to `kind` when absent/blank.
 * Shared by both reads so they bucket identically; mirrors `isSignalSource`'s normalization.
 */
const SOURCE_EXPR = "coalesce(nullif(trim(lower(i.frontmatter->>'source')), ''), i.kind::text)";

/**
 * "Signal" sources are evidence about who's doing what (meeting transcripts, calendar events), NOT a
 * person's own OUTPUT — so a Granola note attributed to whoever pushed it is not that person's work and
 * must not be counted as their deliverable. Flagged here so the visual can separate signal from output;
 * the reclassification of what these feed (attribution/understanding, not "this person's arcs") is a
 * later step (design §3/§5).
 */
export const SIGNAL_SOURCES = new Set(["granola", "calendar", "gcal", "zoom", "meet", "gmeet", "teams_meeting"]);

export function isSignalSource(source: string): boolean {
  return SIGNAL_SOURCES.has(source.trim().toLowerCase());
}

/** Attribution breakdown for one source (an item's source = `frontmatter.source`, else its `kind`). */
export interface SourceAttribution {
  source: string;
  isSignal: boolean;
  items: number;
  human: number; // member_id set AND not a connector service-account
  connector: number; // member_id is a connector (mis-attributed to the sync account)
  unattributed: number; // member_id null (resolved to nobody)
  /** Share of items attributed to a real human, 0–100 (0 when the source has no items). */
  pctHuman: number;
}

/** What one person owns, broken down by source — the per-person troubleshooting view. */
export interface MemberAttribution {
  memberId: string;
  displayName: string;
  total: number;
  bySource: { source: string; isSignal: boolean; items: number }[];
}

export interface AttributionHealth {
  bySource: SourceAttribution[];
  byMember: MemberAttribution[];
  /** Non-signal sources whose human-attribution rate is below `threshold` — the banner's alert list. */
  lowAttributionSources: SourceAttribution[];
}

/** Default: a non-signal source under 50% human-attributed is worth surfacing (Plane=0, Linear=22 today). */
export const LOW_ATTRIBUTION_PCT = 50;

/** Pure: pick the non-signal sources with real volume that are under the human-attribution threshold.
 *  Signal sources (meetings/calendar) are excluded — they're not meant to be one person's output, so a
 *  "low human %" there isn't a defect. Exported for unit testing the alert logic without a DB. */
export function lowAttribution(
  sources: SourceAttribution[],
  threshold = LOW_ATTRIBUTION_PCT
): SourceAttribution[] {
  return sources.filter((s) => !s.isSignal && s.items > 0 && s.pctHuman < threshold);
}

function pct(human: number, items: number): number {
  return items > 0 ? Math.round((1000 * human) / items) / 10 : 0;
}

/** Per-source attribution counts for a team. Best-effort ([] on error). */
export async function getSourceAttribution(teamId: string): Promise<SourceAttribution[]> {
  try {
    const { rows } = await runSql<{
      source: string;
      items: number;
      human: number;
      connector: number;
      unattributed: number;
    }>(
      `select ${SOURCE_EXPR} as source,
              count(*)::int as items,
              count(*) filter (where i.member_id is not null and m.is_connector is not true)::int as human,
              count(*) filter (where m.is_connector is true)::int as connector,
              count(*) filter (where i.member_id is null)::int as unattributed
         from items i
         left join members m on m.id = i.member_id
        where i.team_id = $1
        group by 1
        order by items desc`,
      [teamId]
    );
    return rows.map((r) => ({
      source: r.source,
      isSignal: isSignalSource(r.source),
      items: r.items,
      human: r.human,
      connector: r.connector,
      unattributed: r.unattributed,
      pctHuman: pct(r.human, r.items),
    }));
  } catch (err) {
    // Log rather than swallow: this IS the observability layer — a query that silently returns [] would
    // render as "no data" and make misattribution invisible again (the failure this feature surfaces).
    console.error("[attribution] getSourceAttribution failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** Per-person attribution counts (non-connector members only). Best-effort ([] on error). */
export async function getMemberAttribution(teamId: string): Promise<MemberAttribution[]> {
  try {
    const { rows } = await runSql<{
      member_id: string;
      display_name: string | null;
      source: string;
      items: number;
    }>(
      `select m.id as member_id, m.display_name,
              ${SOURCE_EXPR} as source,
              count(*)::int as items
         from items i
         join members m on m.id = i.member_id
        where i.team_id = $1 and m.is_connector is not true
        group by 1, 2, 3
        order by m.display_name, items desc`,
      [teamId]
    );
    const byMember = new Map<string, MemberAttribution>();
    for (const r of rows) {
      let mem = byMember.get(r.member_id);
      if (!mem) {
        mem = { memberId: r.member_id, displayName: r.display_name ?? "(unknown)", total: 0, bySource: [] };
        byMember.set(r.member_id, mem);
      }
      mem.bySource.push({ source: r.source, isSignal: isSignalSource(r.source), items: r.items });
      mem.total += r.items;
    }
    return [...byMember.values()].sort((a, b) => b.total - a.total);
  } catch (err) {
    console.error("[attribution] getMemberAttribution failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** The full attribution-health read for a team (both breakdowns + the alert list). Best-effort. */
export async function getAttributionHealth(teamId: string): Promise<AttributionHealth> {
  const [bySource, byMember] = await Promise.all([
    getSourceAttribution(teamId),
    getMemberAttribution(teamId),
  ]);
  return { bySource, byMember, lowAttributionSources: lowAttribution(bySource) };
}
