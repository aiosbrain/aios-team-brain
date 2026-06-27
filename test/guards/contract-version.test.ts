import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAIN_API_VERSION } from "@/lib/api/version";

/**
 * Contract-version pin. The brain-api wire contract (source of truth:
 * `aios-workspace/docs/brain-api.md`) is implemented here; `BRAIN_API_VERSION` is the single
 * server-side declaration of which version is targeted. The workspace doc lives in a sibling
 * repo we can't read from here, so the in-repo anchor is `docs/ARCHITECTURE.md`, which states
 * the contract version in prose. This guard fails the build if the constant and the doc drift
 * apart — forcing a contract bump to touch both in the same PR.
 */

const ARCH_DOC = join(import.meta.dirname, "..", "..", "docs", "ARCHITECTURE.md");

// The architecture doc carries one canonical claim of the implemented version:
//   "...implements brain-api v1.2..."
// We assert that exact, version-anchored sentence (not just any `v1.2` substring, which the
// doc mentions in many feature contexts). `\b` keeps v1.2 from matching v1.20.
function implementsClaim(version: string): RegExp {
  return new RegExp(String.raw`implements\s+\*{0,2}brain-api\s+v${version.replace(".", "\\.")}\b`, "i");
}

describe("brain-api contract version", () => {
  it("BRAIN_API_VERSION has a major.minor shape", () => {
    expect(BRAIN_API_VERSION).toMatch(/^\d+\.\d+$/);
  });

  it("the architecture doc's canonical claim matches the implemented version", () => {
    const doc = readFileSync(ARCH_DOC, "utf8");
    expect(
      implementsClaim(BRAIN_API_VERSION).test(doc),
      `docs/ARCHITECTURE.md must state "implements brain-api v${BRAIN_API_VERSION}". ` +
        `Bump BRAIN_API_VERSION and that sentence together when the contract changes.`
    ).toBe(true);
  });

  it("the claim is version-specific (non-vacuous)", () => {
    const doc = readFileSync(ARCH_DOC, "utf8");
    // The same anchored claim for a *different* version must NOT be present — proving the
    // matcher is pinned to the actual version, not matching any text.
    expect(implementsClaim("9.9").test(doc)).toBe(false);
  });
});
