/**
 * THE Google `author-email:` comparison and history decision (AIO-1167 PR743; PR714 Google-reader
 * extension decision). Pure and dependency-free, so the identity writer (`member-identities`) and the
 * readers (`resolve`, the Drive repair nomination) share ONE source of truth without a reader importing
 * a writer.
 *
 * Equivalence applies ONLY to provider `gdrive` and only to a key whose trimmed form starts with
 * `author-email:` case-insensitively: the whole key is trimmed, the prefix matched, the address trimmed
 * and lowercased with JavaScript `toLowerCase`. No Unicode normalization; `subject:`, `permission:`,
 * every opaque Drive id, Slack and every other provider keep their own semantics. Persisted keys are
 * never rewritten: callers compare through this function and keep the exact stored bytes.
 */

const GOOGLE_EMAIL = /^author-email:(.*)$/i;

/** The canonical `author-email:` key a Google email identity compares under, or `null` when the key is
 * not a Google email identity (another provider, or an opaque Google id). */
export function googleEmailKey(provider: string, externalId: string): string | null {
  if (provider.trim().toLowerCase() !== "gdrive") return null;
  const match = GOOGLE_EMAIL.exec(externalId.trim());
  return match ? `author-email:${match[1].trim().toLowerCase()}` : null;
}

/** What the equivalent mapping histories of one canonical Google email key decide.
 *  `none` — never reviewed; `linked` / `unlinked` — one applicable decision; `ambiguous` — several
 *  equivalent histories and no canonical decision, so none applies (fail closed). */
export type GoogleEmailHistory = "none" | "linked" | "unlinked" | "ambiguous";

export interface GoogleEmailState {
  /** The EXACT stored key of this history. */
  externalId: string;
  state: string;
}

/**
 * Decide applicability, independent of row order. The canonical key's OWN state governs alone (an
 * explicit, fenced canonical relink writes it — that is how older equivalent history is resolved
 * without being rewritten). Without one: zero histories → `none`; exactly one → that decision; more
 * than one → `ambiguous`, whatever their values. `governing` is the one history that decided, so a
 * caller never attaches one key's revision to another.
 */
export function googleEmailHistory(
  canonical: string,
  states: readonly GoogleEmailState[],
): { history: GoogleEmailHistory; governing?: GoogleEmailState } {
  const own = states.find((state) => state.externalId === canonical);
  if (own) return { history: own.state === "unlinked" ? "unlinked" : "linked", governing: own };
  if (states.length === 0) return { history: "none" };
  if (states.length > 1) return { history: "ambiguous" };
  const only = states[0];
  return { history: only.state === "unlinked" ? "unlinked" : "linked", governing: only };
}
