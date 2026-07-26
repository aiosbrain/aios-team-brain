/**
 * PER-SOURCE INGESTION RULES — one declarative table, in the brain, read by every surface.
 *
 * Why a layer and not an `if` in a connector: the ingest contract is deliberately uniform (every
 * source produces the same `ItemPayload`), but sources are NOT uniform in what their metadata
 * *means*. The same wire field carries different evidence depending on who emitted it, and code that
 * has to choose between two correct-for-one-source behaviours cannot be written without knowing
 * which source it is holding. Putting that knowledge in each connector is the version of this that
 * doesn't work — the decision is made downstream, in the brain, long after the connector has run,
 * and the Python sidecar can't reach it at all. So the rules live at the lowest shared layer: one
 * table here, consulted by the writer.
 *
 * The case that forced it (audit M2): a `touch`, `rsync` or `chmod` on a local file moves its mtime
 * with no content change. `local.py` emits mtime as `source_ts`, so the unchanged-body heal rewrote
 * the item's work-time and a file nobody had opened in a year resurfaced as **today's work** in the
 * Timeline and "Working on". The obvious fix — "preserve work-time when the body doesn't change" —
 * is WRONG for Linear and Plane, whose `source_ts` is the issue's last state transition: a ticket
 * moving to `completed` is genuine work with an unchanged document body. One behaviour is right for
 * one source and wrong for the other, which is precisely the shape that needs a rules layer rather
 * than a patch.
 *
 * Adding a source means adding a row here — enforced by `test/guards/source-rules-complete.test.ts`
 * so a new connector can't inherit a default silently.
 */

/**
 * Is a work-time that MOVED while the body stayed byte-identical evidence that work happened?
 *
 *  • `"work"` — yes. The timestamp tracks an event in the source (a state transition, a commit, a
 *    message), so it moving IS the news even though the rendered body didn't change.
 *  • `"noise"` — no. The timestamp tracks the record's storage, not anyone's activity, so it moves
 *    for reasons that have nothing to do with work being done.
 */
export type WorkTimeEvidence = "work" | "noise";

export interface SourceRules {
  workTimeOnUnchangedBody: WorkTimeEvidence;
  /**
   * May superseded bodies be RETAINED in `item_versions`?
   *
   * The default is `true` — history is worth keeping, and for a document whose old revisions were
   * genuinely authored, the retained body is a real record.
   *
   * `false` is for sources whose item body is a **re-render of live, source-owned content that the
   * source can retract**. A Slack thread is one item holding the whole conversation, rewritten every
   * sync: delete a message and the current body self-heals, but every retained body still contains
   * it — so the brain keeps, verbatim and indefinitely, text the author erased at the source. That
   * isn't history, it's a copy the source no longer consents to.
   *
   * Only the BODY is cleared; the rows stay. `item_versions` is the work ledger — `member_id` +
   * `created_at` attribute contributor credit, the timeline and arcs — and dropping rows would
   * silently rewrite who did what. Nothing reads `item_versions.body`; it is history, not a served
   * surface.
   */
  retainSupersededBodies: boolean;
}

/**
 * Every source that reaches `ingestItem`, keyed by the `frontmatter.source` its producer stamps.
 *
 * The default is `"work"` and each entry says why it isn't — a source is only demoted to `"noise"`
 * on demonstrated evidence that its timestamp moves without anyone doing anything, never on a guess.
 * Freezing a work-time wrongly makes real work invisible, which is the worse error of the two.
 */
export const SOURCE_RULES: Readonly<Record<string, SourceRules>> = {
  // ── Event-shaped timestamps: the move IS the work ──────────────────────────────────────────────
  /** Thread `ts` — immutable per thread; a new message changes the body anyway.
   *
   *  `retainSupersededBodies: false` — the ONLY source that opts out today, and the reason is
   *  deletion, not tidiness: one item holds the whole conversation and is re-rendered every sync, so
   *  a message deleted at the source vanishes from the current body while every retained body still
   *  quotes it verbatim, forever. */
  slack: { workTimeOnUnchangedBody: "work", retainSupersededBodies: false },
  /** `committed_at` — immutable per commit. */
  git: { workTimeOnUnchangedBody: "work", retainSupersededBodies: true },
  /** Issue activity / a repo file's last commit. */
  github: { workTimeOnUnchangedBody: "work", retainSupersededBodies: true },
  /** `linearWorkedAt` = last state transition. A ticket reaching `completed` is work, and its doc
   *  body is unchanged — the exact case that makes "always preserve" wrong. */
  linear: { workTimeOnUnchangedBody: "work", retainSupersededBodies: true },
  /** `planeWorkedAt` — same shape as Linear. */
  plane: { workTimeOnUnchangedBody: "work", retainSupersededBodies: true },
  /** Meeting occurrence time. */
  granola: { workTimeOnUnchangedBody: "work", retainSupersededBodies: true },
  /** The feed entry's own published/updated time — an event, not the scan's clock. */
  radar: { workTimeOnUnchangedBody: "work", retainSupersededBodies: true },

  // ── Edit-shaped timestamps: a human edited the document, so still work ─────────────────────────
  // These bump on a metadata-only edit too (a Notion property, a Drive rename), which is weaker
  // evidence — but a human did touch the document, and demoting them would hide real editing work.
  // Left as "work" deliberately rather than guessed into "noise".
  notion: { workTimeOnUnchangedBody: "work", retainSupersededBodies: true },
  gdrive: { workTimeOnUnchangedBody: "work", retainSupersededBodies: true },
  confluence: { workTimeOnUnchangedBody: "work", retainSupersededBodies: true },
  /** Moot today — `web.py` emits no timestamp at all. Classified so the guard stays satisfied;
   *  revisit if it ever grows one, since a FETCH time would be noise-shaped, not work-shaped. */
  web: { workTimeOnUnchangedBody: "work", retainSupersededBodies: true },

  // ── Storage-shaped timestamps: not evidence of anything ────────────────────────────────────────
  /** mtime. `touch`, `rsync`, `chmod`, a checkout, a backup restore — all move it with no author and
   *  no edit. This is audit M2: the whole reason this table exists.
   *
   *  Accepted consequence, since "mtime is never evidence" has to mean it in both directions: the
   *  freeze is direction-agnostic, so an item whose stored frontmatter carries NO work-time (a row
   *  pushed before `local.py` emitted `source_ts`) stays on the `created_at` fallback until someone
   *  actually edits the file. A backward correction is refused for the same reason. */
  local: { workTimeOnUnchangedBody: "noise", retainSupersededBodies: true },
};

/**
 * The rules for a source. An UNKNOWN source gets the conservative default (`"work"`): a source we
 * haven't classified must not have its work-time silently frozen, because that makes real work
 * disappear from the Timeline with nothing to indicate why. The completeness guard is what stops the
 * default from being load-bearing.
 */
export function sourceRules(source: unknown): SourceRules {
  const key = typeof source === "string" ? source.toLowerCase().trim() : "";
  return SOURCE_RULES[key] ?? { workTimeOnUnchangedBody: "work", retainSupersededBodies: true };
}
