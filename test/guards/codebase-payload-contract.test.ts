import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { codebaseScanPayloadSchema } from "@/lib/api/schemas";

/**
 * Server-side conformance guard for the Brain API 1.23 codebase-scan payload
 * (POST /api/v1/codebases, incl. the optional provenance-only `metrics.codebase_health`
 * object — AIO-609). Mirror of aios-workspace/test/codebase-payload-contract.test.mjs,
 * run against vendored copies of the shared contract artifacts
 * (canonical home: aios-workspace/docs/contract/).
 *
 * Asserts that this repo's zod boundary (`codebaseScanPayloadSchema`) agrees with the
 * canonical fixtures in BOTH buckets — every `valid` fixture is accepted and every
 * `invalid` fixture is rejected — so the two sides of the seam cannot silently diverge on:
 *   - additive: a pre-1.15 payload without `codebase_health` stays valid;
 *   - never sparse: `codebase_health` cannot ride on a partial metrics block (the
 *     code_metrics upsert REPLACES the (codebase_id, head_sha) row);
 *   - provenance-only + scalars-only: the health object is closed — unknown keys
 *     (e.g. file paths) are rejected, not stripped-and-persisted.
 *
 * The sha256 pins below guard the vendored copies against out-of-band edits (the same
 * posture as brain-contract.json's contentHash); refreshing the vendored artifacts from
 * the canonical home means updating the pins in the same change.
 */

const CONTRACT_DIR = join(import.meta.dirname, "..", "fixtures", "contract");

const PINNED = {
  "codebase-payload-1.23.schema.json":
    "0bcb686042369d31bfc7299c2ce5ea6b0257cc6a17995959ba02bf6d14d10c55",
  "codebase-payload-1.23-fixtures.json":
    "3d495a7892a7ac6c53334b3fa7f323fa89523ffae663bcc0086bf6f5d0abb4d6",
  "codebase-health-v2.schema.json":
    "38de45de129c9ff3a346fb96346f905d79532b053e824a4ac85bb26a88b4371d",
} as const;

const fixtures = JSON.parse(
  readFileSync(
    join(CONTRACT_DIR, "codebase-payload-1.23-fixtures.json"),
    "utf8",
  ),
) as {
  readonly version: string;
  readonly valid: readonly {
    readonly name: string;
    readonly payload: unknown;
  }[];
  readonly invalid: readonly {
    readonly name: string;
    readonly payload: unknown;
  }[];
  readonly brain_invalid: readonly {
    readonly name: string;
    readonly payload: unknown;
  }[];
};

describe("brain-api 1.23 codebase-payload conformance", () => {
  it("vendored contract artifacts are byte-identical to the pinned canonical revision", () => {
    for (const [file, sha] of Object.entries(PINNED)) {
      const bytes = readFileSync(join(CONTRACT_DIR, file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(sha);
    }
  });

  it("fixtures file tracks the 1.23 contract revision, both buckets populated", () => {
    expect(fixtures.version).toBe("1.23");
    expect(fixtures.valid.length).toBeGreaterThanOrEqual(3);
    expect(fixtures.invalid.length).toBeGreaterThanOrEqual(3);
  });

  it("accepts every canonical valid fixture (incl. with-health and pre-1.15 without-health)", () => {
    for (const entry of fixtures.valid) {
      const res = codebaseScanPayloadSchema.safeParse(entry.payload);
      expect(
        res.success,
        `${entry.name}: ${res.success ? "" : res.error.issues[0]?.message}`,
      ).toBe(true);
    }
  });

  it("rejects every canonical invalid fixture (sparse, malformed, smuggled keys, empty dimensions)", () => {
    for (const entry of fixtures.invalid) {
      expect(
        codebaseScanPayloadSchema.safeParse(entry.payload).success,
        entry.name,
      ).toBe(false);
    }
  });

  it("rejects every brain-enforced fix-analysis invariant fixture", () => {
    expect(fixtures.brain_invalid).toHaveLength(3);
    for (const entry of fixtures.brain_invalid) {
      expect(
        codebaseScanPayloadSchema.safeParse(entry.payload).success,
        entry.name,
      ).toBe(false);
    }
  });

  it("a valid parse preserves codebase_health VERBATIM (no coercion, no stripping)", () => {
    const withHealth = fixtures.valid.find((f) =>
      f.name.startsWith("valid-with-health"),
    );
    expect(withHealth).toBeDefined();
    const payload = withHealth!.payload as {
      metrics: { codebase_health: Record<string, unknown> };
    };
    const parsed = codebaseScanPayloadSchema.parse(payload);
    expect(parsed.metrics.codebase_health).toEqual(
      payload.metrics.codebase_health,
    );
  });

  it("omitted codebase_health stays omitted (distinguishable from a scored object)", () => {
    const withoutHealth = fixtures.valid.find((f) =>
      f.name.startsWith("valid-without-health"),
    );
    expect(withoutHealth).toBeDefined();
    const parsed = codebaseScanPayloadSchema.parse(withoutHealth!.payload);
    expect(parsed.metrics.codebase_health).toBeUndefined();
  });

  it("accepts v2 epistemic state and rejects contradictory or incomplete claims", () => {
    const withoutHealth = fixtures.valid.find((f) =>
      f.name.startsWith("valid-without-health"),
    );
    expect(withoutHealth).toBeDefined();
    const payload = structuredClone(withoutHealth!.payload) as {
      metrics: { codebase_health?: Record<string, unknown> };
    };
    payload.metrics.codebase_health = {
      schema_version: "2",
      rubric_version: "1.1.0",
      profile_id: "aios.team-brain",
      profile_version: "1.0.0",
      head_sha: "abc123def456abc123def456abc123def456abc1",
      score_pct: 80,
      status: "pass",
      evidence_status: "partial",
      quality_gate: "unknown",
      automation_eligible: false,
      dimensions: {
        test_rigor: {
          passed: 0,
          total: 0,
          band: null,
          evidence_status: "missing",
        },
      },
      failed_invariant_ids: [],
      measured_at: "2026-08-04T00:00:00Z",
      findings: [
        {
          fingerprint: "a".repeat(64),
          check_id: "coverage_lines_pct",
          axis: "test_rigor",
          kind: "evidence_gap",
          severity: "high",
          evidence_status: "missing",
          remediation_tier: 0,
        },
      ],
    };
    expect(codebaseScanPayloadSchema.safeParse(payload).success).toBe(true);

    const contradictory = structuredClone(payload);
    contradictory.metrics.codebase_health!.automation_eligible = true;
    expect(codebaseScanPayloadSchema.safeParse(contradictory).success).toBe(
      false,
    );

    const malformed = structuredClone(payload);
    delete (
      malformed.metrics.codebase_health!.findings as Record<string, unknown>[]
    )[0].fingerprint;
    expect(codebaseScanPayloadSchema.safeParse(malformed).success).toBe(false);
  });
});
