import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  mergeArcPair,
  reconcileArcIdentity,
  stableArcTarget,
  arcItemIds,
  isSameArc,
} from "@/lib/graph/arc-continuity";
import type { NarrativeArc } from "@/lib/graph/arcs";

/**
 * Spec: arcs must be RECOGNISABLY THE SAME day to day when the underlying work is the same — the product
 * rule, not a description of the matcher. An arc may be merged, split or retired; what it must not do is
 * silently become a different arc because the model reworded its title.
 */

function arc(id: string, title: string, itemIds: string[]): NarrativeArc {
  return {
    id,
    title,
    confidence: "high",
    summary: `summary for ${title}`,
    participants: [],
    supporting_sources: [],
    evidence: itemIds.map((itemId) => ({ fact: `fact ${itemId}`, itemId })),
    derived_at: "2026-08-03T00:00:00Z",
  };
}

describe("reconcileArcIdentity — same work keeps its identity", () => {
  it("a reworded arc over the same evidence KEEPS the prior id and title", () => {
    // The whole bug: `stableId` hashed the title, so this was a brand-new arc every time the model
    // chose different words for the same story.
    const prior = [arc("arc-aaa", "Social Brain rollout", ["i1", "i2", "i3"])];
    const next = [arc("arc-zzz", "Rolling out the Social Brain", ["i1", "i2", "i3"])];
    const { arcs, continuity } = reconcileArcIdentity(prior, next);
    expect(arcs[0].id).toBe("arc-aaa");
    expect(arcs[0].title).toBe("Social Brain rollout");
    expect(continuity.carriedOver).toBe(1);
    expect(continuity.ratio).toBe(1);
  });

  it("carries the FRESH summary and evidence — stability of identity, not of content", () => {
    const prior = [arc("arc-aaa", "Costs", ["i1", "i2"])];
    const next = [arc("arc-zzz", "Costs reworded", ["i1", "i2", "i9"])];
    const { arcs } = reconcileArcIdentity(prior, next);
    expect(arcs[0].summary).toBe("summary for Costs reworded");
    expect(arcs[0].evidence.map((e) => e.itemId)).toEqual(["i1", "i2", "i9"]);
  });

  it("genuinely different work gets a NEW arc, not an inherited id", () => {
    const prior = [arc("arc-aaa", "Costs", ["i1", "i2", "i3"])];
    const next = [arc("arc-zzz", "Onboarding", ["i7", "i8", "i9"])];
    const { arcs, continuity } = reconcileArcIdentity(prior, next);
    expect(arcs[0].id).toBe("arc-zzz");
    expect(continuity.carriedOver).toBe(0);
    expect(continuity.ratio).toBe(0);
  });

  it("one incidentally shared item is NOT a continuation", () => {
    // A shared all-hands meeting or a sweeping PR shouldn't fuse two unrelated stories.
    const prior = [arc("arc-aaa", "Costs", ["i1", "i2", "i3"])];
    const next = [arc("arc-zzz", "Onboarding", ["i3", "i8", "i9"])];
    expect(reconcileArcIdentity(prior, next).arcs[0].id).toBe("arc-zzz");
  });

  it("a single-evidence arc still continues when that one item is shared", () => {
    // Otherwise the smallest arcs — often a person's only thread — are reborn every single day.
    const prior = [arc("arc-aaa", "Miko intro", ["i1"])];
    const next = [arc("arc-zzz", "Intro call with Miko", ["i1"])];
    expect(reconcileArcIdentity(prior, next).arcs[0].id).toBe("arc-aaa");
  });

  it("renames an arc whose evidence has mostly turned over", () => {
    // Keeping a frozen title on drifted work is its own lie — the arc continues, the label updates.
    // Must still MATCH (>=2 shared) while having drifted: 2 of 6 prior items retained = 33%.
    const prior = [arc("arc-aaa", "Old name", ["i1", "i2", "i3", "i4", "i5", "i6"])];
    const next = [arc("arc-zzz", "New name", ["i1", "i2", "i7", "i8", "i9"])];
    const { arcs } = reconcileArcIdentity(prior, next);
    expect(arcs[0].id).toBe("arc-aaa"); // same story…
    expect(arcs[0].title).toBe("New name"); // …under a new name
  });

  it("keeps the name when exactly half the prior evidence is retained — stability wins the tie", () => {
    // Pins the boundary deliberately rather than leaving it to whichever way the comparison happens to
    // fall: at a genuine 50/50 the arc is as much continuation as departure, and the product asked for
    // stability, so the recognisable name stays.
    const prior = [arc("arc-aaa", "Old name", ["i1", "i2", "i3", "i4"])];
    const next = [arc("arc-zzz", "New name", ["i1", "i2", "i8", "i9"])];
    expect(reconcileArcIdentity(prior, next).arcs[0].title).toBe("Old name");
  });
});

describe("reconcileArcIdentity — merge and split are allowed, and traceable", () => {
  it("MERGE: one new arc absorbing two priors inherits the strongest and records the other", () => {
    const prior = [arc("arc-a", "Costs ledger", ["i1", "i2", "i3"]), arc("arc-b", "Costs UI", ["i4", "i5"])];
    const next = [arc("arc-new", "Costs", ["i1", "i2", "i3", "i4", "i5"])];
    const { arcs, continuity } = reconcileArcIdentity(prior, next);
    expect(arcs[0].id).toBe("arc-a"); // 3 shared beats 2
    expect(arcs[0].supersedes).toEqual(["arc-b"]);
    expect(continuity.carriedOver).toBe(1);
    expect(continuity.ratio).toBe(0.5); // one of two priors survived as an identity
  });

  it("SPLIT: the strongest child continues the prior; the sibling records splitFrom, NOT supersedes", () => {
    // The distinction is the point: the parent is still on screen under the winning child, so the
    // sibling did not supersede it. Recording `supersedes` there would be a stored falsehood.
    const prior = [arc("arc-a", "Costs", ["i1", "i2", "i3", "i4"])];
    const next = [arc("arc-x", "Costs ledger", ["i1", "i2", "i3"]), arc("arc-y", "Costs UI", ["i4", "i9", "i1"])];
    const { arcs } = reconcileArcIdentity(prior, next);
    expect(arcs[0].id).toBe("arc-a");
    expect(arcs[1].id).toBe("arc-y");
    expect(arcs[1].splitFrom).toBe("arc-a");
    expect(arcs[1]).not.toHaveProperty("supersedes");
  });

  it("never hands the same prior id to two arcs", () => {
    const prior = [arc("arc-a", "Costs", ["i1", "i2", "i3", "i4"])];
    const next = [arc("arc-x", "A", ["i1", "i2"]), arc("arc-y", "B", ["i3", "i4"])];
    const ids = reconcileArcIdentity(prior, next).arcs.map((a) => a.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.filter((i) => i === "arc-a")).toHaveLength(1);
  });
});

describe("reconcileArcIdentity — ids emitted are unique", () => {
  // Fixtures use PRODUCTION-shaped ids (`sha(title)`), because that is what makes the collision real.
  // The earlier uniqueness test used arbitrary ids and passed straight through this bug.
  const stableId = (t: string) => "arc-" + createHash("sha256").update(t.trim().toLowerCase()).digest("hex").slice(0, 10);
  const real = (title: string, ids: string[]) => ({ ...arc(stableId(title), title, ids) });

  // CONTRACT CHANGE (ARCDUP-1). These used to assert that a split whose children BOTH keep the parent's
  // title emits TWO arcs with distinct ids. That fixed the React key and the arc_corrections binding but
  // left two identically-named cards on screen — the reported prod bug. Same title now means ONE arc.
  it("a split whose children BOTH keep the parent's title collapses to ONE arc, keeping the prior id", () => {
    const prior = [real("Costs", ["i1", "i2", "i3", "i4"])];
    const next = [real("Costs", ["i1", "i2", "i3"]), real("Costs", ["i4", "i9"])];
    const arcs = reconcileArcIdentity(prior, next).arcs;
    expect(arcs).toHaveLength(1);
    expect(arcs[0].id).toBe(prior[0].id); // the winner keeps the identity corrections are bound to
    // Nothing is dropped: the absorbed sibling's evidence comes along.
    expect(arcs[0].evidence.map((e) => e.itemId).sort()).toEqual(["i1", "i2", "i3", "i4", "i9"]);
  });

  it("two same-titled NEW arcs collapse to one", () => {
    const arcs = reconcileArcIdentity([], [real("Costs", ["i1"]), real("Costs", ["i2"])]).arcs;
    expect(arcs).toHaveLength(1);
    expect(arcs[0].evidence.map((e) => e.itemId).sort()).toEqual(["i1", "i2"]);
  });

  // The `distinctId` re-key is still LIVE and must stay pinned — it just can't be reached with two
  // same-titled arcs any more. It fires when a NON-inheriting arc's own `sha(title)` equals an id an
  // inheriting arc already took. Reaching it needs `isSameArc` to hold while `retained` stays under
  // KEEP_TITLE_MIN_PRIOR_RETAINED, so the continuation inherits the ID but keeps its OWN name:
  // prior of 5 items, continuation citing 2 → shared 2 (sameArc), retained 0.4 (< 0.5).
  //
  // An earlier version of this test used a 4-item prior and a 1-item continuation. That never inherited
  // at all (shared 1 < MIN_SHARED_ITEMS, and containment needs priorSize <= 2), so `used` stayed empty
  // and `distinctId` was never called — the test passed with the function neutered to `return arc.id`.
  // The fixture below is mutation-verified to go RED under exactly that mutation.
  it("re-keys a genuine id collision between DIFFERENTLY-titled arcs, deterministically", () => {
    const prior = [real("Costs", ["i1", "i2", "i3", "i4", "i5"])];
    const next = [real("Cheaper extraction", ["i1", "i2"]), real("Costs", ["i7", "i8"])];
    const run = () => reconcileArcIdentity(prior, next).arcs;
    const arcs = run();
    expect(arcs).toHaveLength(2); // distinct titles → both survive the title pass
    // The continuation INHERITED the prior id while keeping its own name (retained 0.4 < 0.5) …
    const cont = arcs.find((x) => x.title === "Cheaper extraction")!;
    expect(cont.id).toBe(prior[0].id);
    // … so the legitimately-named "Costs" arc, whose own sha collides with it, must be re-keyed.
    const costs = arcs.find((x) => x.title === "Costs")!;
    expect(costs.id).not.toBe(prior[0].id);
    expect(new Set(arcs.map((x) => x.id)).size).toBe(2);
    expect(run().map((x) => x.id)).toEqual(arcs.map((x) => x.id)); // deterministic across runs
  });

  it("a collapsed duplicate that carried its OWN id is recorded in `supersedes`, not silently dropped", () => {
    // Both duplicates inherit a prior id (the reported prod shape). One must lose — but its identity
    // has to stay answerable, because an `arc_corrections` row is bound to it.
    const T = "PR Review Attestation Gate Enforcement";
    const prior = [real(T, ["i1", "i2"]), { ...arc("arc-other", T, ["i3", "i4"]) }];
    const next = [real(T, ["i1", "i2"]), { ...arc("n2", T, ["i3", "i4"]) }];
    const arcs = reconcileArcIdentity(prior, next).arcs;
    expect(arcs).toHaveLength(1);
    expect(arcs[0].supersedes).toContain("arc-other"); // the absorbed identity is traceable
  });

  it("a merge keeps the LINKED evidence entry when a bare duplicate of the same fact comes first", () => {
    // `itemId` is the anchor the NEXT reconcile matches on, so shadowing it with a bare free-text entry
    // would quietly cost the arc its lineage. First-wins alone doesn't prevent that — prefer-linked does.
    const bare: NarrativeArc = { ...arc("a1", "T", []), evidence: [{ fact: "shared fact" }] };
    const linked: NarrativeArc = { ...arc("a2", "T", []), evidence: [{ fact: "shared fact", itemId: "i9" }] };
    const merged = mergeArcPair(bare, linked);
    expect(merged.evidence).toHaveLength(1);
    expect(merged.evidence[0].itemId).toBe("i9");
  });
});

describe("reconcileArcIdentity — determinism and degenerate inputs", () => {
  it("is deterministic: identical inputs give an identical assignment", () => {
    // A non-deterministic reconciler would reintroduce exactly the churn it exists to remove.
    const prior = [arc("arc-a", "A", ["i1", "i2"]), arc("arc-b", "B", ["i3", "i4"])];
    const next = [arc("arc-x", "X", ["i3", "i4"]), arc("arc-y", "Y", ["i1", "i2"])];
    const once = reconcileArcIdentity(prior, next).arcs.map((a) => a.id);
    const twice = reconcileArcIdentity(prior, next).arcs.map((a) => a.id);
    expect(once).toEqual(twice);
    expect(once).toEqual(["arc-b", "arc-a"]); // matched by evidence, not by position
  });

  it("no prior set means nothing could churn — ratio is 1, not 0", () => {
    const { arcs, continuity } = reconcileArcIdentity([], [arc("arc-x", "X", ["i1"])]);
    expect(arcs[0].id).toBe("arc-x");
    expect(continuity).toMatchObject({ priorCount: 0, carriedOver: 0, ratio: 1 });
  });

  it("arcs with no linkable evidence never match each other", () => {
    // Two evidence-less arcs share "nothing" — fusing them would be identity by coincidence.
    const prior = [arc("arc-a", "A", [])];
    const next = [arc("arc-x", "X", [])];
    expect(reconcileArcIdentity(prior, next).arcs[0].id).toBe("arc-x");
  });

  it("tolerates missing evidence arrays", () => {
    const bare = { ...arc("arc-x", "X", []), evidence: undefined as unknown as NarrativeArc["evidence"] };
    expect(() => reconcileArcIdentity([], [bare])).not.toThrow();
    expect(arcItemIds(bare).size).toBe(0);
  });

  it("does not add an empty supersedes array when there is no lineage", () => {
    const { arcs } = reconcileArcIdentity([], [arc("arc-x", "X", ["i1"])]);
    expect(arcs[0]).not.toHaveProperty("supersedes");
  });
});

describe("isSameArc", () => {
  it("requires two shared items, or containment where the PRIOR is also tiny", () => {
    expect(isSameArc(2, 5, 5)).toBe(true);
    expect(isSameArc(1, 5, 5)).toBe(false);
    expect(isSameArc(1, 1, 1)).toBe(true); // a 1-item arc continuing itself — what containment is for
    expect(isSameArc(1, 1, 8)).toBe(false); // a 1-item arc must NOT claim a big prior on one shared item
    expect(isSameArc(0, 1, 1)).toBe(false);
  });
});

describe("stableArcTarget — the requested count stops oscillating", () => {
  it("holds the previous count when the derived target moves by one", () => {
    // One contributor going quiet moved the target and forced a re-partition of unchanged work.
    expect(stableArcTarget(7, 8)).toBe(8);
    expect(stableArcTarget(9, 8)).toBe(8);
  });

  it("moves one step toward a target that has genuinely shifted", () => {
    expect(stableArcTarget(12, 8)).toBe(9);
    expect(stableArcTarget(4, 8)).toBe(7);
  });

  it("never ratchets the request down when the model returned fewer arcs than asked", () => {
    // The bug this pins, found by an existing test rather than by reading: the only anchor available is
    // how many arcs the previous synthesis OUTPUT, and the model routinely returns fewer than requested.
    // Unbanded, that collapses the request — ask 6, get 3, ask 4, get 2, ask 3 — and the panel empties
    // with nothing in the fact set having changed.
    expect(stableArcTarget(6, 1, 6, 12)).toBe(6);
    expect(stableArcTarget(6, 3, 6, 12)).toBe(6);
    expect(stableArcTarget(8, 0, 6, 12)).toBe(8);
  });

  it("never exceeds the ceiling", () => {
    expect(stableArcTarget(12, 12, 6, 12)).toBe(12);
    expect(stableArcTarget(99, 12, 6, 12)).toBe(12);
  });

  it("ignores a prior ABOVE the ceiling instead of stepping down from it", () => {
    // Distinguishes the two guards: the clamp alone would step 20 → 19 → clamp → 12 and take four more
    // recomputes to reach a target of 6. Refusing to anchor on a count the request could never have
    // produced goes straight there.
    expect(stableArcTarget(6, 20, 6, 12)).toBe(6);
  });

  it("still smooths inside the band", () => {
    expect(stableArcTarget(7, 8, 6, 12)).toBe(8); // within hysteresis → hold
    expect(stableArcTarget(12, 8, 6, 12)).toBe(9); // real shift → one step
  });

  it("takes the target as-is when there is no usable prior", () => {
    expect(stableArcTarget(6, 0)).toBe(6);
    expect(stableArcTarget(6, NaN)).toBe(6);
  });

  it("converges to within the hysteresis band and then stops moving", () => {
    // It settles at 11, not 12, and that is the point: once inside the band the count stops chasing the
    // target. Sitting one arc off a derived number costs nothing; re-partitioning every day costs the
    // stability this whole change is for.
    let n = 8;
    for (let i = 0; i < 10; i++) n = stableArcTarget(12, n);
    expect(Math.abs(12 - n)).toBeLessThanOrEqual(1);
    expect(stableArcTarget(12, n)).toBe(n); // fixed point — no oscillation
  });
});

/**
 * TITLE UNIQUENESS THROUGH RECONCILE (ARCDUP-1). Parse-time merging can't cover this: by the time
 * `reconcileArcIdentity` has written titles, two duplicates carry DIFFERENT ids, so an id-keyed pass
 * sees nothing. Both scenarios below were RED before the title-keyed pass was added.
 */
describe("no two reconciled arcs share a title", () => {
  const a = (id: string, title: string, items: string[], confidence: "high" | "medium" | "low" = "high"): NarrativeArc => ({
    id, title, confidence, summary: `s-${id}`, participants: [`p-${id}`], supporting_sources: [],
    evidence: items.map((i) => ({ fact: `f-${i}`, itemId: i })), derived_at: "2026-08-07T00:00:00.000Z",
  });

  it("title MIGRATION: a renamed continuation inheriting its prior's name can't collide with a new sibling", () => {
    // Prior "Costs" over {a,b}. The model emits a NEW "Costs" over {c,d} (no overlap → keeps its own
    // title) plus a renamed continuation over {a,b} (retained 1.0 → inherits "Costs"). Two "Costs" cards.
    const prior = [a("arc-costs", "Costs", ["a", "b"])];
    const next = [a("arc-new", "Costs", ["c", "d"]), a("arc-cont", "Cheaper extraction", ["a", "b"])];
    const out = reconcileArcIdentity(prior, next).arcs;
    expect(new Set(out.map((x) => x.title)).size).toBe(out.length);
    // The survivor is the one carrying the PRIOR id — corrections (team_id+arc_id) are bound to it.
    const costs = out.find((x) => x.title === "Costs")!;
    expect(costs.id).toBe("arc-costs");
    // …and the newcomer's evidence is absorbed, not dropped.
    expect(costs.evidence.map((e) => e.itemId).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("the reported prod pair cannot regenerate itself from a duplicated PRIOR set", () => {
    // Both duplicates sit in `prior` (that is today's cache). Even a model that COMPLIES with the new
    // distinct-titles instruction gets both arcs renamed back by title inheritance.
    const T = "PR Review Attestation Gate Enforcement";
    const prior = [a("arc-8144f88eb1", T, ["i1", "i2"]), a("arc-90a537271b", T, ["i3", "i4"])];
    const next = [a("n1", "Codex review workflow", ["i1", "i2"]), a("n2", "Retiring Plane MCP", ["i3", "i4"])];
    const out = reconcileArcIdentity(prior, next).arcs;
    expect(new Set(out.map((x) => x.title)).size).toBe(out.length);
  });

  it("CONTROL: distinct titles are left alone — the pass must not collapse real arcs", () => {
    const prior = [a("arc-1", "Costs", ["a"])];
    const next = [a("n1", "Costs", ["a"]), a("n2", "Timeline", ["z"])];
    const out = reconcileArcIdentity(prior, next).arcs;
    expect(out).toHaveLength(2);
    expect(out.map((x) => x.title).sort()).toEqual(["Costs", "Timeline"]);
  });
});
