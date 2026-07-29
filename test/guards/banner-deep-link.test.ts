import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * BUILD-FAILING GUARD: the pipeline banner's "View ingestion runs →" link must land ON the runs table.
 *
 * Reported from prod: clicking it dropped you at the TOP of the admin page, with the runs table far
 * below and nothing indicating where to look. On the integrations page itself the link pointed at the
 * page you were already on, so it did visibly nothing at all.
 *
 * The failure is a two-part contract with nothing tying the halves together — a fragment in one file
 * and an `id` in another. Either can be renamed alone, and the result is silent: a link that still
 * works, still navigates, and just quietly stops arriving anywhere useful. No test fails, no type
 * breaks, and the only detector is a human clicking it.
 *
 * KNOWN BLIND SPOTS:
 *   • This pins the anchor's existence, not that it renders. An `id` on a conditionally rendered branch
 *     would satisfy it while the target is absent at runtime.
 *   • A caller that builds the href indirectly (a variable, a helper) instead of an inline template
 *     literal isn't matched.
 *
 * Callers are DISCOVERED by walking `app/`, not listed: a hardcoded file list is green for exactly the
 * files you thought of, and the whole point is to catch the NEXT surface that renders this banner.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const RUNS_PAGE = join("app", "t", "[team]", "admin", "integrations", "page.tsx");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Every file under `app/` that renders the banner — found, not enumerated. */
function bannerCallers(): string[] {
  return walk(join(ROOT, "app"))
    .filter((f) => readFileSync(f, "utf8").includes("<PipelineHealthBanner"))
    .map((f) => f.slice(ROOT.length + 1))
    .sort();
}

/** The `href={...}` passed to every PipelineHealthBanner, in source order. */
function bannerHrefs(src: string): string[] {
  return [...src.matchAll(/<PipelineHealthBanner[^>]*?href=\{`([^`]+)`\}/g)].map((m) => m[1]);
}

describe("guard: the pipeline banner deep-links to the runs table", () => {
  it("every banner href carries a fragment", () => {
    const callers = bannerCallers();
    // Non-vacuity, in two separate senses so a failure says which one broke: the walk must FIND callers,
    // and the href pattern must MATCH inside them. Either returning empty would make the real assertion
    // below pass over nothing.
    expect(callers.length, "no file under app/ renders <PipelineHealthBanner> — the walk is broken").toBeGreaterThan(0);
    const found = callers.flatMap((rel) => bannerHrefs(read(rel)).map((h) => `${rel}: ${h}`));
    const unmatched = callers.filter((rel) => bannerHrefs(read(rel)).length === 0);
    expect(
      unmatched,
      `these render the banner but no href={\`…\`} matched — an indirect href, or the pattern has ` +
        `drifted:\n${unmatched.join("\n")}`
    ).toEqual([]);
    const withoutFragment = found.filter((h) => !h.includes("#"));
    expect(
      withoutFragment,
      `these link to a page, not to the runs table — the reported bug (you land at the top of admin ` +
        `with no idea where the runs are):\n${withoutFragment.join("\n")}`
    ).toEqual([]);
  });

  it("every fragment resolves to an id that actually exists on the target page", () => {
    // The half that makes this a contract rather than a style rule: renaming either side alone breaks
    // the link SILENTLY — navigation still succeeds, it just stops scrolling anywhere.
    const target = read(RUNS_PAGE);
    for (const rel of bannerCallers()) {
      for (const href of bannerHrefs(read(rel))) {
        const fragment = href.split("#")[1];
        expect(fragment, `${rel}: href has no fragment`).toBeTruthy();
        expect(
          target.includes(`id="${fragment}"`),
          `${rel} links to #${fragment}, but no id="${fragment}" exists in ${RUNS_PAGE}`
        ).toBe(true);
      }
    }
  });

  it("the anchored section is the one containing the runs table", () => {
    // Pins WHICH element carries the id. An anchor that exists but sits on the wrong section satisfies
    // the check above while still landing the reader in the wrong place.
    const target = read(RUNS_PAGE);
    const anchorIdx = target.indexOf('id="ingestion-runs"');
    const panelIdx = target.indexOf("<IngestRunsPanel");
    expect(anchorIdx, 'no id="ingestion-runs" on the runs page').toBeGreaterThan(-1);
    expect(panelIdx, "no <IngestRunsPanel> on the runs page").toBeGreaterThan(-1);
    expect(anchorIdx, "the anchor must come before the runs panel it labels").toBeLessThan(panelIdx);
    // …and close to it: a match 4000 chars up the file is a different section entirely.
    expect(panelIdx - anchorIdx).toBeLessThan(1200);
  });

  it("dismissal state is keyed on the path, not the fragment", () => {
    // Adding the anchor changed every href. Keying localStorage on the full string would have silently
    // un-dismissed every banner an admin had already dismissed — and would again on any future
    // fragment change. The fragment is a scroll position, not a different surface.
    const banner = read(join("components", "admin", "pipeline-health-banner.tsx"));
    expect(banner).toContain('href.split("#")[0]');
  });
});
