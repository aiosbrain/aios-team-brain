import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { scannerStaleness } from "@/lib/codebases/scanner-version";
import { codebaseScanPayloadSchema } from "@/lib/api/schemas";

/**
 * Server-side conformance guard for the Brain API 1.24 codebase-scan payload
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
  "codebase-payload-1.24.schema.json":
    "761f8e74be2f98d2883d9d61697f7d0c95c28df7770ba7e467d35dd6492feca6",
  "codebase-payload-1.24-fixtures.json":
    "ae7fc3840bcf7e7d1ec10086d8dee858347c0d7f792d27f28d97ae5a238a792b",
  "codebase-health-v2.schema.json":
    "38de45de129c9ff3a346fb96346f905d79532b053e824a4ac85bb26a88b4371d",
} as const;

const fixtures = JSON.parse(
  readFileSync(
    join(CONTRACT_DIR, "codebase-payload-1.24-fixtures.json"),
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
  // brain-api 1.24 (AIO-1011). Consumer-READING vectors: JSON Schema pins the wire shape of
  // `scanner_version`, but it cannot express what a reader must CONCLUDE from it. `scanner_version`
  // is OPTIONAL on the vector on purpose — an absent key models a pre-1.24 payload that never
  // carried the field, which is a different input from an explicit `null`, and both must read
  // "unknown".
  readonly scanner_state: {
    readonly _note: string;
    readonly vectors: readonly {
      readonly name: string;
      readonly scanner_version?: string | null;
      readonly state: "unknown" | "stale" | "current";
    }[];
  };
};

describe("brain-api 1.24 codebase-payload conformance", () => {
  it("vendored contract artifacts are byte-identical to the pinned canonical revision", () => {
    for (const [file, sha] of Object.entries(PINNED)) {
      const bytes = readFileSync(join(CONTRACT_DIR, file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(sha);
    }
  });

  // The hashes above are also DECLARED by the contract itself, inside its own hashed content set
  // (brain-contract.json → codebasePayloadContract, hashed since 1.24). Checking against that
  // declaration as well means a re-vendor that updates the files and the local PINNED table but
  // forgets brain-contract.json cannot pass: the canonical statement and the bytes must agree.
  // brain-api 1.24 (AIO-1011). The upstream `scanner_state` vectors are the EXECUTABLE form of
  // the three-state truth table. Driving the reading off them — rather than off a table retyped
  // in this repo — is what makes the two repos agree by construction instead of by two people
  // reading the same paragraph. The contract deliberately omits parser-grammar edge cases
  // ("0.2", "v0.2.0-dirty"): the grammar is the READER's, and anything it cannot read normalizes
  // to unknown by the rule below, so pinning them upstream would make the contract stricter than
  // the brain — the 1.22 drift, pointed the other way.
  describe("scanner-identity reading conforms to the canonical vectors", () => {
    const vectors = fixtures.scanner_state.vectors;

    it("the vector set is populated and covers all three states (non-vacuous)", () => {
      expect(vectors.length).toBeGreaterThanOrEqual(10);
      expect(new Set(vectors.map((v) => v.state))).toEqual(
        new Set(["unknown", "stale", "current"]),
      );
    });

    it.each(vectors.map((v) => [v.name, v] as const))(
      "%s",
      (_name, v) => {
        // An ABSENT key and an explicit null are different inputs that must reach the same
        // verdict, so the absent case is passed as `undefined` rather than coerced to null.
        const declared = "scanner_version" in v ? v.scanner_version : undefined;
        expect(scannerStaleness(declared)).toBe(v.state);
      },
    );

    it("UNPARSEABLE resolves to unknown and is NEVER ordered against the minimum", () => {
      // The load-bearing rule, asserted directly rather than inferred from the loop above:
      // every vector the contract calls unreadable must land in `unknown`, and none of them may
      // fall through to `stale` — "the scan did not tell us" is a different statement from
      // "the scan told us it is old", and collapsing them is the defect 1.24 exists to remove.
      const unreadable = vectors.filter(
        (v) =>
          v.state === "unknown" &&
          "scanner_version" in v &&
          typeof v.scanner_version === "string",
      );
      expect(unreadable.length).toBeGreaterThan(0);
      for (const v of unreadable) {
        expect(scannerStaleness(v.scanner_version), v.name).toBe("unknown");
        expect(scannerStaleness(v.scanner_version), v.name).not.toBe("stale");
      }
    });

    it("absence and explicit null agree, and neither is ever 'current'", () => {
      expect(scannerStaleness(undefined)).toBe("unknown");
      expect(scannerStaleness(null)).toBe("unknown");
      expect(scannerStaleness(undefined)).not.toBe("current");
    });
  });

  it("the vendored payload artifacts match the hashes the CONTRACT declares for them", () => {
    const brainContract = JSON.parse(
      readFileSync(join(CONTRACT_DIR, "brain-contract.json"), "utf8"),
    ) as {
      readonly codebasePayloadContract: {
        readonly version: string;
        readonly minScannerVersion: string;
        readonly schema: { readonly path: string; readonly sha256: string };
        readonly fixtures: { readonly path: string; readonly sha256: string };
      };
    };
    const block = brainContract.codebasePayloadContract;
    expect(block.version).toBe("1.24");
    for (const ref of [block.schema, block.fixtures]) {
      const bytes = readFileSync(join(CONTRACT_DIR, ref.path));
      expect(createHash("sha256").update(bytes).digest("hex"), ref.path).toBe(
        ref.sha256,
      );
    }
  });

  it("fixtures file tracks the 1.24 contract revision, both buckets populated", () => {
    expect(fixtures.version).toBe("1.24");
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
