import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The measured failure: gitleaks reported FIVE `generic-api-key` findings in the activation
 * fingerprint fixtures — three in `fixtures/activation-remote-fingerprints.json` and two in
 * `staging-activation-preflight.test.ts`. All five were the same value, `compare-2026-09`: a
 * comparison KEY ID, which names which key minted a MAC and is designed to travel in the clear.
 * Nothing leaked. But `generic-api-key` matches any `key…: "<10+ chars from [0-9a-z-_.=]>"` whose
 * Shannon entropy is at least 3.5, and it cannot tell an identifier from a secret — so a publication
 * check failed on a synthetic fixture, which is a real cost even though the finding is a false one.
 *
 * The repair was to make the fixture value obviously synthetic and low-entropy rather than to
 * allowlist the rule, so the scanner keeps exactly the strength it had. This guard pins that, and
 * pins it against BOTH of the rule's own conditions — a future edit back to a realistic-looking
 * rotation id would otherwise reintroduce the failure silently, and only in CI.
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

describe("activation fingerprint fixtures carry no scanner-tripping key ids", () => {
  const fixture = readFileSync("test/fixtures/activation-remote-fingerprints.json", "utf8");
  const suite = readFileSync("test/staging-activation-preflight.test.ts", "utf8");

  it("measures the rule the way the rule measures — proven on the value that actually tripped it", () => {
    // The positive control. Without it every assertion below could pass because the measure is
    // broken rather than because the fixtures are clean.
    expect(shannonEntropy("compare-2026-09")).toBeGreaterThan(ENTROPY_THRESHOLD);
    expect(wouldTripGenericApiKey("compare-2026-09")).toBe(true);
    expect(wouldTripGenericApiKey("")).toBe(false);
  });

  it("finds the key ids it claims to be checking", () => {
    // A regex that matched nothing would report "every key id is clean" for free.
    const keyIds = [...fixture.matchAll(/"keyId":\s*"([^"]+)"/g)].map((match) => match[1]);
    expect(keyIds.length).toBe(3);
    expect(new Set(keyIds).size).toBe(1);
  });

  it("keeps every fixture and suite key id below what generic-api-key can flag", () => {
    const values = [
      ...[...fixture.matchAll(/"keyId":\s*"([^"]+)"/g)].map((match) => match[1]),
      ...[...suite.matchAll(/(?:keyId|KEY_ID|COMPARISON_KEY_ID)\s*[:=]\s*"([^"]+)"/g)].map((match) => match[1]),
    ];
    expect(values.length).toBeGreaterThanOrEqual(4);
    for (const value of values) {
      expect(wouldTripGenericApiKey(value), `${value} would be reported as a generic API key`).toBe(false);
    }
  });

  it("still compares a REAL identifier: local and remote must agree on the same key id", () => {
    // The clearing must not have turned the comparison into a tautology — the fixture and the
    // process environment the suite hands `readActivationFacts` still have to carry one shared,
    // non-empty key id, which is the whole basis of `fingerprintsComparable`.
    const [fixtureKeyId] = [...fixture.matchAll(/"keyId":\s*"([^"]+)"/g)].map((match) => match[1]);
    expect(fixtureKeyId).toBeTruthy();
    expect(suite).toContain(`const COMPARISON_KEY_ID = "${fixtureKeyId}"`);
    expect(suite).toContain("STAGING_COMPARISON_KEY_ID: COMPARISON_KEY_ID");
    // …and the mismatch case is still a genuine mismatch, not the same string twice.
    expect(suite).toContain('keyId: "some-other-key"');
    expect(fixtureKeyId).not.toBe("some-other-key");
  });
});
