import type { GraphitiClient, GraphEpisode, GraphEpisodeRef } from "@/lib/graph/graphiti-client";

let fakeUuidCounter = 0;

/**
 * In-memory Graphiti double: tracks episodes per group with server-assigned uuids, so
 * listEpisodes/deleteEpisode (M6, H3 reconcile) behave like the real REST surface.
 *
 * Shared by every data-mechanics test that projects — one double, so a behaviour a test relies on
 * (the `lastN` window, the never-lands crash simulation) can't be right in one copy and wrong in
 * another.
 */
export class FakeGraphiti {
  pushes: { groupId: string; episodes: GraphEpisode[] }[] = [];
  // groupId -> uuid -> episode (mirrors Graphiti's own per-group episode store)
  store = new Map<string, Map<string, GraphEpisodeRef>>();
  // Names that should be treated as "never landed" (simulates a worker crash before extraction).
  neverLands = new Set<string>();
  // When true, deleteEpisode throws — simulates a Graphiti blip so cleanup fails (B2).
  failDeletes = false;
  // Records the `lastN` each listEpisodes call requested, so a test can assert the deep scan (B2).
  listCalls: { groupId: string; lastN?: number }[] = [];
  // RECONULL-1: groups whose listing THROWS (unreachable / timeout / malformed body, as the strict
  // client now does) and groups whose listing returns EMPTY regardless of the store.
  failListFor = new Set<string>();
  emptyListFor = new Set<string>();
  readonly configured = true;

  async addEpisodes(groupId: string, episodes: GraphEpisode[]): Promise<void> {
    this.pushes.push({ groupId, episodes });
    const group = this.store.get(groupId) ?? new Map<string, GraphEpisodeRef>();
    for (const e of episodes) {
      if (e.name && this.neverLands.has(e.name)) continue; // simulated crash: never materializes
      const uuid = `fake-uuid-${++fakeUuidCounter}`;
      group.set(uuid, { uuid, name: e.name ?? "" });
    }
    this.store.set(groupId, group);
  }

  /** Honors `lastN` the way Graphiti's `GET /episodes/{group}` does — the MOST RECENT n only. Without
   *  this the double silently makes every scan unbounded, and the depth/saturation behavior the tier
   *  cleanup depends on (a shallow window hides an item; a full window is inconclusive) is untestable. */
  async listEpisodes(groupId: string, lastN?: number): Promise<GraphEpisodeRef[]> {
    this.listCalls.push({ groupId, lastN });
    if (this.failListFor.has(groupId)) throw new Error(`simulated listing failure for ${groupId}`);
    if (this.emptyListFor.has(groupId)) return [];
    const all = [...(this.store.get(groupId)?.values() ?? [])]; // insertion order = oldest → newest
    return typeof lastN === "number" && lastN >= 0 ? all.slice(Math.max(0, all.length - lastN)) : all;
  }

  async deleteEpisode(uuid: string): Promise<void> {
    if (this.failDeletes) throw new Error("simulated Graphiti delete failure");
    for (const group of this.store.values()) group.delete(uuid);
  }

  /** Every episode CONTENT this double has ever received for a group — the ground truth the
   *  per-chunk ledger is checked against (AC3 containment). */
  receivedContentFor(groupId: string): string[] {
    return this.pushes.filter((p) => p.groupId === groupId).flatMap((p) => p.episodes.map((e) => e.content));
  }

  /** Every episode this double has been asked to push, flattened. */
  get pushedEpisodes(): GraphEpisode[] {
    return this.pushes.flatMap((p) => p.episodes);
  }
}

export function client(fake: FakeGraphiti): GraphitiClient {
  return fake as unknown as GraphitiClient;
}
