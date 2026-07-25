/**
 * The reader side of a Slack thread's `participants[]` frontmatter ledger — written by
 * `lib/ingest/sources/slack-normalize`, consumed by BOTH the work timeline and the credit oracle.
 *
 * Why this is its own module: a Slack thread is one item whose body is rewritten on every reply, and
 * each version is stamped with the thread-ROOT author — so `item_versions` cannot answer "who worked
 * on this". `participants[]` can, which makes it the conversation work ledger, and therefore a fact
 * two independent surfaces need. They previously each parsed and resolved it inline and had already
 * drifted (different dedup and case-folding), which is precisely the divergence the single-source
 * attribution guard exists to prevent. One parser, one fold, here.
 *
 * Pure — no DB, no server-only — so both a server module and a test can use it directly.
 */

/** One participant's contribution to a thread, normalized. */
export interface SlackParticipation {
  /** Slack user id exactly as the source reported it (fold with `foldProviderId` before matching). */
  authorId: string;
  /** ISO time of their LAST message in the thread — their contribution time. "" when absent. */
  lastTs: string;
}

interface RawParticipant {
  author_id?: unknown;
  last_ts?: unknown;
}

/**
 * Canonical fold for a provider external id. Mirrors `lib/identity/resolve.providerKey`, which stores
 * and matches ids case-insensitively — `setMemberIdentity` keeps the original case and an admin may
 * type one by hand, so any raw comparison silently fails to match that person.
 */
export function foldProviderId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * Parsed participants in WORK ORDER (oldest last-message first), one entry per distinct author,
 * keeping their LATEST contribution time. Malformed entries are dropped rather than credited as a
 * blank. `[]` for a non-Slack item or one carrying no ledger (e.g. a thread ingested before it
 * existed) — callers then fall back to their own evidence.
 */
export function slackParticipations(fm: Record<string, unknown> | null | undefined): SlackParticipation[] {
  if (!fm || fm.source !== "slack") return [];
  const raw = fm.participants;
  if (!Array.isArray(raw)) return [];

  const byAuthor = new Map<string, string>(); // authorId → latest lastTs
  for (const p of raw as RawParticipant[]) {
    const authorId = typeof p?.author_id === "string" ? p.author_id.trim() : "";
    if (!authorId) continue;
    const lastTs = typeof p?.last_ts === "string" ? p.last_ts : "";
    const prior = byAuthor.get(authorId);
    // Keep the LATEST time if a payload somehow repeats an author (the producer already dedupes).
    if (prior === undefined || lastTs > prior) byAuthor.set(authorId, lastTs);
  }
  return [...byAuthor.entries()]
    .map(([authorId, lastTs]) => ({ authorId, lastTs }))
    .sort((a, b) => (a.lastTs < b.lastTs ? -1 : a.lastTs > b.lastTs ? 1 : 0));
}

/**
 * The conversation WORK LEDGER: the thread's distinct contributors as Slack user ids, oldest
 * contribution first — so the LAST entry is the most recent worker, matching how version order is
 * consumed downstream (`latestWorkerId`).
 */
export function slackContributors(fm: Record<string, unknown> | null | undefined): string[] {
  return slackParticipations(fm).map((p) => p.authorId);
}
