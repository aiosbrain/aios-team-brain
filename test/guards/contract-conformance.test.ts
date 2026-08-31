import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { normalizeTier, PROVISIONING_TOOLS } from "@/lib/api/schemas";
import { itemPayloadSchema } from "@/lib/api/schemas";
import { formatSseFrame } from "@/lib/api/sse";
import { BRAIN_API_VERSION } from "@/lib/api/version";
import {
  MIN_SCANNER_VERSION,
  parseScannerVersion,
  scannerStaleness,
} from "@/lib/codebases/scanner-version";
import { ALL_TOOLS } from "@/lib/provisioning/run";

/**
 * Server-side conformance guard for the workspace<->brain seam (AIO-314). The mirror of
 * aios-workspace/test/contract-conformance.test.mjs, run against a vendored copy of the shared
 * fixture (test/fixtures/contract/brain-contract.json, canonical home: aios-workspace/docs/contract).
 *
 * Asserts this repo's `normalizeTier` matches the shared tier rows + the SERVER column of the
 * deliberately-divergent rows (admin/private/unknown → null), that `formatSseFrame` reproduces every
 * contract SSE frame byte-for-byte, and that the fixture's version tracks BRAIN_API_VERSION and its
 * contentHash is intact. Cross-repo drift (this copy vs the canonical) is caught by the root
 * /docs-sync contentHash compare.
 */

const FIXTURE = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "contract",
  "brain-contract.json",
);
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
const itemFixtures = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "fixtures",
      "contract",
      "item-payload-1.12-fixtures.json",
    ),
    "utf8",
  ),
) as {
  readonly valid: readonly {
    readonly name: string;
    readonly payload: unknown;
  }[];
  readonly invalid: readonly {
    readonly name: string;
    readonly payload: unknown;
  }[];
};

// Same canonicalization the workspace test + generator use (recursive key sort → stable JSON).
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const canonical = (v: Json): Json =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.keys(v)
          .sort()
          .reduce<Record<string, Json>>(
            (o, k) => ((o[k] = canonical(v[k])), o),
            {},
          )
      : v;

describe("brain-api tier + SSE conformance", () => {
  it("fixture contentHash is intact (no out-of-band edit)", () => {
    // v1.7 added provisioningTools (the member-invite tool vocabulary) to the pinned content.
    const {
      version,
      tierAliases,
      sse,
      provisioningTools,
      gatewayContract,
      itemPayloadContract,
      codebasePayloadContract,
    } = fixture;
    const recomputed = createHash("sha256")
      .update(
        JSON.stringify(
          canonical({
            version,
            tierAliases,
            sse,
            provisioningTools,
            gatewayContract,
            itemPayloadContract,
            // Hashed since 1.24 (AIO-1011). This block carries `minScannerVersion` — the declared
            // threshold a scan's `scanner_version` is read against — so it is contract CONTENT,
            // not commentary, and an out-of-band edit to it must break the hash like any other.
            codebasePayloadContract,
          }),
        ),
      )
      .digest("hex");
    expect(recomputed).toBe(fixture.contentHash);
  });

  it("fixture version tracks BRAIN_API_VERSION", () => {
    expect(fixture.version).toBe(BRAIN_API_VERSION);
  });

  // brain-api 1.24 (AIO-1011). The staleness threshold is DECLARED in the canonical contract and
  // MIRRORED in this repo as a constant the read path uses. This guard is the thing that stops
  // the two drifting — and drift here is silent by construction: a brain reading a stale mirror
  // would keep classifying scans without erroring, which is the exact failure mode (a wrong
  // answer with no red) that AIO-1011 exists to end.
  it("MIN_SCANNER_VERSION mirrors the contract's declared minScannerVersion", () => {
    expect(fixture.codebasePayloadContract.minScannerVersion).toBe(
      MIN_SCANNER_VERSION,
    );
  });

  it("the mirrored minimum is an ordered version the read path can actually parse", () => {
    // A minimum this repo cannot parse would disable staleness detection fleet-wide and silently:
    // `scannerStaleness` refuses to invent a threshold, so every repo would read "unknown".
    expect(parseScannerVersion(MIN_SCANNER_VERSION)).not.toBeNull();
    expect(scannerStaleness("0.0.1", MIN_SCANNER_VERSION)).toBe("stale");
  });

  // The item-payload contract carries its OWN version (last changed at 1.12) and is decoupled from
  // the API revision: 1.13 (the sync-origin task return leg) changed the tasks feed, not the item
  // payload, so these fixtures stay pinned at 1.12 while `fixture.version` tracks BRAIN_API_VERSION.
  it("content-addresses the Brain API 1.12 item schema and fixtures", () => {
    expect(fixture.itemPayloadContract.version).toBe("1.12");
    for (const key of ["schema", "fixtures"] as const) {
      const ref = fixture.itemPayloadContract[key] as {
        readonly path: string;
        readonly sha256: string;
      };
      const bytes = readFileSync(join(import.meta.dirname, "..", "fixtures", "contract", ref.path));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(ref.sha256);
    }
  });

  it("accepts every canonical Brain API 1.12 item fixture", () => {
    for (const entry of itemFixtures.valid) {
      expect(itemPayloadSchema.safeParse(entry.payload).success, entry.name).toBe(
        true,
      );
    }
  });

  it("rejects every canonical Brain API 1.12 invalid fixture", () => {
    for (const entry of itemFixtures.invalid) {
      expect(itemPayloadSchema.safeParse(entry.payload).success, entry.name).toBe(
        false,
      );
    }
  });

  it("provisioning tool vocabulary matches the fixture (adapters registry + invite request schema)", () => {
    // The workspace runs the mirror assertion against its `aios member` CLI TOOLS set. A tool
    // added to lib/provisioning without the fixture (or vice versa) fails this build; the fixture
    // regeneration then forces the workspace CLI to follow. Also pins PROVISIONING_TOOLS (the
    // source of the REST request schema's enum) so the wire vocabulary can't drift from the
    // adapters that back it.
    const contractTools = [...fixture.provisioningTools].sort();
    expect([...ALL_TOOLS].sort()).toEqual(contractTools);
    expect([...PROVISIONING_TOOLS].sort()).toEqual(contractTools);
  });

  it("server normalizeTier matches every shared alias row", () => {
    for (const [input, expected] of Object.entries(
      fixture.tierAliases.shared,
    )) {
      expect(normalizeTier(input), `shared: ${input}`).toBe(expected);
    }
  });

  it("server normalizeTier matches the server column of every divergent row (admin/private/unknown → null)", () => {
    for (const [input, cols] of Object.entries(fixture.tierAliases.divergent)) {
      expect(normalizeTier(input), `divergent(server): ${input}`).toBe(
        (cols as { server: unknown }).server,
      );
    }
  });

  it("formatSseFrame reproduces every contract frame byte-for-byte", () => {
    for (const frame of fixture.sse.frames) {
      expect(
        formatSseFrame(frame.event, frame.data),
        `frame: ${frame.name}`,
      ).toBe(frame.raw);
    }
  });
});
