import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { deploymentEnvironment, isStagingDeployment } from "../../lib/env/deployment";
import { StagingBanner } from "../../components/layout/staging-banner";

/**
 * STGENV-1 — the staging banner, pinned in BOTH directions.
 *
 * WHY BOTH. A banner that never appears is the obvious failure, and it is the one people write a test
 * for. The one they forget is a banner that appears EVERYWHERE — on localhost, in CI, and eventually on
 * production — because that is not a louder warning, it is a warning nobody reads. The asymmetry
 * assertions below exist so neither can regress silently, and the production case is asserted by NAME
 * rather than by "not staging", so a future environment cannot inherit the banner by accident.
 */

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("staging banner — the environment decision (STGENV-1)", () => {
  it("is TRUE only for the staging environment", () => {
    expect(isStagingDeployment({ RAILWAY_ENVIRONMENT_NAME: "staging" } as NodeJS.ProcessEnv)).toBe(true);
    // Case-insensitive: the platform's casing is not something this should depend on.
    expect(isStagingDeployment({ RAILWAY_ENVIRONMENT_NAME: "Staging" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isStagingDeployment({ RAILWAY_ENVIRONMENT: "staging" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("is FALSE on production — asserted by name, not merely as 'not staging'", () => {
    expect(isStagingDeployment({ RAILWAY_ENVIRONMENT_NAME: "production" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("is FALSE off-platform, where the variable is unset or blank", () => {
    // Local dev, `npm test`, CI. A banner across every developer's screen is a banner people learn to
    // ignore, and then it is worth nothing on the day it matters.
    expect(isStagingDeployment({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isStagingDeployment({ RAILWAY_ENVIRONMENT_NAME: "" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isStagingDeployment({ RAILWAY_ENVIRONMENT_NAME: "   " } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("matches the environment EXACTLY — no prefix or substring inheritance", () => {
    // `staging-experiments` must not silently inherit the banner, and nothing production-shaped may
    // ever match. A `startsWith`/`includes` implementation passes the tests above and fails these.
    for (const name of ["staging-2", "prestaging", "staging-experiments", "not-staging", "production-staging"]) {
      expect(isStagingDeployment({ RAILWAY_ENVIRONMENT_NAME: name } as NodeJS.ProcessEnv), name).toBe(false);
    }
  });

  it("reports the raw environment name, trimmed, for anything else that needs it", () => {
    expect(deploymentEnvironment({ RAILWAY_ENVIRONMENT_NAME: " staging " } as NodeJS.ProcessEnv)).toBe("staging");
    expect(deploymentEnvironment({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("staging banner — what it RENDERS (STGENV-1)", () => {
  /**
   * THE ASSERTION THIS FILE WAS MISSING, and the reason it matters more than all the source-text
   * pinning below. Fable ran the obvious mutation — inverting `if (!isStagingDeployment())` to
   * `if (isStagingDeployment())` — and ALL TEN of the original guards stayed green. That mutant paints
   * "STAGING — a copy of production data" across PRODUCTION and shows nothing on staging, with the
   * suite passing. Source-text guards cannot see it; only rendering can.
   */
  afterEach(() => vi.unstubAllEnvs());
  const markup = () => renderToStaticMarkup(createElement(StagingBanner));

  it("RENDERS the banner on staging", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "staging");
    const html = markup();
    expect(html).toContain('data-testid="staging-banner"');
    expect(html).toMatch(/copy of production data/i);
  });

  it("renders NOTHING on production", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "production");
    expect(markup()).toBe("");
  });

  it("renders NOTHING off-platform", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "");
    expect(markup()).toBe("");
  });
});

describe("staging banner — it is actually WIRED (STGENV-1)", () => {
  it("is mounted in the ROOT layout, so no page can be reached without it", () => {
    // Pinning the call site, not just the component: a banner nothing renders is decoration, and this
    // repo has a recorded case of exporting a describe* function and never mounting it.
    const layout = read("app/layout.tsx");
    expect(layout).toMatch(/import \{ StagingBanner \}/);
    expect(layout).toMatch(/<StagingBanner \/>/);
  });

  it("renders ABOVE and OUTSIDE the providers", () => {
    // So it survives a provider below it throwing, and cannot be covered by a page-level layout.
    const layout = read("app/layout.tsx");
    // Match the ELEMENT, not the bare tag name: an earlier spelling searched for `<Providers>` and
    // found it inside a comment that happened to mention it, which put the "banner is first"
    // assertion the wrong way round and failed on correct code. A needle that can match prose is
    // not a needle.
    const banner = layout.indexOf("<StagingBanner />");
    const providers = layout.indexOf("<Providers>{children}</Providers>");
    expect(banner, "the banner element must be present").toBeGreaterThan(-1);
    expect(providers, "the providers element must be present").toBeGreaterThan(-1);
    expect(banner, "banner must render before the providers element").toBeLessThan(providers);
  });

  it("is a SERVER component — the env read must not reach the client bundle", () => {
    const src = read("components/layout/staging-banner.tsx");
    // NOT because the value would be inlined into the bundle — non-`NEXT_PUBLIC_` vars never are.
    // The real failure is a HYDRATION MISMATCH: the server paints the banner, the client computes
    // `null` from an env it cannot see, and the banner VANISHES after hydration on staging.
    expect(src, 'a "use client" directive would make the banner disappear on hydration').not.toMatch(/["']use client["']/);
    expect(src).toMatch(/isStagingDeployment\(\)/);
  });

  it("names the environment AND why it looks convincing", () => {
    // A bare "staging" chip reads as decoration after a day. The hazard is that the data is REAL —
    // a copy of production — so the text has to say that, or the banner does not do its job.
    const src = read("components/layout/staging-banner.tsx");
    expect(src).toMatch(/STAGING/);
    expect(src).toMatch(/copy of\s+\n?\s*\*?\s*production data/i);
  });

  it("does NOT claim a database property it cannot prove", () => {
    // The key knows the ENVIRONMENT NAME. "production is never written from here" is a claim about
    // DATABASE_URL — and if staging's URL were ever pointed at prod, the banner would have been
    // asserting safety above every write that reached production.
    const src = read("components/layout/staging-banner.tsx");
    const rendered = src.slice(src.indexOf("<div"));
    expect(rendered, "must not assert a write-safety property").not.toMatch(/never written from here/);
  });

  it("offsets sticky descendants so it cannot cover the team sidebar", () => {
    expect(read("components/layout/staging-banner.tsx")).toMatch(/--staging-banner-h/);
    const team = read("app/t/[team]/layout.tsx");
    expect(team, "the sidebar must opt in").toMatch(/data-staging-offset/);
    expect(team, "and fall back to 0px off staging").toMatch(/var\(--staging-banner-h,\s*0px\)/);
  });

  it("lib/env/deployment.ts is the ONLY reader of the platform variable in app code", () => {
    // The first spelling checked one file while its name claimed the repo. Walk the app surface: a
    // second reader is a second answer that can drift from the banner's.
    const roots = ["app", "components", "lib"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(e.name) && rel !== "lib/env/deployment.ts") {
          // Match a READ (`process.env.RAILWAY_ENVIRONMENT…`), not a mention. This is the SECOND
          // needle in this file to match prose instead of code — the first found `<Providers>` inside
          // a comment. Here a comment in `app/layout.tsx` explaining the variable tripped it.
          if (/process\.env\.RAILWAY_ENVIRONMENT/.test(read(rel))) offenders.push(rel);
        }
      }
    };
    roots.forEach(walk);
    expect(offenders, `only lib/env/deployment.ts may read it; also found: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the root layout is never PRERENDERED, so the banner is decided per request", () => {
    // MEASURED by Fable: built this branch twice. `_not-found.html` contained the banner when the env
    // was set AT BUILD TIME and not when it wasn't — the decision was frozen at `npm run build` for
    // that route. Every data-bearing page is dynamic by construction today, so the hazard is not
    // reached, but it widens silently the day a page stops touching a request API.
    expect(read("app/layout.tsx")).toMatch(/export const dynamic = "force-dynamic"/);
  });
});
