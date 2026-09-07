import { describe, expect, it, vi } from "vitest";
// @ts-expect-error — pure-node script, no types; imported for its exported decisions.
import { refusalFor, clearEndpoint, main, REQUIRED_ENVIRONMENT, environmentRefusalFor } from "../scripts/staging-graph-clear.mjs";
import { isStagingDeployment } from "@/lib/env/deployment";

/**
 * STGENV-4. Spec: docs/design/staging-graph-reset.md.
 *
 * This exists because the FIRST version of this operation was a shell one-liner in the runbook, and
 * the pre-push review proved — by running it — that it never fired: `railway ssh -- sh -c '…'` joins
 * argv and re-wraps it, so the check ran a bare `echo` and printed REFUSED on a healthy staging.
 * A doc cannot be tested. This is the same operation as something that can.
 */

const ok = { ok: true, status: 200 };
/** Every `main` fixture must now name the environment too — the host check alone is not enough. */
const STAGING = { RAILWAY_ENVIRONMENT_NAME: "staging" };

describe("the host check — necessary, and on its own not sufficient", () => {
  it("proceeds only for this environment's own private sidecar", () => {
    expect(refusalFor("http://graphiti.railway.internal:8000")).toBeNull();
    expect(refusalFor("https://graphiti.railway.internal")).toBeNull();
  });

  it.each([
    ["a public host", "http://graphiti.example.com:8000"],
    ["a suffix smuggled into the query", "https://evil.com/?x=.railway.internal"],
    ["a suffix smuggled into the domain", "http://a.railway.internal.evil.com"],
    ["a non-http scheme", "file:///etc/passwd"],
    ["not a URL at all", "graphiti.railway.internal"],
    ["empty", ""],
    ["unset", undefined],
  ])("refuses %s", (_label, url) => {
    // Parsed, not substring-matched: two of these pass a naive `includes(".railway.internal")`.
    expect(refusalFor(url as string | undefined)).toBeTruthy();
  });

  it("builds the endpoint from the parsed origin, so a path cannot smuggle", () => {
    expect(clearEndpoint("http://graphiti.railway.internal:8000")).toBe("http://graphiti.railway.internal:8000/clear");
    expect(clearEndpoint("http://graphiti.railway.internal:8000/")).toBe("http://graphiti.railway.internal:8000/clear");
    expect(clearEndpoint("http://graphiti.railway.internal:8000/messages")).toBe("http://graphiti.railway.internal:8000/clear");
  });
});

describe("exit codes are distinct, because the reviewed shell line's were not", () => {
  const log = () => ({ info: vi.fn(), error: vi.fn() });

  it("refuses with 2 and never issues a request", async () => {
    const fetchImpl = vi.fn();
    const l = log();
    expect(await main({ ...STAGING, GRAPHITI_URL: "http://evil.com" }, fetchImpl, l)).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(l.error.mock.calls.join(" ")).toMatch(/REFUSED/);
  });

  it("clears with 0", async () => {
    const fetchImpl = vi.fn(async () => ok);
    expect(await main({ ...STAGING, GRAPHITI_URL: "http://graphiti.railway.internal:8000" }, fetchImpl, log())).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith("http://graphiti.railway.internal:8000/clear", { method: "POST" });
  });

  it("a FAILED request exits 1 and does NOT read as a host refusal", async () => {
    // The exact defect the review found: `A && B || C` reported every curl failure — sidecar down,
    // 5xx, missing binary — as "REFUSED: not an internal host", and exited 0.
    for (const impl of [
      vi.fn(async () => ({ ok: false, status: 503 })),
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    ]) {
      const l = log();
      expect(await main({ ...STAGING, GRAPHITI_URL: "http://graphiti.railway.internal:8000" }, impl, l)).toBe(1);
      // PER MESSAGE, not over the joined string: `^` without `m` only anchors at the start of the
      // whole join, which the FAILED assertion already pinned — so a mutant that logged FAILED and
      // then REFUSED would have passed. (Found in review.)
      const messages = l.error.mock.calls.flat().map(String);
      expect(messages.some((m) => m.startsWith("FAILED:"))).toBe(true);
      // Anchored per message because a transport error's text can legitimately contain the word
      // (ECONNREFUSED); the property is which MESSAGE the operator gets, not which characters appear.
      expect(messages.some((m) => m.startsWith("REFUSED:"))).toBe(false);
    }
  });

  it("tells the operator about the restart, which the wipe alone does not accomplish", async () => {
    const l = log();
    await main({ ...STAGING, GRAPHITI_URL: "http://graphiti.railway.internal:8000" }, vi.fn(async () => ok), l);
    expect(l.info.mock.calls.join(" ")).toMatch(/48h/);
  });
});

describe("the environment binding — the host proves the wrong thing alone", () => {
  const log = () => ({ info: vi.fn(), error: vi.fn() });
  const INTERNAL = "http://graphiti.railway.internal:8000";

  it("refuses a PRODUCTION shell even though the host is internal", async () => {
    // The review's scenario: an operator in an already-open production shell, or one who types
    // `-e production`. `graphiti.railway.internal` resolves to PRODUCTION's sidecar there, so the
    // host check passes and production's graph is wiped. `*.railway.internal` proves "this
    // environment's sidecar", never "staging's".
    const fetchImpl = vi.fn();
    const l = log();
    expect(await main({ RAILWAY_ENVIRONMENT_NAME: "production", GRAPHITI_URL: INTERNAL }, fetchImpl, l)).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(l.error.mock.calls.flat().join(" ")).toMatch(/production/);
  });

  it("refuses when the environment is unknown, rather than assuming", async () => {
    // If the ssh shell does not carry the service environment, that is the thing to fix — not
    // something to work around by defaulting.
    const fetchImpl = vi.fn();
    expect(await main({ GRAPHITI_URL: INTERNAL }, fetchImpl, log())).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("the environment is checked BEFORE the URL, so a production shell is told the real problem", async () => {
    const l = log();
    await main({ RAILWAY_ENVIRONMENT_NAME: "production", GRAPHITI_URL: "http://evil.com" }, vi.fn(), l);
    expect(l.error.mock.calls.flat().join(" ")).toMatch(/RAILWAY_ENVIRONMENT_NAME/);
  });
});

describe("the two definitions of 'staging' cannot drift apart", () => {
  it("the script's required environment satisfies the app's own staging check", () => {
    // `lib/env/deployment.ts` decides whether to render the staging banner; this script decides
    // whether to wipe a graph. They must mean the same thing by "staging" — if the banner's notion
    // ever moves, this reddens rather than letting a wipe run somewhere the app calls production.
    expect(isStagingDeployment({ RAILWAY_ENVIRONMENT_NAME: REQUIRED_ENVIRONMENT } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("the app helper is more permissive, and that difference is deliberate", () => {
    // `deployment.ts` is case-insensitive and accepts a fallback variable; the script is exact-case
    // and name-only. That asymmetry is fail-closed on the destructive side — a banner shown too
    // eagerly is harmless, a wipe permitted too eagerly is not — but it means `Staging` gets the
    // banner and is REFUSED here, so the refusal message names the observed value.
    expect(isStagingDeployment({ RAILWAY_ENVIRONMENT_NAME: "Staging" } as NodeJS.ProcessEnv)).toBe(true);
    expect(REQUIRED_ENVIRONMENT).toBe("staging");
    // ...and the destructive side REFUSES it. Asserted, not merely described in a comment.
    expect(environmentRefusalFor("Staging")).toBeTruthy();
  });
});
