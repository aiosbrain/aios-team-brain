import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { codebaseScanPayloadSchema } from "@/lib/api/schemas";

/**
 * Server-side conformance guard for the Brain API 1.15 codebase-scan payload
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
  "codebase-payload-1.15.schema.json":
    "239905d2245db871181759ef70c2de4e72ac51fec9f3cbdd4bb92476ae30e168",
  "codebase-payload-1.15-fixtures.json":
    "ea328673822f30439b94448f5a5aeb02746f6bbc682fefbc32bc5b0bc22ca4b8",
} as const;

const fixtures = JSON.parse(
  readFileSync(join(CONTRACT_DIR, "codebase-payload-1.15-fixtures.json"), "utf8"),
) as {
  readonly version: string;
  readonly valid: readonly { readonly name: string; readonly payload: unknown }[];
  readonly invalid: readonly { readonly name: string; readonly payload: unknown }[];
};

describe("brain-api 1.15 codebase-payload conformance", () => {
  it("vendored contract artifacts are byte-identical to the pinned canonical revision", () => {
    for (const [file, sha] of Object.entries(PINNED)) {
      const bytes = readFileSync(join(CONTRACT_DIR, file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(sha);
    }
  });

  it("fixtures file tracks the 1.15 contract revision, both buckets populated", () => {
    expect(fixtures.version).toBe("1.15");
    expect(fixtures.valid.length).toBeGreaterThanOrEqual(3);
    expect(fixtures.invalid.length).toBeGreaterThanOrEqual(3);
  });

  it("accepts every canonical valid fixture (incl. with-health and pre-1.15 without-health)", () => {
    for (const entry of fixtures.valid) {
      const res = codebaseScanPayloadSchema.safeParse(entry.payload);
      expect(res.success, `${entry.name}: ${res.success ? "" : res.error.issues[0]?.message}`).toBe(
        true,
      );
    }
  });

  it("rejects every canonical invalid fixture (sparse, malformed, smuggled keys, empty dimensions)", () => {
    for (const entry of fixtures.invalid) {
      expect(codebaseScanPayloadSchema.safeParse(entry.payload).success, entry.name).toBe(false);
    }
  });

  it("a valid parse preserves codebase_health VERBATIM (no coercion, no stripping)", () => {
    const withHealth = fixtures.valid.find((f) => f.name.startsWith("valid-with-health"));
    expect(withHealth).toBeDefined();
    const payload = withHealth!.payload as {
      metrics: { codebase_health: Record<string, unknown> };
    };
    const parsed = codebaseScanPayloadSchema.parse(payload);
    expect(parsed.metrics.codebase_health).toEqual(payload.metrics.codebase_health);
  });

  it("omitted codebase_health stays omitted (distinguishable from a scored object)", () => {
    const withoutHealth = fixtures.valid.find((f) => f.name.startsWith("valid-without-health"));
    expect(withoutHealth).toBeDefined();
    const parsed = codebaseScanPayloadSchema.parse(withoutHealth!.payload);
    expect(parsed.metrics.codebase_health).toBeUndefined();
  });
});
