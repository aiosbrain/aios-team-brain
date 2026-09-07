import { describe, expect, it } from "vitest";
import { codebaseScanPayloadSchema } from "@/lib/api/schemas";
import { fullMetrics } from "./fixtures/codebase-scan";

/**
 * AUDITFIX-17 / AIO-1136 — AC17-01, the `metrics.recent_commits` count bound at the
 * POST /api/v1/codebases payload schema.
 *
 * Spec: docs/design/auditfix17-request-bounds.md. Canonical supplement:
 * aios-workspace/docs/contract/codebase-request-limits-v1.json (vendored at
 * test/fixtures/contract/codebase-request-limits-v1.json).
 *
 * WHY THIS TIER. The count bound is a property of the payload schema, and the route reports
 * only the FIRST schema issue, so the wire behaviour a caller sees is decided entirely by what
 * `codebaseScanPayloadSchema` produces here. The real-socket proof that a rejected scan writes
 * nothing lives in test/http/codebases-request-bounds.http.test.ts; this file is the pure
 * boundary and the exact operator-facing message.
 *
 * WHAT THIS IS RED FOR AT BASELINE (0006d51f): `lib/api/schemas.ts` accepts an arbitrary
 * `metrics.recent_commits` array, so 101 valid commits parse successfully today. That is the
 * admitted-work gap AUDITFIX-17 closes — a valid team-tier key can hand the ingest owner an
 * unbounded number of commits to project through `ingestItem`, one synchronous write each.
 */

// Verbatim from the canonical supplement. Written out rather than imported so a hand-edit to
// the vendored artifact cannot quietly re-point what "the exact message" means; the guard
// test/guards/codebase-request-limits-contract.test.ts is what ties the two together.
const COUNT_MESSAGE =
  "metrics.recent_commits: at most 100 entries per scan; send a complete scan with a smaller recent-commit window; do not split a snapshot across pushes";

const CODEBASE = { slug: "bounds-repo", full_name: "acme/bounds-repo", provider: "github" };

/** `n` distinct, schema-valid commit objects. */
function commits(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    sha: i.toString(16).padStart(40, "0"),
    author: "Jo <jo@example.com>",
    author_email: "jo@example.com",
    message: `commit ${i}`,
    committed_at: "2026-09-01T10:00:00Z",
    ai: false,
    additions: 3,
    deletions: 1,
  }));
}

function scan(recent_commits: unknown[]) {
  return { codebase: CODEBASE, metrics: fullMetrics({ recent_commits }) };
}

/** The first issue's message, which is exactly what the route puts on the wire. */
function firstIssue(payload: unknown): string | null {
  const parsed = codebaseScanPayloadSchema.safeParse(payload);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "");
}

describe("AC17-01 — metrics.recent_commits count bound", () => {
  // The array stays REQUIRED and empty stays legal: this is an admission ceiling, not a new
  // minimum. A scan of a repo with no commits in the window is an ordinary scan.
  it.each([0, 20, 100])("admits %i commits (0, the scanner's 20, and the ceiling)", (n) => {
    expect(firstIssue(scan(commits(n)))).toBeNull();
  });

  it("rejects 101 otherwise-valid commits with the exact named message", () => {
    expect(firstIssue(scan(commits(101)))).toBe(COUNT_MESSAGE);
  });

  // The count is taken BEFORE normalization/deduplication. `normalizeCommit` drops a commit
  // with no usable sha and re-pushing an identical sha dedups to a no-op, so if the bound were
  // applied to what survives, a caller could buy unlimited input budget with junk the brain
  // throws away — the work of validating and normalizing it has already been done by then.
  it("counts duplicate SHAs — deduplication downstream is not an input-budget escape", () => {
    const duplicated = Array.from({ length: 101 }, () => commits(1)[0]);
    expect(firstIssue(scan(duplicated))).toBe(COUNT_MESSAGE);
  });

  it("counts commits with no usable sha — skipping downstream is not an escape either", () => {
    const unusable = Array.from({ length: 101 }, () => ({ author: "Jo", message: "no sha" }));
    expect(firstIssue(scan(unusable))).toBe(COUNT_MESSAGE);
  });

  // Precedence, stated so the exact-message assertion above is not read as a promise the route
  // cannot keep: the response is first-issue-only. When an ELEMENT is also invalid, whichever
  // message wins, the outcome is still a schema rejection — which is what "returns 422 before
  // ingest" depends on. The spec explicitly declines a duplicate raw-array precheck just to
  // reorder these two.
  it("still rejects when an element ALSO violates the schema (message may differ)", () => {
    const withBadElement = commits(101);
    withBadElement[0] = {
      ...withBadElement[0],
      fix_analysis: {
        method: "first-parent-line-blame-v1",
        candidate_parent_lines: 1,
        blamed_parent_lines: 1,
        age_buckets: { "0_1d": 1, "2_7d": 0, "8_30d": 0, "31_90d": 0, "91_365d": 0, "366d_plus": 0 },
        prior_fix_parent_lines: 0,
      },
    };
    expect(codebaseScanPayloadSchema.safeParse(scan(withBadElement)).success).toBe(false);
  });

  // Non-vacuity for the message assertion: the ceiling must be what rejects 101, not some
  // unrelated property of the generated fixtures. 100 of the SAME objects must parse.
  it("is the count that rejects — 100 of the identical objects parse", () => {
    const hundred = Array.from({ length: 100 }, () => commits(1)[0]);
    expect(firstIssue(scan(hundred))).toBeNull();
  });
});
