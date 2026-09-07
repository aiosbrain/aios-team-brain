import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BRAIN_API_VERSION } from "@/lib/api/version";
import { codebaseScanPayloadSchema } from "@/lib/api/schemas";
import { fullMetrics } from "../fixtures/codebase-scan";

/**
 * AUDITFIX-17 / AIO-1136 — AC17-08. Server-side conformance guard for the codebase
 * request-admission supplement (canonical home:
 * aios-workspace/docs/contract/codebase-request-limits-v1.json, vendored here).
 *
 * Sibling of test/guards/codebase-payload-contract.test.ts, which pins the payload SHAPE
 * contract. This one pins the ADMISSION contract, and the two are deliberately separate
 * artifacts: the supplement is versioned on its own `revision` and does NOT bump the member
 * API, so a shape revision and an admission revision can move independently.
 *
 * The load-bearing assertion is the last block: the supplement's published boundary cases are
 * run through the ACTUAL `codebaseScanPayloadSchema`, using the literal counts the file
 * publishes. Comparing an exported constant to itself would pass no matter what the schema
 * does; comparing published behaviour to real behaviour is what makes the shared artifact
 * mean something to a client that reads it.
 *
 * RED AT BASELINE (0006d51f) for the count cases: the schema accepts an unbounded
 * `metrics.recent_commits`, so the supplement's `count: 101, admitted: false` case is a
 * statement the server does not yet honour. The byte half of the supplement
 * (`boundaryCases.body`) is a TRANSPORT bound and cannot be observed through the schema at
 * all — it is proven over a real socket in test/http/codebases-request-bounds.http.test.ts,
 * and this guard only checks its published shape.
 */

const CONTRACT_DIR = join(import.meta.dirname, "..", "fixtures", "contract");
const SUPPLEMENT_FILE = "codebase-request-limits-v1.json";

const raw = readFileSync(join(CONTRACT_DIR, SUPPLEMENT_FILE), "utf8");
const supplement = JSON.parse(raw) as {
  readonly kind: string;
  readonly revision: number;
  readonly method: string;
  readonly path: string;
  readonly maxBodyBytes: number;
  readonly maxRecentCommits: number;
  readonly bodyMeasurement: string;
  readonly memberApiMajor: number;
  readonly appliesFromMemberApiVersion: string;
  readonly errors: Record<string, { status: number; code: string; message: string }>;
  readonly boundaryCases: {
    readonly recentCommits: readonly { count: number; admitted: boolean }[];
    readonly body: readonly { bytes: number; admitted: boolean }[];
  };
};

/**
 * sha256 of the canonical revision-1 bytes, in the same posture as the `PINNED` map in the
 * sibling `codebase-payload-contract.test.ts` and `brain-contract.json`'s contentHash: the
 * vendored copy is guarded against out-of-band edits, and refreshing it from the canonical home
 * means updating this digest in the same change.
 *
 * A digest says only THAT something drifted, so it is deliberately not the only pin here — the
 * literal-value and literal-behaviour cases below say WHAT the artifact has to mean.
 */
const PINNED_SHA256 = "85fac3ea83a706bc5b51c80d233f7d2259e60549045f0aed861e46c6933666fb";

/**
 * The two ceilings and the count message, spelled out INDEPENDENTLY of the file under guard.
 * Reading them from the supplement and then asserting the supplement matches would pass for any
 * pair of numbers; a third-party client codes against these literals, so the guard states them.
 */
const LITERAL_MAX_RECENT_COMMITS = 100;
const LITERAL_OVER_RECENT_COMMITS = 101;
const LITERAL_MAX_BODY_BYTES = 2_400_000;
const LITERAL_COUNT_MESSAGE =
  "metrics.recent_commits: at most 100 entries per scan; send a complete scan with a smaller recent-commit window; do not split a snapshot across pushes";

const CODEBASE = { slug: "contract-repo", full_name: "acme/contract-repo", provider: "github" };

function scanWithCommits(n: number) {
  const recent_commits = Array.from({ length: n }, (_, i) => ({
    sha: i.toString(16).padStart(40, "0"),
    author: "Jo <jo@example.com>",
    author_email: "jo@example.com",
    message: `commit ${i}`,
    committed_at: "2026-09-01T10:00:00Z",
    ai: false,
  }));
  return { codebase: CODEBASE, metrics: fullMetrics({ recent_commits }) };
}

describe("codebase request-admission supplement (revision 1)", () => {
  it("the vendored copy is byte-identical to the pinned canonical revision", () => {
    const bytes = readFileSync(join(CONTRACT_DIR, SUPPLEMENT_FILE));
    expect(createHash("sha256").update(bytes).digest("hex"), SUPPLEMENT_FILE).toBe(PINNED_SHA256);
  });

  it("publishes the literal ceilings this server enforces", () => {
    // Independent of the digest: a byte pin cannot tell 100 from 1000, only that the file moved.
    expect(supplement.kind).toBe("aios-codebase-request-limits");
    expect(supplement.revision).toBe(1);
    expect(supplement.maxRecentCommits).toBe(LITERAL_MAX_RECENT_COMMITS);
    expect(supplement.maxBodyBytes).toBe(LITERAL_MAX_BODY_BYTES);
    expect(supplement.errors.recentCommits.message).toBe(LITERAL_COUNT_MESSAGE);
  });

  it("adopting the supplement does not bump the member API version", () => {
    // The supplement carries its own `revision` and applies from 1.23 onward. Bumping
    // BRAIN_API_VERSION to 1.25 would claim the canonical 1.24 scanner-identity semantics
    // this server does not implement; leaving it at 1.23 is the honest declaration.
    expect(BRAIN_API_VERSION).toBe("1.23");
    // "applies from 1.23 ONWARD" — so the running server must be at or above that, not equal
    // to it. Pinning equality here would turn a legitimate future minor bump into a red guard.
    const [supMajor, supMinor] = supplement.appliesFromMemberApiVersion.split(".").map(Number);
    const [srvMajor, srvMinor] = BRAIN_API_VERSION.split(".").map(Number);
    expect(supplement.memberApiMajor).toBe(supMajor);
    expect(srvMajor).toBe(supMajor);
    expect(srvMinor).toBeGreaterThanOrEqual(supMinor);
  });

  it("names the endpoint it bounds", () => {
    expect(supplement.method).toBe("POST");
    expect(supplement.path).toBe("/api/v1/codebases");
  });

  // ——— the part that can actually be wrong ———

  it("every published recent_commits boundary case matches the real schema's verdict", () => {
    for (const boundaryCase of supplement.boundaryCases.recentCommits) {
      const parsed = codebaseScanPayloadSchema.safeParse(scanWithCommits(boundaryCase.count));
      expect(
        parsed.success,
        `supplement publishes count ${boundaryCase.count} as ` +
          `${boundaryCase.admitted ? "admitted" : "rejected"}; the schema ` +
          `${parsed.success ? "accepted" : "rejected"} it`
      ).toBe(boundaryCase.admitted);
    }
  });

  it("the LITERAL 100/101 boundary behaves as published, whatever the file says", () => {
    // The case above is driven by the artifact, so an artifact that published the wrong pair
    // could still agree with a wrong schema. This one hard-codes the boundary: 100 in, 101 out,
    // with the exact operator-facing message. Both halves are required — asserting only the
    // rejection would pass against a schema that rejected everything.
    expect(
      codebaseScanPayloadSchema.safeParse(scanWithCommits(LITERAL_MAX_RECENT_COMMITS)).success,
    ).toBe(true);
    const over = codebaseScanPayloadSchema.safeParse(
      scanWithCommits(LITERAL_OVER_RECENT_COMMITS),
    );
    expect(over.success).toBe(false);
    if (over.success) return;
    expect(over.error.issues[0]?.message).toBe(LITERAL_COUNT_MESSAGE);
  });

  it("the published 422 message is what a caller actually receives", () => {
    // The route answers with `parsed.error.issues[0].message`, so the supplement's promise is
    // only kept if the count violation is BOTH the rejection reason and the first issue.
    const over = supplement.boundaryCases.recentCommits.find((c) => !c.admitted);
    expect(over, "the supplement publishes no rejected count case").toBeDefined();
    const parsed = codebaseScanPayloadSchema.safeParse(scanWithCommits(over!.count));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toBe(supplement.errors.recentCommits.message);
    expect(supplement.errors.recentCommits.status).toBe(422);
    expect(supplement.errors.recentCommits.code).toBe("invalid_payload");
  });

  it("historical valid payload fixtures are still accepted (the narrowing is bounded)", () => {
    // AC17-08: an admission limit must not retroactively invalidate the published payload
    // shape. Every canonical 1.23 valid fixture must survive this change untouched.
    const fixtures = JSON.parse(
      readFileSync(join(CONTRACT_DIR, "codebase-payload-1.23-fixtures.json"), "utf8")
    ) as { valid: readonly { name: string; payload: unknown }[] };
    expect(fixtures.valid.length).toBeGreaterThanOrEqual(3);
    for (const entry of fixtures.valid) {
      const res = codebaseScanPayloadSchema.safeParse(entry.payload);
      expect(res.success, `${entry.name}: ${res.success ? "" : res.error.issues[0]?.message}`).toBe(
        true
      );
    }
  });

  it("the byte bound is published as a transport bound, proven in the HTTP tier", () => {
    // Not testable here by construction: the schema never sees the wire. This asserts only
    // that the published contract says the right thing about HOW the bytes are measured —
    // Content-Length is an optimization, never the measurement — so the HTTP tier's
    // chunked-body case is testing the documented rule and not an invented one.
    expect(supplement.maxBodyBytes).toBe(2_400_000);
    expect(supplement.errors.body.status).toBe(413);
    expect(supplement.errors.body.code).toBe("payload_too_large");
    expect(supplement.bodyMeasurement).toContain("Content-Length is not authoritative");
    expect(supplement.boundaryCases.body.map((c) => c.bytes)).toEqual([2_400_000, 2_400_001]);
    expect(supplement.boundaryCases.body.map((c) => c.admitted)).toEqual([true, false]);
  });
});
