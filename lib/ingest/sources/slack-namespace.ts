import { parseSlackTimestamp } from "./slack-message-evidence";

/**
 * PURE Slack item-path namespace (AIO-1170).
 *
 * Nothing imports this yet. `slack-normalize` still writes the three-segment
 * `slack/<channel>/<root-ts>.md`, and no stored path changes because this file exists. It is the
 * path half of the design doc's workspace-qualified namespace, isolated so its invariants can be
 * pinned before any writer, reader, migration or publication gate depends on them.
 *
 * WHY a workspace segment at all: `path` is an item's identity (`unique (team_id, project_id,
 * path)`), and today it records the channel but not the workspace it came from. Channel-ID
 * uniqueness ACROSS installations is not something we can assume, so one AIOS team connected to two
 * workspaces — or a Slack Connect channel read from either side — can collide on a single identity
 * and overwrite another conversation's thread. The canonical shape is therefore
 * `slack/<workspace>/<channel>/<root-ts>.md`.
 *
 * Three rules hold this file together:
 *
 *  1. PARSING IS NOT IDENTITY. `parseSlackItemPath` reports the SEGMENTS that were on disk. A legacy
 *     segment may be a channel id or an old display-name slug — nothing here can tell, so nothing
 *     here claims. A legacy path never acquires a workspace, and there is deliberately no
 *     legacy→scoped converter and no "pick a workspace" helper: that binding needs persisted,
 *     verified provenance, which lives in the later migration/publication gate.
 *  2. THE STRING IS THE IDENTITY. Segments and the root `ts` are returned byte-exact, never
 *     lowercased, trimmed, or re-rendered from a parsed number. Two `ts` strings denoting one instant
 *     are two different paths, because that is what the uniqueness constraint compares.
 *  3. INVALID INPUT IS REJECTED, NEVER REPAIRED. `safeSegment` in `slack-normalize` coerces anything
 *     into a segment — correct when minting a path from a provider value, and exactly wrong here,
 *     where coercion would map a malformed path onto a VALID one belonging to a different thread.
 *     Parsing answers `null`; building throws.
 *
 * Out of scope, on purpose: whether an id is genuine, whether an item may be PUBLISHED at a scoped
 * path, and any rewrite of stored paths. The scoped prefix below is a PATH prefix — not an escaped
 * SQL pattern and not proof of access; SQL consumers keep using `escapeLike`/parameterization and
 * their own visibility filters.
 */

const SOURCE_SEGMENT = "slack";

/**
 * The alphabet `safeSegment` can actually emit: it lower-cases, replaces every other run with `-`,
 * and falls back to `channel`. So a stored legacy segment is `[a-z0-9_-]+` and nothing else —
 * accepting more would be accepting paths this codebase has never written.
 */
const LEGACY_SEGMENT = /^[a-z0-9_-]+$/;

/**
 * Slack workspace/channel ids as the provider states them: ASCII alphanumeric, matched
 * case-insensitively because stored scoped paths are canonicalized to lower case while provider
 * values arrive upper. No length or prefix-letter rule — guessing `T…`/`C…` shapes would reject ids
 * Slack is free to mint.
 */
const SOURCE_ID_SEGMENT = /^[A-Za-z0-9]+$/;

const MD_SUFFIX = ".md";

/** A stored `slack/<channel-segment>/<root-ts>.md` path. The segment is a STRING THAT WAS ON DISK. */
export interface LegacySlackItemPath {
  kind: "legacy";
  /**
   * The second path segment verbatim. NOT proof of a channel id: pre-`20260725180000` paths were
   * keyed on a display-name slug, and the two are indistinguishable here.
   */
  channelSegment: string;
  /** The Slack root `ts` verbatim, as it appears in the filename. */
  rootTs: string;
}

/** A stored `slack/<workspace>/<channel>/<root-ts>.md` path. Segments are verbatim, case included. */
export interface ScopedSlackItemPath {
  kind: "scoped";
  /** Third-segment string. Syntactically a Slack id; provenance is a later gate's business. */
  channelSegment: string;
  /** Second-segment string, same caveat. */
  workspaceSegment: string;
  rootTs: string;
}

export type ParsedSlackItemPath = LegacySlackItemPath | ScopedSlackItemPath;

/**
 * A stored Slack item path → its segments, or `null` when it is not exactly one of the two shapes.
 *
 * `null` means "not a Slack item path this codebase recognises" — it is never a repaired path, and a
 * consumer must treat it as unknown rather than falling back to a guess.
 */
export function parseSlackItemPath(path: string): ParsedSlackItemPath | null {
  if (typeof path !== "string" || path === "") return null;

  // Raw split, never `.filter(Boolean)`: dropping an empty segment turns `slack//c1/…` into a valid
  // three-segment path, which is precisely the "repair into somebody else's identity" failure.
  const segments = path.split("/");
  if (segments.length !== 3 && segments.length !== 4) return null;
  if (segments[0] !== SOURCE_SEGMENT) return null;
  if (segments.some((segment) => segment === "")) return null;

  const rootTs = parseRootFile(segments[segments.length - 1]);
  if (rootTs === null) return null;

  if (segments.length === 3) {
    const channelSegment = segments[1];
    if (!LEGACY_SEGMENT.test(channelSegment)) return null;
    return { kind: "legacy", channelSegment, rootTs };
  }

  const workspaceSegment = segments[1];
  const channelSegment = segments[2];
  if (!SOURCE_ID_SEGMENT.test(workspaceSegment)) return null;
  if (!SOURCE_ID_SEGMENT.test(channelSegment)) return null;
  return { kind: "scoped", workspaceSegment, channelSegment, rootTs };
}

/**
 * `<root-ts>.md` → the `ts` string, or `null`. The extension is exactly `.md` (case-sensitive), and
 * the `ts` must satisfy the SAME parser the message-evidence ledger uses — reused rather than
 * re-expressed so the two cannot drift on what a Slack instant is. Only its verdict is taken; the
 * returned identity is the original string, never a value derived from the parsed number.
 */
function parseRootFile(file: string): string | null {
  if (!file.endsWith(MD_SUFFIX)) return null;
  const rootTs = file.slice(0, -MD_SUFFIX.length);
  return parseSlackTimestamp(rootTs) ? rootTs : null;
}

/**
 * The canonical path for a NEW scoped item: `slack/<workspace>/<channel>/<root-ts>.md`.
 *
 * Ids are validated losslessly and canonicalized to lower case; the `ts` is kept byte-exact. Being
 * able to build this path is not permission to write it — publication still goes through the
 * migration gate, which is the only thing that knows whether this channel's legacy rows have been
 * resolved.
 */
export function scopedSlackItemPath(workspaceId: string, channelId: string, rootTs: string): string {
  const prefix = scopedSlackChannelPathPrefix(workspaceId, channelId);
  return `${prefix}${assertRootTs(rootTs)}${MD_SUFFIX}`;
}

/**
 * The path PREFIX every item of one scoped channel lives under. Always ends in `/`, so a prefix read
 * for `C1` cannot catch `C10`, and `T1`'s channel cannot catch `T2`'s.
 *
 * Same validated segment logic as the path builder, for the same reason `slackChannelPathPrefix`
 * exists: a hand-rolled `slack/${id.toLowerCase()}/` at a call site silently stops matching the day
 * this canonicalization changes, and a purge that matches nothing fails as a no-op, not as an error.
 */
export function scopedSlackChannelPathPrefix(workspaceId: string, channelId: string): string {
  const workspace = assertIdSegment("workspaceId", workspaceId);
  const channel = assertIdSegment("channelId", channelId);
  return `${SOURCE_SEGMENT}/${workspace}/${channel}/`;
}

/**
 * Reject-or-canonicalize, with NO replacement path. A `safeSegment`-style fallback here would accept
 * `old-channel-name` (a legacy slug) or `C 1` and mint a plausible, wrong identity; alphanumeric
 * syntax is the most this can check, and it is not evidence that the value IS a provider id.
 */
function assertIdSegment(field: string, value: string): string {
  if (typeof value !== "string" || !SOURCE_ID_SEGMENT.test(value)) {
    throw new TypeError(
      `slack namespace: ${field} must be a non-empty alphanumeric Slack id (got ${JSON.stringify(value)})`
    );
  }
  // ASCII-only by the test above, so this is a byte-for-byte lower-casing with no locale hazard.
  return value.toLowerCase();
}

function assertRootTs(rootTs: string): string {
  if (typeof rootTs !== "string" || !parseSlackTimestamp(rootTs)) {
    throw new TypeError(
      `slack namespace: rootTs must be an exact Slack timestamp (<seconds>.<microseconds>) ` +
        `(got ${JSON.stringify(rootTs)})`
    );
  }
  return rootTs;
}
