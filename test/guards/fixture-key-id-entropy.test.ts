import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { writeSyntheticRemoteFingerprints } from "../helpers/activation-remote-fingerprints";
import { fingerprintsComparable } from "../../scripts/staging-ops/credential-fingerprint.mjs";

/**
 * TWO measured CI failures, one rule, one guard.
 *
 * 1. gitleaks reported five `generic-api-key` findings on `compare-2026-09` — a comparison KEY ID,
 *    which names which key minted a MAC and is designed to travel in the clear. The rule matches
 *    any `key…: "<10+ chars from [0-9a-z-_.=]>"` at ≥3.5 bits of Shannon entropy and cannot tell an
 *    identifier from a secret. Repaired by making the id obviously synthetic and low-entropy.
 *
 * 2. It then reported three more, all on the `keyConfirmation` values in
 *    `test/fixtures/activation-remote-fingerprints.json`. A confirmation is a 32-byte HMAC in
 *    base64url: 43 characters at maximal entropy, so it trips the rule by construction and always
 *    would have. Every value was reproducible from the public synthetic key `Buffer.alloc(32, 7)`
 *    plus the fixture's own key id — the confirmation is derived from the COMPARISON KEY and a
 *    public domain string and incorporates no credential input — so it was a required-check blocker
 *    and a false security positive, not an exposure, and no rotation was warranted. Repaired by
 *    generating the document at test runtime instead of tracking it.
 *
 * Neither repair allowlisted a rule, changed the scanner's configuration, or weakened a comparison
 * assertion. This guard therefore has to cover BOTH shapes in what remains TRACKED — the previous
 * version keyed on `"keyId"` in a JSON file that no longer exists, and a guard keyed on a deleted
 * artifact reports "clean" for free.
 */

/** gitleaks' entropy measure: Shannon bits per character over the captured value. */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

/** The rule's own thresholds, from gitleaks 8.18's `generic-api-key`. */
const ENTROPY_THRESHOLD = 3.5;
const MINIMUM_CAPTURE_LENGTH = 10;

const wouldTripGenericApiKey = (value: string) =>
  value.length >= MINIMUM_CAPTURE_LENGTH && shannonEntropy(value) >= ENTROPY_THRESHOLD;

/**
 * Every tracked file that may still carry a `key…` literal the scanner reads. The fixture is gone;
 * these are its replacements plus the two consumers, so a regression has nowhere silent to land.
 */
const TRACKED_INPUTS = [
  "test/helpers/activation-remote-fingerprints.ts",
  "test/staging-activation-preflight.test.ts",
  "test/staging-activation-health-binding.test.ts",
] as const;

/**
 * The rule's own capture shape, applied to key-PREFIXED assignments in either source syntax:
 * `keyId: "…"`, `"keyConfirmation": "…"`, `KEY_ID = "…"`. Deliberately broader than the old
 * `"keyId"`-only pattern, which could not have seen the confirmations that actually failed CI.
 *
 * CASE-INSENSITIVE, and that is not cosmetic. `[Kk]ey` cannot match `KEY`, so the SCREAMING_SNAKE
 * constants — `COMPARISON_KEY_ID`, `SECRETS_KEY` — were invisible to this guard even though the
 * comment above claimed `KEY_ID = "…"` was covered, and even though finding (1) above was itself a
 * comparison KEY ID. gitleaks' keyword match is case-insensitive; this now measures the same set.
 */
const KEY_LITERAL = /\b["']?([A-Za-z_]*key[A-Za-z_]*)["']?\s*[:=]\s*["']([^"'\n]+)["']/gi;

describe("no tracked activation fingerprint input carries a scanner-tripping key literal", () => {
  const sources = TRACKED_INPUTS.map((file) => [file, readFileSync(file, "utf8")] as const);

  it("measures the rule the way the rule measures — proven on both values that tripped it", () => {
    // POSITIVE CONTROLS. Without them every assertion below could pass because the measure is
    // broken rather than because the sources are clean.
    expect(wouldTripGenericApiKey("compare-2026-09")).toBe(true);
    // The second shape, DERIVED rather than written down: a real `keyConfirmation` is what failed
    // the scan on 2026-09-08, and pasting one back into a tracked file to prove it trips the rule
    // would reintroduce the exact finding this guard exists to keep out.
    const sample = writeSyntheticRemoteFingerprints();
    try {
      expect(wouldTripGenericApiKey(String((sample.document["auth-secret"] as { keyConfirmation: string }).keyConfirmation))).toBe(true);
    } finally { sample.cleanup(); }
    expect(wouldTripGenericApiKey("example-key")).toBe(false);
    expect(wouldTripGenericApiKey("")).toBe(false);
  });

  /** Every `name = value` pair the guard's pattern sees, per file. */
  const literals = () => sources.flatMap(([file, source]) =>
    [...source.matchAll(KEY_LITERAL)].map(([, name, value]) => ({ file, name, value })));

  it("finds a key literal in EVERY tracked input, so no file is certified for free", () => {
    // ∀, not a count. A total ("at least four somewhere") is satisfied by whichever file happens to
    // be richest, so a tracked input that stopped carrying key literals — or that the pattern
    // stopped reaching — would be scanned vacuously by the assertions below while the total stayed
    // green. There is no threshold to fit here: the claim is that each named file is covered.
    const found = literals();
    for (const file of TRACKED_INPUTS) {
      expect(found.filter((entry) => entry.file === file).map((entry) => entry.name),
        `${file} yields no key literal, so this guard says nothing about it`).not.toHaveLength(0);
    }
  });

  it("reaches BOTH assignment syntaxes, including the SCREAMING_SNAKE constants", () => {
    // The two shapes are the guard's own coverage claim, and each is a NEGATIVE CONTROL for a
    // specific way the pattern can silently narrow:
    //   - drop the `i` flag and the uppercase row disappears (it did, until this change);
    //   - restrict the pattern back to `"keyId"` and the `=` row disappears.
    const found = literals();
    const colonAssigned = found.filter((entry) => /^key/.test(entry.name));
    const upperCaseConstant = found.filter((entry) => entry.name === entry.name.toUpperCase());
    expect(colonAssigned.map((entry) => entry.value), "no `keyId: \"…\"` literal was reached").toContain("some-other-key");
    expect(upperCaseConstant.map((entry) => entry.value), "no `KEY… = \"…\"` constant was reached").toContain("example-key");

    // The specific literals this guard exists to keep low-entropy, named rather than counted.
    const values = found.map((entry) => entry.value);
    for (const expected of ["example-key", "some-other-key", "local-secrets-key"]) {
      expect(values, `${expected} is no longer visible to the guard`).toContain(expected);
    }
  });

  it("keeps every tracked key literal below what generic-api-key can flag", () => {
    for (const [file, source] of sources) {
      for (const [, name, value] of source.matchAll(KEY_LITERAL)) {
        expect(wouldTripGenericApiKey(value), `${file}: ${name} would be reported as a generic API key`).toBe(false);
      }
    }
  });

  it("still generates a REAL comparable document, so nothing was cleared by weakening the comparison", () => {
    // The repair must not have turned the opposite-environment document into something that
    // trivially compares. Two independently generated documents under the same synthetic key must
    // confirm the same key material — which is exactly what the preflight suites depend on, and
    // what writing a repeated-byte placeholder into the old JSON would have destroyed.
    const a = writeSyntheticRemoteFingerprints();
    const b = writeSyntheticRemoteFingerprints();
    try {
      expect(fingerprintsComparable(a.document["auth-secret"], b.document["auth-secret"])).toBe(true);
      // …and a DIFFERENT comparison key is still refused as incomparable.
      const other = writeSyntheticRemoteFingerprints({ comparisonKey: Buffer.alloc(32, 9) });
      try {
        expect(fingerprintsComparable(a.document["auth-secret"], other.document["auth-secret"])).toBe(false);
      } finally { other.cleanup(); }
      // The generated values themselves are high entropy, which is precisely why they may not be
      // tracked — this asserts the file it writes is the thing that would have failed the scan.
      const written = readFileSync(a.file, "utf8");
      const confirmations = [...written.matchAll(/"keyConfirmation":\s*"([^"]+)"/g)].map((m) => m[1]);
      expect(confirmations.length).toBe(3);
      for (const confirmation of confirmations) expect(wouldTripGenericApiKey(confirmation)).toBe(true);
    } finally { a.cleanup(); b.cleanup(); }
  });

  it("keeps local and remote agreeing on one real key id", () => {
    const suite = readFileSync("test/staging-activation-preflight.test.ts", "utf8");
    expect(suite).toContain('const COMPARISON_KEY_ID = "example-key"');
    expect(suite).toContain("STAGING_COMPARISON_KEY_ID: COMPARISON_KEY_ID");
    // …and the mismatch case is still a genuine mismatch, not the same string twice.
    expect(suite).toContain('keyId: "some-other-key"');
  });
});
