import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `llm` is NOT a leg on the loud ingestion banner (LLMOBS-1 §3d).
 *
 * Two reasons, and the second is the one review supplied. (1) The banner's sentence is "N ingestion
 * legs are broken — the brain isn't getting fresh data", which is FALSE for a generation leg:
 * ingestion is fine, a model failed. (2) Keeping it DOUBLE-COUNTED every arcs failure — a failed
 * synthesis writes a `source='arcs'` ingest row AND, via `record:`, a `source='llm'` row — which is
 * literally the "2 ingestion legs are broken" of the 2026-08-11 incident BANNERFLAP-1 was raised for.
 *
 * Source-level because the leg set is a constant consumed inside a function behind Postgres + Neo4j;
 * the property is "this source is excluded", which the filter expresses directly.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(path.join(ROOT, "lib", "ingest", "pipeline-health.ts"), "utf8");

describe("guard: the ingestion banner does not speak for generation", () => {
  it("excludes `llm` from the pipeline legs", () => {
    const set = SRC.slice(SRC.indexOf("const NOT_PIPELINE_LEGS"));
    expect(set.slice(0, 200)).toContain('"llm"');
  });

  it("still excludes the graph-health transition ledger — the pre-existing exclusion is intact", () => {
    const set = SRC.slice(SRC.indexOf("const NOT_PIPELINE_LEGS"));
    expect(set.slice(0, 200)).toContain("GRAPH_HEALTH_SOURCE");
  });

  it("filters the leg set through that constant, not a single hard-coded comparison", () => {
    // The mutation this catches: reverting to `r.source !== GRAPH_HEALTH_SOURCE` silently puts `llm`
    // back on the banner and restores the double-count.
    expect(SRC).toContain("!NOT_PIPELINE_LEGS.has(r.source)");
    expect(SRC).not.toContain("r.source !== GRAPH_HEALTH_SOURCE");
  });

  it("keeps `arcs` as a leg — its removal is a separate question, not smuggled in here", () => {
    const set = SRC.slice(SRC.indexOf("const NOT_PIPELINE_LEGS"));
    expect(set.slice(0, 200)).not.toContain('"arcs"');
  });
});
