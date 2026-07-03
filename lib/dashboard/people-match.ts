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
