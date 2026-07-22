import "server-only";
import type { DbClient } from "@/lib/db/types";
import type { ItemPayload } from "@/lib/api/schemas";
import {
  buildIdentityMap,
  resolveByProviderId,
  resolveMemberDetailed,
  type IdentityMap,
  type ResolveMethod,
} from "@/lib/identity/resolve";
import { parseAuthorIdentity } from "@/lib/codebases/commits-to-items";

/**
 * Source-agnostic author attribution at INGEST — resolve "whose work is this?" from an item's
 * frontmatter against the roster, so a document source (Notion/Google Docs/…) attributes to the real
 * human instead of the connector service-account. Generalizes the per-source `switch` that used to live
 * in `lib/ingest/reattribute` (slack/linear/plane/git only, everything else → null) into ONE resolver
 * reused by BOTH the live push route and the re-attribution batch, so they can never drift.
 *
 * INVARIANT (CLAUDE §5-adjacent): this NEVER returns the ingesting connector's id. A push whose author
 * can't be resolved comes back `memberId: null` (unattributed) — the route passes that through so a
 * connector ingesting on behalf of an unresolved human never silently claims the work. See
 * docs/design/attribution-architecture.md.
 */

/** One author signal carried by an item's frontmatter. Any subset may be present per source. */
export interface AuthorRef {
  role?: string; // author | creator | editor | assignee | reviewer | speaker | commenter
  email?: string;
  handle?: string;
  provider?: string; // slack | linear | plane | notion | gdrive | …
  externalId?: string; // the provider's stable user id
  displayName?: string;
}

/** Attribution confidence for the PRIMARY author (drives the health layer + review list). */
export type AttributionMethod = "provider" | ResolveMethod | "none";

export interface AuthorResolution {
  /** Primary author → member_id; NEVER a connector; null when nothing resolved. */
  memberId: string | null;
  method: AttributionMethod;
  /** The ref that BECAME the primary (the one that actually resolved) — so a "why" label describes the
   *  same identity that produced `memberId`/`method`, not a stronger-role ref that didn't resolve.
   *  Undefined when nothing resolved. */
  primaryRef?: AuthorRef;
  /** All distinct resolved members (multi-author credit — a doc's creator + editors). */
  resolvedMemberIds: string[];
  /** Author identities we saw but couldn't map — the raw material for the "add a mapping" queue. */
  unresolved: string[];
}

const NONE: AuthorResolution = { memberId: null, method: "none", resolvedMemberIds: [], unresolved: [] };

/** Lower rank = stronger claim to being the PRIMARY author. Unknown roles sort after known ones. */
const ROLE_RANK: Record<string, number> = {
  author: 0,
  creator: 1,
  editor: 2,
  speaker: 3,
  assignee: 4,
  reviewer: 5,
  commenter: 6,
};

function roleRank(role: string | undefined): number {
  return role && role in ROLE_RANK ? ROLE_RANK[role] : 50;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The role-ranked PRIMARY ref (strongest role wins; stable by original order for ties) — the SAME
 *  ordering `resolveAuthors` uses to pick a primary, so a "why is this theirs?" signal built from this
 *  reflects the resolver's choice rather than raw frontmatter order. Null for an empty list. */
export function primaryAuthorRef(refs: AuthorRef[]): AuthorRef | null {
  if (refs.length === 0) return null;
  return refs
    .map((ref, i) => ({ ref, i }))
    .sort((a, b) => roleRank(a.ref.role) - roleRank(b.ref.role) || a.i - b.i)[0].ref;
}

/** A human-readable label for an unresolved author (for the review queue / logs). */
export function describeAuthorRef(ref: AuthorRef): string {
  return (
    ref.email ||
    (ref.provider && ref.externalId ? `${ref.provider}:${ref.externalId}` : "") ||
    ref.handle ||
    ref.displayName ||
    "(unknown author)"
  );
}

/**
 * Extract author signals from an item's frontmatter. Prefers the structured `authors[]` array (the
 * general path any new source can populate); falls back to the source-specific keys the existing
 * connectors already write (so slack/linear/plane/git behavior is preserved unchanged), then to a
 * generic `author`/`author_email`. Pure — validates untrusted frontmatter defensively.
 */
export function parseAuthorRefs(fm: Record<string, unknown>): AuthorRef[] {
  // 1. Structured, source-agnostic: `authors: [{role,email,handle,provider,external_id,display_name}]`.
  if (Array.isArray(fm.authors)) {
    const refs: AuthorRef[] = [];
    for (const raw of fm.authors) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      const ref: AuthorRef = {
        role: str(o.role) || undefined,
        email: str(o.email) || undefined,
        handle: str(o.handle) || undefined,
        provider: str(o.provider) || undefined,
        externalId: (str(o.external_id) || str(o.externalId)) || undefined,
        displayName: (str(o.display_name) || str(o.displayName)) || undefined,
      };
      if (ref.email || ref.handle || (ref.provider && ref.externalId) || ref.displayName) refs.push(ref);
    }
    if (refs.length) return refs;
  }

  // 2. Source-specific keys the existing connectors already write (behavior preserved).
  const source = str(fm.source).toLowerCase();
  if (source === "slack" && str(fm.author_id)) {
    return [{ provider: "slack", externalId: str(fm.author_id), role: "author" }];
  }
  if ((source === "linear" || source === "plane") && str(fm.assignee_id)) {
    return [{ provider: source, externalId: str(fm.assignee_id), role: "assignee" }];
  }
  if (source === "git" && str(fm.author)) {
    const id = parseAuthorIdentity(str(fm.author));
    return [{ email: id.email ?? undefined, handle: id.email ? undefined : (id.key ?? undefined), displayName: id.name, role: "author" }];
  }

  // 3. Generic fallback: a bare author EMAIL any source might set. Deliberately email-only — a bare
  //    `author` DISPLAY NAME ("Sam", or an RSS feed title) is NOT a reliable key; treating it as a
  //    handle would collide with a same-named `actor_handle` and misattribute an external article to a
  //    roster member. A display name alone is left unresolvable (correct).
  const genericEmail = str(fm.author_email);
  if (genericEmail) return [{ email: genericEmail, role: "author" }];
  return [];
}

/** Resolve one ref → member + method. Tries each available signal until one hits: provider id (exact),
 *  then email (exact/heuristic), then an explicit handle — so a ref carrying BOTH an unmapped email and
 *  a known handle still resolves via the handle instead of stopping at the email miss. */
function resolveRef(map: IdentityMap, ref: AuthorRef): { memberId: string | null; method: AttributionMethod } {
  if (ref.provider && ref.externalId) {
    const id = resolveByProviderId(map, ref.provider, ref.externalId);
    if (id) return { memberId: id, method: "provider" };
  }
  if (ref.email) {
    const r = resolveMemberDetailed(map, { email: ref.email, key: ref.email });
    if (r.memberId) return r;
  }
  if (ref.handle) {
    const r = resolveMemberDetailed(map, { key: ref.handle });
    if (r.memberId) return r;
  }
  return { memberId: null, method: "unresolved" };
}

/**
 * Resolve an item's author refs → a primary member (+ confidence, multi-author set, and the unresolved
 * remainder). Primary = the strongest-role ref that resolves. Pure over an already-built identity map.
 * `excludeMemberIds` (connector service-account ids) are treated as NON-resolutions — the identity map
 * contains connectors, and authorship must never resolve TO one (a coincidental email match would
 * otherwise attribute a person's work to "Notion Sync"). Enforces the "never a connector" invariant.
 */
export function resolveAuthors(
  map: IdentityMap,
  refs: AuthorRef[],
  excludeMemberIds: ReadonlySet<string> = new Set()
): AuthorResolution {
  if (refs.length === 0) return NONE;
  const ordered = refs
    .map((ref, i) => ({ ref, i }))
    .sort((a, b) => roleRank(a.ref.role) - roleRank(b.ref.role) || a.i - b.i);

  const resolvedMemberIds: string[] = [];
  const unresolved: string[] = [];
  let primary: { memberId: string; method: AttributionMethod; ref: AuthorRef } | null = null;
  for (const { ref } of ordered) {
    const { memberId, method } = resolveRef(map, ref);
    if (memberId && !excludeMemberIds.has(memberId)) {
      if (!resolvedMemberIds.includes(memberId)) resolvedMemberIds.push(memberId);
      if (!primary) primary = { memberId, method, ref };
    } else {
      unresolved.push(describeAuthorRef(ref));
    }
  }
  return {
    memberId: primary?.memberId ?? null,
    method: primary?.method ?? "unresolved",
    primaryRef: primary?.ref,
    resolvedMemberIds,
    unresolved,
  };
}

/** The single-item author member for the re-attribution batch (primary only). */
export function resolveItemAuthorMember(
  map: IdentityMap,
  fm: Record<string, unknown>,
  excludeMemberIds: ReadonlySet<string> = new Set()
): string | null {
  return resolveAuthors(map, parseAuthorRefs(fm), excludeMemberIds).memberId;
}

/** Connector member ids for a team — resolution targets to EXCLUDE (authorship never lands on a sync
 *  account) AND the set that gates the never-actor rule below. Best-effort: on error, warn and return
 *  empty rather than silently degrading the never-connector invariant unseen. */
export async function connectorMemberIds(db: DbClient, teamId: string): Promise<Set<string>> {
  const { data, error } = await db.from("members").select("id").eq("team_id", teamId).eq("is_connector", true);
  if (error) console.warn(`[attribution] connectorMemberIds failed for team ${teamId}: ${error.message}`);
  return new Set((data ?? []).map((r) => (r as { id: string }).id));
}

/**
 * Compute the author-attribution override for an incoming push at INGEST from its frontmatter.
 *   • author signal resolves to a real member → attribute to THAT member (even if the pusher is someone
 *     else — a human ingesting a colleague's doc credits the real author);
 *   • author signal present but UNRESOLVED, pushed by a CONNECTOR key → `{ authorMemberId: null }`, so a
 *     sync account never claims a human's work (leaves it unattributed for the health layer to flag);
 *   • author signal present but UNRESOLVED, pushed by a HUMAN key → NO override, so the item keeps the
 *     pusher's own attribution (a member's Obsidian note with an incidental/unmappable `author` in its
 *     frontmatter must NOT lose attribution — the never-actor rule is for connectors, not self-pushes);
 *   • no author signal at all → NO override (current behavior).
 * `actorMemberId` is the pushing key's member (`auth.memberId`). Returns only the override; the caller
 * passes it to `ingestItem` (an omitted `opts` ⇒ attribute to the actor). Callers should NOT invoke this
 * for external-tier keys — an untrusted pusher must not attribute content to a team member (route gate).
 */
export async function attributeIncomingItem(
  db: DbClient,
  teamId: string,
  payload: ItemPayload,
  actorMemberId: string
): Promise<{ opts?: { authorMemberId: string | null } }> {
  const refs = parseAuthorRefs(payload.frontmatter ?? {});
  if (refs.length === 0) return {};
  const [map, connectors] = await Promise.all([buildIdentityMap(db, teamId), connectorMemberIds(db, teamId)]);
  const res = resolveAuthors(map, refs, connectors);
  if (res.memberId) return { opts: { authorMemberId: res.memberId } };
  // Unresolved. A connector must never claim the work → null; a human self-push keeps its own actor
  // attribution (no override). (Perf note: this builds the identity map per author-bearing push,
  // including unchanged re-pushes whose dedup happens later in ingestItem — a cheap per-team cache is a
  // deferred optimization, not correctness.)
  if (connectors.has(actorMemberId)) {
    console.warn(
      `[attribution] connector push with unresolved author(s) [${res.unresolved.join(", ")}] (${payload.path}) → left unattributed`
    );
    return { opts: { authorMemberId: null } };
  }
  return {};
}
