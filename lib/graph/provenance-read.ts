import "server-only";

import { authorizationEpoch } from "@/lib/access/authorization-epoch";
import type { DbClient } from "@/lib/db/types";
import {
  authorizedArcFacts,
  ArcInputAuthorizationUnavailableError,
  ArcSynthesisAuthorizationChangedError,
} from "./arc-input-authorization";
import { recentFacts, resolveEpisodeItems, type AtomicFact } from "./learning";
import { neo4jConfigured } from "./neo4j";

/** A retryable read failure. Callers must not turn this into a healthy empty graph response. */
export class GraphProvenanceUnavailableError extends Error {
  readonly retryable = true;

  constructor(message = "graph provenance authorization is temporarily unavailable") {
    super(message);
    this.name = "GraphProvenanceUnavailableError";
  }
}

function queryTerms(query: string): string[] {
  return [...new Set(
    (query.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? [])
      .filter((word) => !new Set(["the", "and", "for", "from", "what", "when", "where", "with"]).has(word)),
  )].slice(0, 16);
}

export interface AuthorizedGraphFactsResult {
  facts: AtomicFact[];
  /** True means the bounded discovery corpus has more candidates; never presented as complete. */
  incomplete: boolean;
  nextOffset: number | null;
  checked: number;
}

/** An authorized fact with its absolute position in the ordered discovery stream. */
interface PositionedFact {
  fact: AtomicFact;
  position: number;
}

/**
 * Choose what one response publishes and where the next one resumes. The published set is always a
 * PREFIX of the authorized, query-matching stream: ranking only orders that prefix. A response that
 * ranked across everything read and resumed after the last page would step over every authorized
 * fact it read but did not return.
 */
function selectPrefix(
  authorized: PositionedFact[],
  query: string,
  limit: number,
): { facts: AtomicFact[]; overflowAt: number | null } {
  const terms = queryTerms(query);
  const matching = authorized
    .map((entry) => {
      const haystack = `${entry.fact.fact} ${entry.fact.subject} ${entry.fact.object}`.toLowerCase();
      return { ...entry, score: terms.reduce((n, term) => n + (haystack.includes(term) ? 1 : 0), 0) };
    })
    .filter((entry) => terms.length === 0 || entry.score > 0)
    .sort((a, b) => a.position - b.position);
  const selected = matching.slice(0, limit);
  const overflowAt = matching.length > limit ? selected[selected.length - 1].position + 1 : null;
  if (terms.length > 0) {
    selected.sort((a, b) => b.score - a.score || b.fact.at.localeCompare(a.fact.at));
  }
  return { facts: selected.map((entry) => entry.fact), overflowAt };
}

/**
 * Read graph prose only after every relationship episode resolves to a current item in the exact
 * relationship partition. The authorization epoch binds graph read, provenance resolution and
 * publication. One bounded restart handles a concurrent revocation; a second change is surfaced as
 * retryable unavailable rather than returning stale or deceptively empty data.
 */
export async function readAuthorizedGraphFacts(
  db: DbClient,
  args: {
    teamId: string;
    groupIds: readonly string[];
    query?: string;
    limit?: number;
    sinceISO?: string | null;
  },
): Promise<AtomicFact[]> {
  return (await readAuthorizedGraphFactsResult(db, args)).facts;
}

export async function readAuthorizedGraphFactsResult(
  db: DbClient,
  args: {
    teamId: string;
    groupIds: readonly string[];
    query?: string;
    limit?: number;
    sinceISO?: string | null;
    offset?: number;
    discoveryLimit?: number;
  },
): Promise<AuthorizedGraphFactsResult> {
  const groups = [...new Set(args.groupIds.filter(Boolean))];
  if (groups.length === 0) return { facts: [], incomplete: false, nextOffset: null, checked: 0 };
  if (!neo4jConfigured()) {
    throw new GraphProvenanceUnavailableError("provenance-complete Neo4j reads are not configured");
  }
  const limit = Math.max(1, Math.min(args.limit ?? 20, 1000));
  const pageSize = Math.max(25, Math.min(250, limit * 4));
  const discoveryLimit = Math.max(pageSize, Math.min(args.discoveryLimit ?? 2000, 5000));
  const startOffset = Math.max(0, args.offset ?? 0);
  const terms = queryTerms(args.query ?? "");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const epoch = await authorizationEpoch(db, args.teamId);
    try {
      const authorized: PositionedFact[] = [];
      let checked = 0;
      let offset = startOffset;
      let more = false;
      while (checked < discoveryLimit && authorized.length < limit) {
        const take = Math.min(pageSize, discoveryLimit - checked);
        const graph = await recentFacts(groups, args.sinceISO ?? null, take, offset, terms);
        if (!graph.ok) throw new GraphProvenanceUnavailableError("graph relationship read failed");
        if (graph.facts.length === 0) {
          more = false;
          break;
        }
        const episodes = await resolveEpisodeItems(
          groups,
          graph.facts.flatMap((fact) => fact.episodeUuids),
          Math.min(4000, graph.facts.length * 64),
        );
        if (!episodes.ok) throw new GraphProvenanceUnavailableError("graph episode provenance read failed");
        // The earliest position wins a repeated id, so a continuation can only re-read, never skip.
        const positions = new Map<string, number>();
        graph.facts.forEach((fact, index) => {
          if (!positions.has(fact.id)) positions.set(fact.id, offset + index);
        });
        for (const groupId of groups) {
          const partitionFacts = graph.facts.filter((fact) => fact.groupId === groupId);
          const allowed = await authorizedArcFacts(db, {
            teamId: args.teamId,
            partitionGroup: groupId,
            expectedAuthorizationEpoch: epoch,
            facts: partitionFacts,
            episodeItems: episodes.items,
          });
          for (const fact of allowed) {
            const position = positions.get(fact.id);
            if (position !== undefined) authorized.push({ fact, position });
          }
        }
        checked += graph.facts.length;
        offset += graph.facts.length;
        more = graph.facts.length === take;
        if (!more) break;
      }
      if (await authorizationEpoch(db, args.teamId) !== epoch) {
        throw new ArcSynthesisAuthorizationChangedError();
      }
      const { facts, overflowAt } = selectPrefix(authorized, args.query ?? "", limit);
      // Authorized facts read beyond the limit are overflow, not consumed: resume AT the first of
      // them. Only a response that published everything it read may resume after the last page.
      const nextOffset = overflowAt ?? (more ? offset : null);
      return { facts, incomplete: nextOffset !== null, nextOffset, checked };
    } catch (error) {
      if (error instanceof ArcSynthesisAuthorizationChangedError && attempt === 0) continue;
      if (
        error instanceof ArcSynthesisAuthorizationChangedError
        || error instanceof ArcInputAuthorizationUnavailableError
      ) {
        throw new GraphProvenanceUnavailableError(error.message);
      }
      throw error;
    }
  }
  throw new GraphProvenanceUnavailableError("graph authorization changed repeatedly");
}
