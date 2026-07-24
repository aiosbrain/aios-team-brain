import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { adminClient } from "@/lib/db/admin";
import { buildIdentityMap, type IdentityMap } from "@/lib/identity/resolve";
import {
  parseAuthorRefs,
  primaryAuthorRef,
  describeAuthorRef,
  resolveAuthors,
  connectorMemberIds,
  type AttributionMethod,
} from "@/lib/attribution/resolve-authors";
import { resolveItemCredit } from "@/lib/attribution/contributor-credit";

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
  /** MONITOR: items whose credited contributors (the oracle) differ from the raw owner — reassignment +
   *  co-authorship. Near-zero at small-team scale; watch it climb to know when to build the full
   *  multi-contributor timeline UI. See docs/design/attribution-oracle-unification.md. */
  divergentItems: number;
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

/** One attributed item in the per-person drill-down (the actual piece of context, not a count). */
export interface MemberItem {
  id: string;
  path: string;
  title: string;
  kind: string;
  source: string;
  updatedAt: string;
  /** member_id was set by a deliberate correction → a "manual" badge (signal is suppressed). */
  locked: boolean;
  /** The author signal that resolves this item (the resolver's own view) — the "why is this theirs?".
   *  Null when locked (the manual override supersedes it) or when there's no signal. */
  signal: string | null;
  /** HOW that signal resolves against the team's identity mappings NOW — the mapping KIND that matched
   *  (`provider` id / `email` alias / `handle` / `heuristic` / `unresolved` / `none`). Tells the admin
   *  WHERE to fix a bad mapping. `none` when locked or no signal. */
  method: AttributionMethod;
  /** The member the signal resolves to NOW (display name), or null (nobody / locked / no signal). */
  resolvesToName: string | null;
  /** The signal resolves to a real member OTHER than this item's current attribution — the actionable
   *  drift (in a person's row: "attributed here but points elsewhere"; in the unattributed bucket:
   *  "should be `resolvesToName`'s"). We do NOT flag "resolves to nobody" — only a conflicting match. */
  mismatch: boolean;
  /** The CREDITED contributors (display names) from the shared attribution oracle (`resolveItemCredit`) —
   *  i.e. what the Timeline + arcs actually show for this item (everyone who produced a version, or the
   *  corrected owner when locked). Shown next to the raw `owner`/provenance so an admin sees BOTH what
   *  they're correcting (the owner) AND what users see (the credit). Empty when the oracle has no opinion. */
  credited: string[];
}

/** The resolution provenance for one item — pure over an already-built identity map/roster so it's
 *  unit-tested without a DB. Reuses the ONE shared resolver (`resolveAuthors`) — never a second copy.
 *  `suppressed` = the resolution must NOT be surfaced: a LOCKED row (a manual override supersedes the
 *  signal) OR an EXTERNAL-access row (its frontmatter is untrusted client input — re-resolving it would
 *  invite the exact misattribution `reattributeItems` excludes external rows to prevent, so no
 *  signal/method/mismatch here either). `signal` describes the ref that ACTUALLY resolved (falling back
 *  to the role-ranked top claim only when nothing resolves), so it always agrees with `method`. */
export function deriveItemProvenance(
  map: IdentityMap,
  connectors: ReadonlySet<string>,
  namesById: Map<string, string>,
  currentMemberId: string | null,
  frontmatter: Record<string, unknown>,
  suppressed: boolean
): { signal: string | null; method: AttributionMethod; resolvesToName: string | null; mismatch: boolean } {
  if (suppressed) return { signal: null, method: "none", resolvesToName: null, mismatch: false };
  const refs = parseAuthorRefs(frontmatter);
  const res = resolveAuthors(map, refs, connectors);
  const signalRef = res.primaryRef ?? primaryAuthorRef(refs); // the resolving ref, else the top claim
  return {
    signal: signalRef ? describeAuthorRef(signalRef) : null,
    method: res.method,
    resolvesToName: res.memberId ? namesById.get(res.memberId) ?? "(unknown)" : null,
    mismatch: res.memberId !== null && res.memberId !== currentMemberId,
  };
}

/** Title fallback ladder: frontmatter `title` → first markdown heading → path tail. Pure + unit-tested. */
export function deriveItemTitle(fmTitle: string | null | undefined, bodyHead: string | null | undefined, path: string): string {
  const t = (fmTitle ?? "").trim();
  if (t) return t;
  const heading = (bodyHead ?? "").match(/^#{1,6}\s+(.+)$/m);
  if (heading) return heading[1].trim();
  const tail = path.split("/").pop() ?? path;
  return tail.replace(/\.(md|txt)$/i, "") || path;
}

/**
 * The actual items attributed to a member — the drill-down behind the per-person counts. `memberId: null`
 * is the UNATTRIBUTED bucket (the biggest triage target). Reuses `SOURCE_EXPR` (so totals reconcile with
 * the chips) and the ONE shared resolver for each item's PROVENANCE — the role-ranked primary signal, HOW
 * it resolves now (`method`), who it resolves to (`resolvesToName`), and whether that conflicts with the
 * current attribution (`mismatch`). The identity map/roster are built ONCE per read; resolution runs
 * in-memory (no per-item query). Newest-updated first, capped at `limit` (the caller knows the
 * authoritative count and shows "N of total" when capped — full keyset pagination is a follow-up). UNLIKE
 * the counts reads it THROWS on error — a chip that says "14" whose expand silently returned [] would make
 * the dashboard contradict itself. Admin-only (callers gate via `requireTeamAdmin`; module-header AUTHZ).
 */
export async function getMemberItems(
  teamId: string,
  memberId: string | null,
  opts: { source?: string; limit?: number } = {}
): Promise<MemberItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const where: string[] = ["i.team_id = $1"];
  const params: unknown[] = [teamId];
  where.push(memberId === null ? "i.member_id is null" : `i.member_id = $${params.push(memberId)}`);
  if (opts.source) where.push(`${SOURCE_EXPR} = $${params.push(opts.source.toLowerCase())}`);

  const db = adminClient();
  const [{ rows }, map, connectors, namesById] = await Promise.all([
    runSql<{
      id: string;
      path: string;
      kind: string;
      source: string;
      updated_at: string | Date;
      member_id: string | null;
      member_id_locked: boolean | null;
      access: string;
      fm_title: string | null;
      body_head: string | null;
      frontmatter: Record<string, unknown> | null;
    }>(
      `select i.id, i.path, i.kind::text as kind, ${SOURCE_EXPR} as source, i.updated_at, i.member_id,
              i.member_id_locked, i.access::text as access,
              i.frontmatter->>'title' as fm_title, left(i.body, 500) as body_head, i.frontmatter
         from items i
        where ${where.join(" and ")}
        order by i.updated_at desc, i.id desc
        limit ${limit}`,
      params
    ),
    buildIdentityMap(db, teamId),
    connectorMemberIds(db, teamId),
    memberNames(teamId),
  ]);

  // CREDITED contributors from the shared oracle (best-effort names) — what the Timeline + arcs display
  // for each item. Surfaced alongside the raw owner/provenance so this page mirrors the data layer every
  // other surface reads (a correction here — set member_id + lock — collapses this credit everywhere).
  const creditByItem = await resolveItemCredit(db, teamId, rows.map((r) => r.id));

  return rows.map((r) => {
    const locked = r.member_id_locked === true;
    // Suppress resolution for locked (override wins) AND external-access rows (untrusted client
    // frontmatter — mirrors the reattribute batch's external exclusion; never invite that misattribution).
    const suppressed = locked || r.access === "external";
    const prov = deriveItemProvenance(map, connectors, namesById, r.member_id, r.frontmatter ?? {}, suppressed);
    return {
      id: r.id,
      path: r.path,
      kind: r.kind,
      source: r.source,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      title: deriveItemTitle(r.fm_title, r.body_head, r.path),
      locked,
      signal: prov.signal,
      method: prov.method,
      resolvesToName: prov.resolvesToName,
      mismatch: prov.mismatch,
      credited: creditByItem.get(r.id)?.contributors ?? [],
    };
  });
}

/** memberId → display_name for a team (for provenance's `resolvesToName`). */
async function memberNames(teamId: string): Promise<Map<string, string>> {
  const { rows } = await runSql<{ id: string; display_name: string | null }>(
    `select id, display_name from members where team_id = $1`,
    [teamId]
  );
  return new Map(rows.map((r) => [r.id, r.display_name ?? "(unknown)"]));
}

/**
 * MONITOR: count items whose CREDITED contributors (human `item_versions` authors) differ from the raw
 * current owner — i.e. reassignment or co-authorship, the divergence that grows with team size. Excludes
 * locked items (credit == corrected owner by rule) and connector authors. This is the tripwire for "when
 * does the timeline/arcs multi-contributor gap start to matter" (near-zero today). Best-effort (0 on error).
 */
export async function countCreditDivergence(teamId: string): Promise<number> {
  try {
    const { rows } = await runSql<{ n: number }>(
      `with hva as (
         select v.item_id, array_agg(distinct v.member_id) as human_version_members
         from item_versions v
         join items i on i.id = v.item_id and i.team_id = $1
         join members m on m.id = v.member_id and m.is_connector is not true
         where v.member_id is not null
         group by v.item_id
       )
       select count(*)::int as n
       from items i
       join hva on hva.item_id = i.id
       where i.team_id = $1 and i.member_id_locked is not true
         and not (hva.human_version_members <@ array[i.member_id] and array[i.member_id] <@ hva.human_version_members)`,
      [teamId]
    );
    return rows[0]?.n ?? 0;
  } catch (err) {
    console.error("[attribution] countCreditDivergence failed:", err instanceof Error ? err.message : err);
    return 0;
  }
}

/** The full attribution-health read for a team (both breakdowns + the alert list + the divergence monitor). Best-effort. */
export async function getAttributionHealth(teamId: string): Promise<AttributionHealth> {
  const [bySource, byMember, divergentItems] = await Promise.all([
    getSourceAttribution(teamId),
    getMemberAttribution(teamId),
    countCreditDivergence(teamId),
  ]);
  return { bySource, byMember, lowAttributionSources: lowAttribution(bySource), divergentItems };
}
