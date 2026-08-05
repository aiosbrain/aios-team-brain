import { afterEach, describe, expect, it, vi } from "vitest";
import { PROXY_CALLS_PER_MINUTE_FOR_TEST } from "@/lib/llm/graph-proxy";

/**
 * GUARD: the graph proxy's per-minute ceiling keeps its measured default AND stays env-tunable.
 *
 * Both halves trace to a real incident (2026-08-04, re-derived from `rate_limits` on 2026-08-05):
 * during graphiti 0.13.2's per-entity fan-out, demand peaked at **426 attempts/min** against this
 * 120 ceiling and the proxy refused our own extraction 4,248 times across 46 windows — while the
 * constant's own comment claimed extraction "is serial … so it will never come close" and that the
 * limiter "can never be the thing that wedges the graph".
 *
 * #490 removed the fan-out and both throttles went to zero (peak now 76/min), so the DEFAULT is
 * deliberately unchanged — there is no evidence to raise it, and raising a leak-damage bound on
 * stale evidence is how a control becomes decoration. What the incident earned is the ability to
 * admit a deliberate backlog (a large repo import, AIO-798) with a variable instead of a deploy.
 *
 * This is the repo-idiomatic shape already used for `PROXY_TIMEOUT_MS_FOR_TEST` 20 lines below the
 * constant: pin the value, not the prose. Two guards I first proposed were cut in plan review as
 * ceremony — asserting a comment no longer contains a phrase, and `DEFAULT >= 4 × OBSERVED_PEAK`
 * (a tautology, since I'd write both constants in the same PR to make it pass).
 */
describe("graph proxy call ceiling", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to the measured 120/min", () => {
    expect(PROXY_CALLS_PER_MINUTE_FOR_TEST).toBe(120);
  });

  it("is env-tunable, so a deliberate backlog admission needs no deploy", async () => {
    vi.stubEnv("GRAPH_PROXY_CALLS_PER_MINUTE", "600");
    vi.resetModules();
    const fresh = await import("@/lib/llm/graph-proxy");
    expect(fresh.PROXY_CALLS_PER_MINUTE_FOR_TEST).toBe(600);
  });

  it("ignores a junk override rather than throttling to zero", async () => {
    // `Number("")` is 0 and `Number("abc")` is NaN — either would refuse EVERY call and wedge the
    // graph, the precise failure this module exists to prevent. `resolvePositiveInt` is what stops it.
    for (const junk of ["", "abc", "0", "-5"]) {
      vi.stubEnv("GRAPH_PROXY_CALLS_PER_MINUTE", junk);
      vi.resetModules();
      const fresh = await import("@/lib/llm/graph-proxy");
      expect(fresh.PROXY_CALLS_PER_MINUTE_FOR_TEST, `override ${JSON.stringify(junk)}`).toBe(120);
    }
  });
});
