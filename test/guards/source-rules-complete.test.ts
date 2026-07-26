import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SOURCE_RULES } from "@/lib/ingest/source-rules";

/**
 * BUILD-FAILING GUARD: every source that can reach `ingestItem` has an explicit row in
 * `SOURCE_RULES`.
 *
 * `sourceRules()` returns a permissive default for an unknown source, which is the right *runtime*
 * behaviour (freezing a work-time makes real work vanish from the Timeline with nothing to show
 * why). But a default nobody notices is how a rules layer rots into decoration: the next connector
 * inherits a policy no one chose, and the symptom — content dated wrong — never points back here.
 *
 * So the default must never be load-bearing. This discovers the sources from CODE rather than a
 * hand-kept list: the Python sidecar's `_REGISTRY`, and the `source:` literal stamped by every
 * in-app `ItemPayload` producer under `lib/`. Adding a connector fails this test until its policy is
 * stated.
 *
 * SCOPE, stated rather than implied: discovery finds a source only where it is a literal in the
 * producer's frontmatter. A producer that computes its `source` at runtime, or one living outside
 * `lib/`, is not discovered — it would inherit the permissive default silently. No such producer
 * exists today (the sourceless `ingestItem` callers — `lib/meetings/*`, `lib/actions/handlers` —
 * stamp no `source` at all and so have no rule to state).
 */

const ROOT = join(__dirname, "..", "..");

/**
 * Sidecar source keys. The key charset is `[a-z0-9_-]`, DELIBERATELY wider than
 * `scripts/check-docs-drift.mjs`'s `[a-z_]`: a registry key with a digit or hyphen (`s3`,
 * `gdrive-shared`) would otherwise be invisible to every assertion below and inherit the default
 * with no build failure — the exact vacuity this guard exists to prevent, hiding inside the guard.
 */
function sidecarSources(): string[] {
  const src = readFileSync(join(ROOT, "ingestion", "aios_ingest", "sources", "registry.py"), "utf8");
  const block = src.match(/_REGISTRY[^{]*\{([\s\S]*?)\}/);
  if (!block) throw new Error("could not parse _REGISTRY — the guard would silently pass");
  return [...block[1].matchAll(/"([a-z0-9_-]+)"\s*:/g)].map((m) => m[1]);
}

/** Every `.ts` under `lib/`, recursively — discovery must not be bounded by today's directories. */
function libFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return libFiles(full);
    return e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [full] : [];
  });
}

/**
 * `frontmatter.source` literals stamped by in-app producers.
 *
 * Anchored on files that mention `ItemPayload` — i.e. things that build an item — rather than on a
 * hardcoded directory list, so a producer added anywhere under `lib/` is discovered. That anchor is
 * also what keeps it PRECISE: `source:` is a common field name (`ingest_runs.source`, the LLM call
 * source, scheduler legs), and a bare recursive scan pulls in a dozen unrelated values that have
 * nothing to do with ingestion.
 *
 * Scanned as text rather than imported, because a normalizer needs its full argument shape to run
 * and this only needs the constant — the point is discovery, not execution.
 */
function inAppSources(): string[] {
  const found = new Set<string>();
  for (const file of libFiles(join(ROOT, "lib"))) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("ItemPayload")) continue;
    for (const m of text.matchAll(/^\s*source:\s*"([a-z0-9_-]+)",/gm)) found.add(m[1]);
  }
  return [...found];
}

describe("guard: every ingest source has an explicit per-source rule", () => {
  it("discovers sources from code (a broken scan must fail, not pass vacuously)", () => {
    // Pins the discovery itself: a regex that stops matching would otherwise make this whole guard
    // assert nothing, which is precisely the vacuous-coverage failure the work-time key list had.
    expect(sidecarSources()).toContain("local");
    expect(inAppSources()).toContain("slack");
    expect(inAppSources().length).toBeGreaterThanOrEqual(4);
  });

  it("every sidecar source is classified", () => {
    const missing = sidecarSources().filter((s) => !(s in SOURCE_RULES));
    expect(missing, `add these to SOURCE_RULES: ${missing.join(", ")}`).toEqual([]);
  });

  it("every in-app producer's source is classified", () => {
    const missing = inAppSources().filter((s) => !(s in SOURCE_RULES));
    expect(missing, `add these to SOURCE_RULES: ${missing.join(", ")}`).toEqual([]);
  });

  it("carries no rule for a source nothing produces (a stale row is a lie about coverage)", () => {
    const real = new Set([...sidecarSources(), ...inAppSources()]);
    const orphaned = Object.keys(SOURCE_RULES).filter((s) => !real.has(s));
    expect(orphaned, `no producer emits: ${orphaned.join(", ")}`).toEqual([]);
  });
});
