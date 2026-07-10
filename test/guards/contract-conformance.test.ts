import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { normalizeTier, PROVISIONING_TOOLS } from "@/lib/api/schemas";
import { formatSseFrame } from "@/lib/api/sse";
import { BRAIN_API_VERSION } from "@/lib/api/version";
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

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "contract", "brain-contract.json");
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));

// Same canonicalization the workspace test + generator use (recursive key sort → stable JSON).
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const canonical = (v: Json): Json =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.keys(v)
          .sort()
          .reduce<Record<string, Json>>((o, k) => ((o[k] = canonical(v[k])), o), {})
      : v;

describe("brain-api tier + SSE conformance", () => {
  it("fixture contentHash is intact (no out-of-band edit)", () => {
    // v1.7 added provisioningTools (the member-invite tool vocabulary) to the pinned content.
    const { version, tierAliases, sse, provisioningTools } = fixture;
    const recomputed = createHash("sha256")
      .update(JSON.stringify(canonical({ version, tierAliases, sse, provisioningTools })))
      .digest("hex");
    expect(recomputed).toBe(fixture.contentHash);
  });

  it("fixture version tracks BRAIN_API_VERSION", () => {
    expect(fixture.version).toBe(BRAIN_API_VERSION);
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
    for (const [input, expected] of Object.entries(fixture.tierAliases.shared)) {
      expect(normalizeTier(input), `shared: ${input}`).toBe(expected);
    }
  });

  it("server normalizeTier matches the server column of every divergent row (admin/private/unknown → null)", () => {
    for (const [input, cols] of Object.entries(fixture.tierAliases.divergent)) {
      expect(normalizeTier(input), `divergent(server): ${input}`).toBe((cols as { server: unknown }).server);
    }
  });

  it("formatSseFrame reproduces every contract frame byte-for-byte", () => {
    for (const frame of fixture.sse.frames) {
      expect(formatSseFrame(frame.event, frame.data), `frame: ${frame.name}`).toBe(frame.raw);
    }
  });
});
