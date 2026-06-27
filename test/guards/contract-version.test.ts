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

describe("brain-api contract version", () => {
  it("BRAIN_API_VERSION has a major.minor shape", () => {
    expect(BRAIN_API_VERSION).toMatch(/^\d+\.\d+$/);
  });

  it("the architecture doc references the same version (`v<version>`)", () => {
    const doc = readFileSync(ARCH_DOC, "utf8");
    expect(
      doc.includes(`v${BRAIN_API_VERSION}`),
      `docs/ARCHITECTURE.md does not mention "v${BRAIN_API_VERSION}". ` +
        `Bump BRAIN_API_VERSION and the architecture doc together when the contract changes.`
    ).toBe(true);
  });

  it("the doc-agreement check is non-vacuous", () => {
    const doc = readFileSync(ARCH_DOC, "utf8");
    // A version that is not the implemented one must NOT be claimed as implemented.
    expect(doc.includes("v9.9")).toBe(false);
  });
});
