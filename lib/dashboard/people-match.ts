/**
 * Match a Learning-layer person entity name to a roster member.
 *
 * The Learning layer (Graphiti) names people by freeform extracted text — the same person shows up
 * as "John", "John Ellison", "Chetan", "Chetan Nandakumar". The dashboard keys "who's working on
 * what" off the canonical MEMBER ROSTER (one row per real person, with a clean display name), and
 * uses this matcher to fold the graph's noisy aliases back onto that roster. That is what dedupes
 * "two Johns" (both graph nodes → the single roster member "John Ellison") and lets a member whose
 * display name is just a first name ("Chetan") still match "Chetan Nandakumar".
 *
 * Pure + dependency-free so the identity logic is unit-tested in isolation.
 */

export interface RosterPerson {
  memberId: string;
  displayName: string;
  handle: string;
}

/** Lowercase, strip punctuation, collapse whitespace — so "John-Ellison" ≈ "John Ellison". */
export function normName(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when a Learning-layer subject name refers to this roster member.
 *
 * Matches on, in order: exact display name, exact handle (dashes→spaces), or a shared FIRST name
 * where one side is a bare first name (e.g. graph "John" ↔ roster "John Ellison", graph
 * "Chetan Nandakumar" ↔ roster "Chetan"). When BOTH names carry a surname they must match in full,
 * so "John Ellison" and "John Smith" never collide.
 */
export function subjectMatchesMember(subject: string, person: RosterPerson): boolean {
  const s = normName(subject);
  if (!s) return false;
  const dn = normName(person.displayName);
  const handle = normName((person.handle ?? "").replace(/[-_]+/g, " "));
  if ((dn && s === dn) || (handle && s === handle)) return true;

  const dnTokens = dn.split(" ").filter(Boolean);
  const sTokens = s.split(" ").filter(Boolean);
  if (!dnTokens.length || !sTokens.length) return false;
  if (sTokens[0] !== dnTokens[0]) return false; // different first name → not a match

  // Same first name: safe to fold only when at least one side is a bare first name. If both carry a
  // surname, require full equality (already checked above → false here) to avoid surname collisions.
  return sTokens.length === 1 || dnTokens.length === 1;
}

/**
 * Every roster member named in a `decisions.decided_by` string.
 *
 * Written because the timeline DROPPED anything that wasn't exactly one name. Prod: 27 of 56 decisions
 * (48%) carry a joint or qualified attribution — `"John Ellison & Chetan"`, `"Chetan (agreed by John)"`,
 * `"John Ellison (fix by Fable)"` — so nearly half the decision log was invisible on the timeline, and
 * silently: the decisions two people made TOGETHER were exactly the ones that vanished.
 *
 * Crediting one of them would have been wrong (whose day does a joint call belong in?), which is why the
 * old code refused — but the answer is BOTH, the same way a Slack thread credits every participant. So
 * the string is split on the separators that mean "and also", role prefixes are stripped (`agreed by
 * Chetan` → `Chetan`), and each fragment is matched independently.
 *
 * Conservative in the same direction as before: a fragment that matches no member (an AI agent, an
 * outside party) contributes nothing, and a fragment matching TWO members is ambiguous and contributes
 * nothing — never a guess. Order is the order named, so the first is the primary decider. Pure.
 */
export function decisionActors(decidedBy: string, roster: readonly RosterPerson[]): string[] {
  // `&`, `+`, `/`, `,`, ` and ` all mean "and also"; parentheses delimit a qualifying clause whose
  // CONTENT still names a person ("(agreed by Chetan)"), so they are separators, not deletions.
  const fragments = (decidedBy ?? "")
    .split(/[&+,/()]|\band\b/i)
    .map((f) =>
      // Role prefixes: keep the person, drop the verb.
      f.replace(/^\s*(agreed|approved|confirmed|proposed|reviewed|fixed|fix|prompted|suggested)\s+by\s+/i, "").trim()
    )
    .filter(Boolean);

  const out: string[] = [];
  for (const fragment of fragments) {
    const matched = roster.filter((p) => subjectMatchesMember(fragment, p));
    if (matched.length !== 1) continue; // no match, or ambiguous → contribute nothing
    if (!out.includes(matched[0].memberId)) out.push(matched[0].memberId);
  }
  return out;
}
