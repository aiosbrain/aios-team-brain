import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { normalizeTier } from "@/lib/api/schemas";
import { formatSseFrame } from "@/lib/api/sse";
import { BRAIN_API_VERSION } from "@/lib/api/version";

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
    const { version, tierAliases, sse } = fixture;
    const recomputed = createHash("sha256")
      .update(JSON.stringify(canonical({ version, tierAliases, sse })))
      .digest("hex");
    expect(recomputed).toBe(fixture.contentHash);
  });

  it("fixture version tracks BRAIN_API_VERSION", () => {
    expect(fixture.version).toBe(BRAIN_API_VERSION);
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
