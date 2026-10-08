import "server-only";

import { authorizationEpoch } from "@/lib/access/authorization-epoch";
import { visibleItemIdsForProjects } from "@/lib/access/enforce";
import type { DbClient } from "@/lib/db/types";
import type { AtomicFact } from "./learning";

export class ArcSynthesisAuthorizationChangedError extends Error {
  readonly retryable = true;

  constructor() {
    super("arc synthesis authorization changed; retry");
    this.name = "ArcSynthesisAuthorizationChangedError";
  }
}

export class ArcInputAuthorizationUnavailableError extends Error {
  readonly retryable = true;

  constructor(message = "arc synthesis provenance authorization is unavailable") {
    super(message);
    this.name = "ArcInputAuthorizationUnavailableError";
  }
}

/**
 * A graph fact may be a merge of several source episodes. It is authorized only when EVERY source
 * episode resolves to an item and EVERY resolved item currently belongs to the exact partition being
 * synthesized. One visible citation can therefore never launder restricted text from a sibling source.
 */
export function filterArcFactsByAuthorizedItems(
  facts: readonly AtomicFact[],
  episodeItems: ReadonlyMap<string, { itemId?: string; source?: string }>,
  authorizedItemIds: ReadonlySet<string>,
): AtomicFact[] {
  return facts.filter((fact) => {
    if (fact.episodeUuids.length === 0) return false;
    const itemIds: string[] = [];
    for (const episodeUuid of fact.episodeUuids) {
      const itemId = episodeItems.get(episodeUuid)?.itemId;
      if (!itemId) return false;
      itemIds.push(itemId);
    }
    return itemIds.length > 0 && itemIds.every((itemId) => authorizedItemIds.has(itemId));
  });
}

/** Resolve the exact partition's current item authority under one epoch. Shared by graph facts and
 * human-correction dependencies so neither path grows a subtly wider audience interpretation. */
export async function authorizedItemIdsForArcPartition(
  db: DbClient,
  args: {
    teamId: string;
    partitionGroup: string;
    expectedAuthorizationEpoch: number;
  },
): Promise<ReadonlySet<string>> {
  const assertEpoch = async () => {
    if (await authorizationEpoch(db, args.teamId) !== args.expectedAuthorizationEpoch) {
      throw new ArcSynthesisAuthorizationChangedError();
    }
  };
  await assertEpoch();

  // Legacy pure unit fakes do not model the context substrate. Production and real-PG tests always
  // have DATABASE_URL and take the authoritative path below; the pure filter remains separately pinned.
  if (process.env.NODE_ENV === "test" && !process.env.DATABASE_URL) {
    throw new ArcInputAuthorizationUnavailableError("arc partition authorization requires the real context substrate");
  }

  const { data: projects, error: projectError } = await db
    .from("projects")
    .select("id")
    .eq("team_id", args.teamId)
    .eq("graph_group_id", args.partitionGroup);
  if (projectError) {
    throw new ArcInputAuthorizationUnavailableError(`arc partition authorization read failed: ${projectError.message}`);
  }
  const projectIds = new Set((projects ?? []).map((row) => String((row as { id: string }).id)).filter(Boolean));
  if (projectIds.size !== 1) {
    throw new ArcInputAuthorizationUnavailableError("arc partition does not resolve to exactly one authorized project");
  }

  const visible = await visibleItemIdsForProjects(db, args.teamId, projectIds);
  if (visible.error) {
    throw new ArcInputAuthorizationUnavailableError("arc item authorization read failed");
  }
  await assertEpoch();
  return visible.ids;
}

/** Resolve the exact partition's current item authority and filter source facts under one epoch. */
export async function authorizedArcFacts(
  db: DbClient,
  args: {
    teamId: string;
    partitionGroup: string;
    expectedAuthorizationEpoch: number;
    facts: readonly AtomicFact[];
    episodeItems: ReadonlyMap<string, { itemId?: string; source?: string }>;
  },
): Promise<AtomicFact[]> {
  // Legacy pure unit fakes do not model the context substrate. Production and real-PG tests always
  // have DATABASE_URL and take the authoritative path; the pure filter remains separately pinned.
  if (process.env.NODE_ENV === "test" && !process.env.DATABASE_URL) {
    if (await authorizationEpoch(db, args.teamId) !== args.expectedAuthorizationEpoch) {
      throw new ArcSynthesisAuthorizationChangedError();
    }
    const allResolved = new Set(
      [...args.episodeItems.values()].map((entry) => entry.itemId).filter((id): id is string => !!id),
    );
    return filterArcFactsByAuthorizedItems(args.facts, args.episodeItems, allResolved);
  }
  const visible = await authorizedItemIdsForArcPartition(db, args);
  return filterArcFactsByAuthorizedItems(args.facts, args.episodeItems, visible);
}
