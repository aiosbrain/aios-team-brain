import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCANNER, verifyScannerConfig } from "@/scripts/staging-ops/image-audit/scanner.mjs";

/**
 * AC-AUDIT-07 — the image audit's scanner config is PINNED by digest in reviewed source.
 *
 * `SCANNER.configSha256` is the trust anchor: the producer refuses a run whose config bytes differ, and
 * the original-evidence validator refuses a record reporting anything else. This guard is what keeps
 * the anchor and the tracked file together — an edit to the config that does not also edit the pinned
 * constant fails the build here, instead of failing every future audit at run time.
 */

const CONFIG = join(import.meta.dirname, "..", "..", SCANNER.configPath);

describe("image-audit scanner config digest", () => {
  it("the tracked config hashes to the pinned constant", () => {
    const measured = createHash("sha256").update(readFileSync(CONFIG)).digest("hex");
    expect(measured, `re-pin SCANNER.configSha256 in scripts/staging-ops/image-audit/scanner.mjs to ${measured} in the same reviewed change`)
      .toBe(SCANNER.configSha256);
  });

  it("the pinned constant is the reviewed value, not one derived at run time", () => {
    // The literal the accepted remediation spec records for the unchanged config bytes.
    expect(SCANNER.configSha256).toBe("1bd01cf22ede13355c811874836d46c76d30a30904f59677bfc19312745d73ec");
  });

  it("is non-vacuous: one changed byte is refused by the producer's own check", () => {
    const bytes = readFileSync(CONFIG);
    expect(verifyScannerConfig(bytes)).toBe(SCANNER.configSha256);
    const drifted = Buffer.concat([bytes, Buffer.from("\n")]);
    expect(() => verifyScannerConfig(drifted)).toThrow(expect.objectContaining({ code: "AUDIT_SCANNER_CONFIG_MISMATCH" }));
  });
});
