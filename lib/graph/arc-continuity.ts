import { createHash } from "node:crypto";
import type { NarrativeArc } from "./arcs";

/**
 * DAY-TO-DAY ARC STABILITY — identity by evidence, not by title.
 *
 * The problem this solves: arcs looked completely different every day even when the work hadn't
 * changed. Three compounding causes, only the first of which is fixed here:
 *
 *  1. **Identity was a hash of the title** (`stableId` = sha256(title)). Reword "Social Brain rollout"
 *     into "Rolling out the Social Brain" and it became a brand-new arc. The codebase already knew —
 *     `ArcCorrection.arc_title` exists ONLY because "`arc_id` is sha(title) and churns on every
 *     recompute (M7)". Identity was pinned to the single most volatile thing an LLM emits.
 *  2. Every recompute was de novo — the prompt never showed the model its previous answer.
 *  3. The requested arc count moved with the daily contributor count, forcing a re-partition of
 *     unchanged work (see `stableArcTarget`).
 *
 * The existing `canReuseArcs` guard does NOT cover this: it requires a byte-identical fact set, so it
 * only stops churn between views on the same day. Any new work at all → full re-synthesis.
 *
 * The fix: after synthesis, match each new arc to the previous set on the **source items its evidence
 * cites**, and let a match INHERIT the prior arc's id. Item ids are the one durable thing an arc
 * carries — they come from the graph, not the model — so "same work, reworded" becomes a continuation
 * instead of a new arc. Pure and total, so every rule below is unit-testable.
 */

/** Two arcs citing this many of the same source items are about the same work. Below it, an overlap is
 *  more likely to be an incidental shared meeting/PR than a continuation. */
const MIN_SHARED_ITEMS = 2;

/** Keep the previous TITLE while at least this share of the prior arc's items are still cited. Above it
 *  the arc is recognisably the same story and renaming it is pure churn; below it the work has moved on
 *  and the model's new title is the more honest label — a frozen title on drifted evidence is its own
 *  kind of lie. */
const KEEP_TITLE_MIN_PRIOR_RETAINED = 0.5;

/** The distinct brain item ids an arc's evidence cites. The durable identity anchor: unlike title or
 *  summary, these are graph facts, not model prose. */
export function arcItemIds(arc: Pick<NarrativeArc, "evidence">): Set<string> {
  return new Set((arc.evidence ?? []).map((e) => e.itemId).filter((id): id is string => !!id));
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const v of a) if (b.has(v)) n++;
  return n;
}

/**
 * Is this overlap strong enough to call the two arcs the same story? Either they share at least
 * `MIN_SHARED_ITEMS`, or the smaller arc's evidence is wholly contained in the larger's — the second
 * clause is what lets a 1-evidence arc continue instead of being reborn every day.
 */
export function isSameArc(sharedCount: number, nextSize: number, priorSize: number): boolean {
  if (sharedCount === 0) return false;
  if (sharedCount >= MIN_SHARED_ITEMS) return true;
  // Containment rescues the SMALL arc that would otherwise be reborn daily — a person's single thread.
  // It must not become a back door for a 1-item arc to claim a large prior's identity on one shared
  // item: that is the incidental-all-hands case `MIN_SHARED_ITEMS` exists to exclude, and it would bind
  // the prior's stored correction to unrelated work. So BOTH sides have to be small.
  return sharedCount === Math.min(nextSize, priorSize) && priorSize <= MIN_SHARED_ITEMS;
}

/** A collision-free id for an arc that did NOT inherit one: keyed on title PLUS the evidence it cites,
 *  so two same-titled split siblings differ by the only thing that actually distinguishes them.
 *  Deterministic (items sorted) — a random suffix would reintroduce churn on every recompute. */
function distinctId(arc: NarrativeArc, items: Set<string>): string {
  const seed = `${arc.title.trim().toLowerCase()}|${[...items].sort().join(",")}`;
  return "arc-" + createHash("sha256").update(seed).digest("hex").slice(0, 10);
}

/** Strongest-wins ordering when two arcs collapse into one. */
const CONFIDENCE_RANK: Record<NarrativeArc["confidence"], number> = { high: 3, medium: 2, low: 1 };

/**
 * Fold `absorbed` into `survivor`, losing nothing. Lives HERE (not in `arcs`) because both callers need
 * it and `arcs` already imports this module — the reverse would be a cycle.
 *
 * `survivor` keeps its id and title; everything additive is unioned.
 *
 * Evidence dedups on the fact TEXT and PREFERS THE LINKED ENTRY, not merely the first one. `itemId` is
 * the continuity anchor the next reconcile matches on, so losing it costs the arc its lineage — and
 * first-wins alone doesn't prevent that: when the bare `{fact}` from the free-text `supporting_sources`
 * fallback happens to come first, it shadows the linked copy of the same text.
 *
 * The absorbed arc's IDENTITY is not silently dropped. If it carried an id of its own (it inherited a
 * prior, or was re-keyed) that id — and anything it had already superseded — is recorded in the
 * survivor's `supersedes`, so "where did arc-90a537271b go" stays answerable and a stored correction
 * bound to it is traceable rather than orphaned.
 */
export function mergeArcPair(survivor: NarrativeArc, absorbed: NarrativeArc): NarrativeArc {
  const evidence = new Map<string, NarrativeArc["evidence"][number]>();
  for (const e of [...survivor.evidence, ...absorbed.evidence]) {
    const held = evidence.get(e.fact);
    if (!held || (!held.itemId && e.itemId)) evidence.set(e.fact, e);
  }
  const supersedes = [
    ...new Set([
      ...(survivor.supersedes ?? []),
      ...(absorbed.supersedes ?? []),
      ...(absorbed.id && absorbed.id !== survivor.id ? [absorbed.id] : []),
    ]),
  ];
  // Fold summaries one at a time so a 3-way merge can't re-append a sentence already carried in the
  // joined text (comparing the pair only catches the 2-way case).
  const summary = [survivor.summary, absorbed.summary]
    .map((s) => s.trim())
    .filter(Boolean)
    .reduce((acc, s) => (acc === "" || acc.includes(s) ? acc || s : `${acc} ${s}`), "");
  return {
    ...survivor,
    confidence:
      CONFIDENCE_RANK[absorbed.confidence] > CONFIDENCE_RANK[survivor.confidence]
        ? absorbed.confidence
        : survivor.confidence,
    summary,
    participants: [...new Set([...survivor.participants, ...absorbed.participants])],
    supporting_sources: [...new Set([...survivor.supporting_sources, ...absorbed.supporting_sources])],
    evidence: [...evidence.values()],
    ...(supersedes.length ? { supersedes } : {}),
  };
}

export interface ArcContinuity {
  /** How many arcs the previous set had. */
  priorCount: number;
  /** How many arcs the new set has. */
  nextCount: number;
  /** New arcs that inherited a prior id — i.e. yesterday's arcs that survived. */
  carriedOver: number;
  /** carriedOver / priorCount, or 1 when there was no prior (nothing could churn). */
  ratio: number;
}

export interface ReconcileResult {
  arcs: NarrativeArc[];
  continuity: ArcContinuity;
}

/**
 * Give each new arc the id of the prior arc it continues.
 *
 * Greedy, highest-overlap-first, deterministic: pairs are ordered by shared-item count, then by the
 * smaller symmetric ratio, then by the arcs' positions — so the same inputs always produce the same
 * assignment (a non-deterministic reconciler would reintroduce the churn it exists to remove).
 *
 * Each prior id is claimed by at most one new arc, which is what makes SPLIT and MERGE fall out for
 * free — both of which the product explicitly allows:
 *   • MERGE  — several priors overlap one new arc: it inherits the strongest match's id, and the others
 *              are recorded in `supersedes` so the lineage is inspectable rather than silently dropped.
 *   • SPLIT  — one prior overlaps several new arcs: the strongest match continues it; the siblings are
 *              genuinely new arcs (new ids) but still record `supersedes`, so "where did this come
 *              from" is answerable.
 */
export function reconcileArcIdentity(prior: NarrativeArc[], next: NarrativeArc[]): ReconcileResult {
  const priorArcs = prior ?? [];
  const nextArcs = next ?? [];
  const priorItems = priorArcs.map(arcItemIds);
  const nextItems = nextArcs.map(arcItemIds);

  type Pair = { n: number; p: number; shared: number; ratio: number; sameArc: boolean };
  const pairs: Pair[] = [];
  for (let n = 0; n < nextArcs.length; n++) {
    for (let p = 0; p < priorArcs.length; p++) {
      const shared = intersectionSize(nextItems[n], priorItems[p]);
      if (shared === 0) continue;
      const ratio = shared / Math.max(1, Math.min(nextItems[n].size, priorItems[p].size));
      // Any overlap is a lineage CANDIDATE; only a strong one is an identity claim. Keeping both is
      // what lets a split's smaller sibling say where it came from — it overlaps the parent by too
      // little to BE the parent, but "came from arc-a" is still the true and useful answer.
      pairs.push({ n, p, shared, ratio, sameArc: isSameArc(shared, nextItems[n].size, priorItems[p].size) });
    }
  }
  // Strongest evidence first; positions break every remaining tie so the result is a pure function of
  // the inputs and not of Array.sort's stability on this engine.
  pairs.sort((a, b) => b.shared - a.shared || b.ratio - a.ratio || a.n - b.n || a.p - b.p);

  const inheritedBy = new Map<number, number>(); // next index → prior index
  const claimedPrior = new Map<number, number>(); // prior index → the next index that inherited it
  for (const { n, p, sameArc } of pairs) {
    if (!sameArc || inheritedBy.has(n) || claimedPrior.has(p)) continue;
    inheritedBy.set(n, p);
    claimedPrior.set(p, n);
  }
  // Lineage, computed AFTER identity so the two shapes can be told apart and named HONESTLY. They are
  // different claims and conflating them makes the stored field a lie:
  //   • SUPERSEDES — a prior this arc overlaps that NOBODY inherited. It is gone; this arc absorbed it.
  //   • SPLIT-FROM — a prior this arc overlaps that a DIFFERENT arc inherited. That prior is still alive
  //     on screen, so this arc did not supersede it — it is a sibling that came out of it.
  // Neither is an identity claim, so neither can move an id.
  const absorbed = new Map<number, number[]>();
  const splitFrom = new Map<number, number>();
  for (const { n, p, sameArc } of pairs) {
    if (inheritedBy.get(n) === p) continue;
    if (claimedPrior.has(p)) {
      // Only a real split — a strong-enough overlap with a prior that lives on elsewhere. A weak
      // incidental brush with an ongoing arc is not lineage.
      if (sameArc && !splitFrom.has(n)) splitFrom.set(n, p);
      continue;
    }
    (absorbed.get(n) ?? absorbed.set(n, []).get(n)!).push(p);
  }

  // Ids actually emitted, so a NON-inheriting arc can be re-keyed off a collision. Inherited ids are
  // reserved first — they are the identities that must survive.
  const used = new Set<string>();
  for (const [, p] of inheritedBy) used.add(priorArcs[p].id);

  const arcs = nextArcs.map((arc, n) => {
    const p = inheritedBy.get(n);
    const sf = splitFrom.get(n);
    const lineageFields = {
      ...(absorbed.get(n)?.length
        ? { supersedes: [...new Set(absorbed.get(n)!.map((i) => priorArcs[i].id))] }
        : {}),
      ...(sf !== undefined ? { splitFrom: priorArcs[sf].id } : {}),
    };

    if (p === undefined) {
      // A SPLIT sibling routinely arrives carrying the parent's own id: production ids are
      // `sha(title)` and the continuity prompt explicitly tells the model to keep titles unchanged, so
      // both children of "Costs" parse as `stableId("Costs")` — the exact id the winning child just
      // inherited. Emitting both would give two cards the same React key, make one edit target both,
      // and bind a single `arc_corrections` row (unique on team_id+arc_id) to two different arcs.
      const id = used.has(arc.id) ? distinctId(arc, nextItems[n]) : arc.id;
      used.add(id);
      return { ...arc, id, ...lineageFields };
    }
    const priorArc = priorArcs[p];
    // Keep the recognisable name while the arc is still substantially the same work.
    const retained = intersectionSize(nextItems[n], priorItems[p]) / Math.max(1, priorItems[p].size);
    const title = retained >= KEEP_TITLE_MIN_PRIOR_RETAINED ? priorArc.title : arc.title;
    return { ...arc, id: priorArc.id, title, ...lineageFields };
  });

  // TITLE UNIQUENESS — enforced HERE because this function is the last thing that writes a title, and
  // the line above is itself a source of duplicates: an arc that inherits a prior's name can collide
  // with a sibling the model legitimately named differently. Parse-time merging (`mergeDuplicateTitles`)
  // cannot cover it — by this point the duplicates carry DIFFERENT ids, so an id-keyed pass sees nothing.
  //
  // Two live paths, both reproduced as tests: (a) prior "Costs" over {a,b}; the model emits a NEW "Costs"
  // over {c,d} plus a renamed continuation over {a,b} which inherits "Costs" — two cards, one name; and
  // (b) the reported prod pair regenerating itself, because both duplicates sit in `prior`, so even a
  // model that COMPLIES with the new distinct-titles instruction gets both arcs renamed back.
  //
  // The survivor is the arc that INHERITED a prior id — `arc_corrections` (team_id+arc_id) and the
  // lineage fields are bound to it, so keeping the newcomer would strand a human's edit.
  const byTitle = new Map<string, number>(); // normalized title → index of the survivor in `deduped`
  const deduped: NarrativeArc[] = [];
  // Inheritance is tracked ALONGSIDE the survivor, never re-derived from the array: once an entry has
  // been merged it is a new object, so `arcs.indexOf(...)` would return -1 and silently report every
  // incumbent as non-inheriting — handing the survivor role to the wrong arc on a three-way collision.
  const survivorInherited: boolean[] = [];
  arcs.forEach((arc, n) => {
    const key = arc.title.trim().toLowerCase();
    const inherited = inheritedBy.has(n);
    const at = byTitle.get(key);
    if (at === undefined) {
      byTitle.set(key, deduped.length);
      deduped.push(arc);
      survivorInherited.push(inherited);
      return;
    }
    if (inherited && !survivorInherited[at]) {
      deduped[at] = mergeArcPair(arc, deduped[at]); // the newcomer carries the lineage — it survives
      survivorInherited[at] = true;
      return;
    }
    deduped[at] = mergeArcPair(deduped[at], arc);
  });

  const carriedOver = inheritedBy.size;
  return {
    arcs: deduped,
    continuity: {
      priorCount: priorArcs.length,
      nextCount: nextArcs.length,
      carriedOver,
      // No prior means nothing could churn — reporting 0 would make a first-ever synthesis look like
      // total instability and drag any average down.
      ratio: priorArcs.length === 0 ? 1 : carriedOver / priorArcs.length,
    },
  };
}

/**
 * How many arcs to ask for, held steady across recomputes.
 *
 * `arcsRequested` derives a target from how many contributors made the balanced fact cut, so one person
 * going quiet moved the target (e.g. 8 → 6) and forced the model to re-partition work that had not
 * changed. Hysteresis: stay on the previous count while the newly-derived target is within
 * `ARC_TARGET_HYSTERESIS` of it, and otherwise move ONE step toward the target rather than jumping.
 * The count then tracks real changes in team shape over a few days instead of oscillating daily.
 *
 * Pure. `priorCount <= 0` (no usable prior) means take the target as-is — there is nothing to be stable
 * relative to.
 */
export const ARC_TARGET_HYSTERESIS = 1;

/**
 * `floor`/`ceiling` are the band `arcsRequested` can legally produce, and they are NOT decoration.
 *
 * The only anchor available is how many arcs the previous synthesis OUTPUT, and the model routinely
 * returns fewer than were requested. Anchoring naively to that creates a downward ratchet: ask for 6,
 * get 3, ask for 4, get 2, ask for 3 … the request collapses toward zero and the panel empties, with
 * nothing in the fact set having changed. So a prior OUTSIDE the band is not a target the request ever
 * chose and cannot anchor anything, and the result is clamped back into the band regardless.
 */
export function stableArcTarget(
  target: number,
  priorCount: number,
  floor = 0,
  ceiling = Number.POSITIVE_INFINITY
): number {
  const clamp = (n: number) => Math.min(ceiling, Math.max(floor, n));
  const anchored =
    Number.isFinite(priorCount) && priorCount >= floor && priorCount <= ceiling && priorCount > 0;
  if (!anchored) return clamp(target);
  if (Math.abs(target - priorCount) <= ARC_TARGET_HYSTERESIS) return clamp(priorCount);
  return clamp(priorCount + Math.sign(target - priorCount));
}
