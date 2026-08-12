import { describe, expect, it } from "vitest";
import { deriveLlmState } from "@/lib/query/llm-health";

/**
 * The answering-model leg's state, BANNERFLAP-1.
 *
 * `deriveLlmState` used to take ONE row and return `degraded` for any failure. On this install `llm`
 * heals on the very next attempt 6 times out of 10 (60d of prod), so a single row is not evidence of
 * an outage — it is a sample of size one. `unstable` is the honest name for that: recorded, shown,
 * not shouted about.
 */
describe("deriveLlmState", () => {
  it("unknown when nothing has been recorded — null and empty are the same 'no evidence'", () => {
    expect(deriveLlmState(null)).toBe("unknown");
    expect(deriveLlmState([])).toBe("unknown");
  });

  it("healthy when the newest run succeeded, whatever came before it", () => {
    expect(deriveLlmState([{ ok: true }])).toBe("healthy");
    expect(deriveLlmState([{ ok: true }, { ok: false }, { ok: false }])).toBe("healthy");
  });

  it("UNSTABLE for a lone failure — the blip that used to read as an outage", () => {
    expect(deriveLlmState([{ ok: false }, { ok: true }])).toBe("unstable");
    // The leg's first-ever run failing is also a lone failure: nothing corroborates it.
    expect(deriveLlmState([{ ok: false }])).toBe("unstable");
  });

  it("DEGRADED once the failure repeats — the direction that must not weaken", () => {
    expect(deriveLlmState([{ ok: false }, { ok: false }])).toBe("degraded");
  });
});
