import { afterEach, describe, expect, it } from "vitest";
import { selectedProviderName } from "@/lib/query/provider";
import { externalProvider } from "@/lib/query/external-provider";

/**
 * Spec for the pluggable context layer: the default is `native`, and `CONTEXT_PROVIDER=external`
 * swaps the whole retrieval layer for an external service (e.g. a gbrain adapter). Derived from
 * the swappability requirement. The external provider must degrade to an empty (ungrounded)
 * context when unconfigured — a missing service never takes the query path down.
 */

const orig = process.env.CONTEXT_PROVIDER;
afterEach(() => {
  if (orig === undefined) delete process.env.CONTEXT_PROVIDER;
  else process.env.CONTEXT_PROVIDER = orig;
});

describe("selectedProviderName", () => {
  it("defaults to native when unset", () => {
    delete process.env.CONTEXT_PROVIDER;
    expect(selectedProviderName()).toBe("native");
  });

  it("selects external (case/space-insensitive)", () => {
    for (const v of ["external", "External", "  EXTERNAL  "]) {
      process.env.CONTEXT_PROVIDER = v;
      expect(selectedProviderName()).toBe("external");
    }
  });

  it("falls back to native for any unknown value", () => {
    process.env.CONTEXT_PROVIDER = "gbrain-typo";
    expect(selectedProviderName()).toBe("native");
  });
});

describe("externalProvider", () => {
  it("returns an empty, ungrounded context when RETRIEVAL_AUGMENT_URL is unset (never throws)", async () => {
    const ctx = await externalProvider.retrieve({
      // db is unused on the no-URL path
      db: null as never,
      teamId: "t1",
      tier: "team",
      question: "anything",
    });
    expect(ctx).toEqual({ sources: [], structured: "", grounded: false });
  });
});
