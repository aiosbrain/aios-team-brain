import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * BUILD-FAILING GUARD: a generation feature cannot silently join the UNOBSERVED set (LLMOBS-1).
 *
 * WHY THIS EXISTS — it is the whole shape of the bug. `lib/llm/complete` records a `source='llm'`
 * outcome row only when a caller passes `record:`. Exactly ONE file ever did, so the "Answering model"
 * health leg watched narrative-arc synthesis and spoke for everything — including a note naming
 * meeting summaries it had never observed. Nothing failed; nothing warned; the gap was invisible
 * because it is an ABSENCE, and no test asserts an absence it does not know about.
 *
 * So the invariant is inverted: every call site is either recorded or LISTED. A new generation feature
 * that forgets `record:` reddens the build, and one that deliberately opts out has to say so here, in
 * writing, next to the reason.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIB = path.join(ROOT, "lib");

/**
 * Call sites that deliberately do NOT record, each with the reason. Keeping this list SHORT is the
 * point; every entry is a feature the answering-model leg is blind to.
 */
const EXEMPT: Record<string, string> = {
  "lib/dashboard/timeline-summary.ts":
    "FAN-OUT: one model call per (person, day), re-run on every background rebuild. Measured 37.9 " +
    "calls/day against 333.7 ingest_runs rows/day total and a 50-row runs panel — per-call recording " +
    "would make the operator's panel mostly timeline summaries. Needs one row per PASS, which is a " +
    "change to the recording primitive, not to this call site. Deferred in the spec, not forgotten.",
  "lib/dashboard/doc-task-infer-run.ts":
    "FAN-OUT: same shape, one call per scored doc inside a worker loop. Same fix, same slice.",
  "lib/social/generate.ts":
    "Reaches the primitive through `lib/social/llm.ts`'s re-export, and whether social generation " +
    "belongs on the ANSWERING-MODEL leg at all is a product question, not an oversight.",
  // NOTE: `lib/social/llm.ts`, `lib/llm/cost.ts` and `lib/query/embeddings.ts` were listed here in a
  // first draft and the stale-exemption check below rejected them — none of them actually CALLS the
  // primitive (social/llm.ts only re-exports it). The list is shorter than it looked, which is the
  // right direction: every entry is a feature the leg is blind to.
};

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith(".ts") && !full.endsWith(".d.ts") ? [full] : [];
  });
}

/** Files under `lib/` that call the shared completion primitive. */
function callSites(): { file: string; src: string }[] {
  return tsFiles(LIB)
    .map((full) => ({ file: path.relative(ROOT, full), src: readFileSync(full, "utf8") }))
    // The primitive's own module defines them; it is not a call site.
    .filter(({ file, src }) => file !== "lib/llm/complete.ts" && /\bcompleteText(OrNull)?\s*\(/.test(src));
}

describe("guard: every generation call site records its outcome, or is listed", () => {
  it("finds call sites at all — a guard that matches nothing proves nothing", () => {
    const sites = callSites();
    expect(sites.length).toBeGreaterThanOrEqual(5);
    // The site the whole ticket is about: if this stops matching, the guard has lost its subject.
    expect(sites.map((s) => s.file)).toContain("lib/meetings/llm-extract.ts");
  });

  it("every call site passes `record:` or appears in EXEMPT with a reason", () => {
    const unlisted = callSites()
      .filter(({ file, src }) => !/record:\s/.test(src) && !(file in EXEMPT))
      .map((s) => s.file);
    expect(
      unlisted,
      "these call sites neither record their outcome nor declare why not, so the answering-model " +
        "health leg is silently blind to them — the exact shape of LLMOBS-1:\n" + unlisted.join("\n")
    ).toEqual([]);
  });

  it("every EXEMPT entry still exists and still calls the primitive — no stale exemptions", () => {
    // An exemption for a file that no longer calls the primitive is dead weight that makes the list
    // look longer (and the blind spot bigger) than it is.
    const live = new Set(callSites().map((s) => s.file));
    const stale = Object.keys(EXEMPT).filter((f) => !live.has(f));
    expect(stale, `stale exemptions — these no longer call the primitive:\n${stale.join("\n")}`).toEqual([]);
  });

  it("every exemption carries a non-trivial reason", () => {
    for (const [file, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, `${file}'s exemption reason is too thin to be a decision`).toBeGreaterThan(40);
    }
  });
});
