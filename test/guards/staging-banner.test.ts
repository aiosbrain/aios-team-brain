import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deploymentEnvironment, isStagingDeployment } from "../../lib/env/deployment";

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
    expect(src, 'a "use client" directive would ship the env read to the browser').not.toMatch(/["']use client["']/);
    expect(src).toMatch(/isStagingDeployment\(\)/);
  });

  it("names the environment AND why it looks convincing", () => {
    // A bare "staging" chip reads as decoration after a day. The hazard is that the data is REAL —
    // a copy of production — so the text has to say that, or the banner does not do its job.
    const src = read("components/layout/staging-banner.tsx");
    expect(src).toMatch(/STAGING/);
    expect(src).toMatch(/copy of production data/i);
  });

  it("does not read the env anywhere else, so there is ONE owner of the answer", () => {
    // A second reader is a second answer that can drift. `lib/env/deployment.ts` is the only place
    // allowed to consult the platform variable.
    const banner = read("components/layout/staging-banner.tsx");
    expect(banner, "the component must ask the module, not process.env").not.toMatch(/process\.env/);
  });
});
