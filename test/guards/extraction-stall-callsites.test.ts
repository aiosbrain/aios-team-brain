import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * BUILD-FAILING GUARD: every caller of `deriveGraphExtractionStalled` supplies the liveness signal.
 *
 * WHY THIS EXISTS — it is not hypothetical. The liveness leg (STALLPROBE-1) was first added with an
 * OPTIONAL `extractor` field documented as "omitted ⇒ pre-fix behaviour", and exactly one of the two
 * call sites got wired. The one that was missed — `lib/query/retrieval-health.ts` — is the
 * Retrieval-health card, i.e. the surface that produced the bug report in the first place. Every test
 * passed, `tsc` passed, and the change would have shipped a fixed pipeline banner sitting next to a
 * still-broken card, the two disagreeing. A second reviewer caught it.
 *
 * The field is REQUIRED now, so `tsc` catches an omission in `lib/`. This guard exists anyway for two
 * reasons the type system does not cover:
 *   1. `tsconfig.json` EXCLUDES the whole `test/` tree (and every `.test.ts`), so type-level
 *      enforcement stops at the
 *      production boundary;
 *   2. a future refactor can re-introduce optionality (a `Partial<>`, a default, a widened overload)
 *      and silently restore the hole. A grep-level assertion cannot be softened by accident.
 *
 * Deliberately source-text based: the property is "no call site anywhere forgets", which no unit test
 * of the function itself can express — the function is perfectly correct in isolation, and that is
 * precisely how the bug survived.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/**
 * Every tree `tsconfig` typechecks (`**\/*.ts` minus `test/`), not just `lib/`. Scanning only `lib/`
 * was flagged in review: there are no call sites in `app/`/`components/`/`scripts/` today, so it was
 * latent rather than live, but the guard's advertised property is "no call site ANYWHERE forgets" and
 * a guard that quietly means something narrower than it claims is the failure mode this file exists
 * to prevent. Missing directories are skipped rather than throwing, so the guard survives a reorg.
 */
const SCANNED = ["lib", "app", "components", "scripts"];
const FN = "deriveGraphExtractionStalled";
const REQUIRED_ARG = "newestEpisodicAtMs";

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    // `.tsx` too — the admin card is a `.tsx`, so a component calling the predicate directly would
    // otherwise sit outside a guard that claims to cover everything typechecked.
    return (full.endsWith(".ts") || full.endsWith(".tsx")) && !full.endsWith(".d.ts") ? [full] : [];
  });
}

/** The argument text of one call, extracted by balancing parens from the opening one. */
function argOf(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return src.slice(openIdx + 1); // unbalanced — treat as the rest of the file (fails loudly below)
}

/** Every `deriveGraphExtractionStalled(` invocation in the scanned trees, excluding its own declaration. */
function callSites(): { file: string; arg: string; fileSrc: string }[] {
  const out: { file: string; arg: string; fileSrc: string }[] = [];
  for (const file of SCANNED.flatMap((d) => tsFiles(path.join(ROOT, d)))) {
    const src = readFileSync(file, "utf8");
    let from = 0;
    for (;;) {
      const i = src.indexOf(`${FN}(`, from);
      if (i === -1) break;
      from = i + FN.length;
      // Skip the declaration itself (`export function deriveGraphExtractionStalled(`).
      if (/function\s+$/.test(src.slice(Math.max(0, i - 30), i))) continue;
      out.push({ file: path.relative(ROOT, file), arg: argOf(src, i + FN.length), fileSrc: src });
    }
  }
  return out;
}

describe("guard: every deriveGraphExtractionStalled call site passes the liveness signal", () => {
  it("finds the call sites at all — a guard that matches nothing proves nothing", () => {
    // The vacuity check. If a rename makes `callSites()` return [], every assertion below passes
    // trivially; this is the one that reddens instead.
    const sites = callSites();
    expect(sites.length).toBeGreaterThanOrEqual(2);
    const files = sites.map((s) => s.file);
    expect(files).toContain("lib/graph/extraction-health.ts");
    // The site that was missed. Named explicitly so deleting its wiring can't quietly shrink the set.
    expect(files).toContain("lib/query/retrieval-health.ts");
  });

  it("every call site supplies newestEpisodicAtMs", () => {
    const missing = callSites()
      .filter(({ arg, fileSrc }) => {
        // An INLINE OBJECT LITERAL is checkable exactly — the field must be one of its keys.
        if (arg.trimStart().startsWith("{")) return !arg.includes(REQUIRED_ARG);
        // An IDENTIFIER argument (`deriveGraphExtractionStalled(signals)`) is built elsewhere in the
        // file, so the honest check is that the file constructs the field at all. Weaker, and said so
        // rather than dressed up: `tsc` is the real enforcement for that shape, since the field is
        // required and `lib/` IS typechecked.
        return !fileSrc.includes(REQUIRED_ARG);
      })
      .map((s) => s.file);
    expect(
      missing,
      `these call sites omit ${REQUIRED_ARG}, so they silently keep the pre-STALLPROBE-1 ` +
        `fact-lag behaviour and will report a stall on a healthy, dedup-frozen graph: ${missing.join(", ")}`
    ).toEqual([]);
  });
});
