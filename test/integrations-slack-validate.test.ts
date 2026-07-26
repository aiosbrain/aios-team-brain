import { describe, expect, it } from "vitest";
import {
  checkSlackChannel,
  checkSlackChannels,
  privateChannelRejection,
  type ChannelCheck,
} from "@/lib/integrations/slack-validate";

/**
 * Spec: an admin must not be able to ADD a private Slack channel. Everything the brain ingests is
 * readable by the whole team (there are exactly two tiers, `team` and `external`, and no stricter
 * one), so a private channel's content would become team-wide readable — which is not what "private"
 * means to the people in it.
 *
 * The load-bearing rule is the failure direction: anything we cannot resolve must NOT read as public.
 * A missing scope or a Slack outage is not consent.
 */

function fetchStub(body: unknown, status = 200): typeof fetch {
  return (async () => ({ status, json: async () => body })) as unknown as typeof fetch;
}

describe("checkSlackChannel", () => {
  it("reports a plain channel as public, with its name", async () => {
    const c = await checkSlackChannel("t", "C1", fetchStub({ ok: true, channel: { name: "general", is_private: false } }));
    expect(c).toEqual({ channelId: "C1", visibility: "public", name: "general" });
  });

  it("reports is_private as private", async () => {
    const c = await checkSlackChannel("t", "C1", fetchStub({ ok: true, channel: { name: "managers", is_private: true } }));
    expect(c.visibility).toBe("private");
  });

  it("treats a DM and a group DM as private — Slack reports those separately from is_private", async () => {
    for (const channel of [{ is_im: true }, { is_mpim: true }]) {
      const c = await checkSlackChannel("t", "D1", fetchStub({ ok: true, channel }));
      expect(c.visibility).toBe("private");
    }
  });

  it("is UNKNOWN, never public, when Slack refuses to answer", async () => {
    const c = await checkSlackChannel("t", "C1", fetchStub({ ok: false, error: "missing_scope" }));
    expect(c.visibility).toBe("unknown");
    expect(c.error).toBe("missing_scope");
  });

  it("is UNKNOWN, never public, when the request throws", async () => {
    const boom = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect((await checkSlackChannel("t", "C1", boom)).visibility).toBe("unknown");
  });
});

describe("checkSlackChannels", () => {
  it("probes every configured id", async () => {
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(url);
      return { status: 200, json: async () => ({ ok: true, channel: { name: "n" } }) };
    }) as unknown as typeof fetch;
    const out = await checkSlackChannels("t", ["C1", "C2"], f);
    expect(out).toHaveLength(2);
    expect(seen.join(" ")).toContain("channel=C1");
    expect(seen.join(" ")).toContain("channel=C2");
  });
});

describe("privateChannelRejection", () => {
  const check = (over: Partial<ChannelCheck>): ChannelCheck => ({
    channelId: "C1",
    visibility: "public",
    ...over,
  });

  it("allows a save when every channel is public", () => {
    expect(privateChannelRejection([check({}), check({ channelId: "C2" })])).toBeNull();
  });

  it("blocks the save and names the private channel so the admin recognises it", () => {
    const msg = privateChannelRejection([check({ channelId: "C9", visibility: "private", name: "managers" })]);
    expect(msg).toContain("#managers");
    expect(msg).toContain("C9");
    expect(msg).toMatch(/only syncs channels that are public/i);
  });

  it("does NOT block on an unverifiable channel — that isn't evidence of privacy", () => {
    // The ingester still fails closed on this one; blocking here would make a Slack outage or a
    // missing scope an unusable admin page.
    expect(privateChannelRejection([check({ visibility: "unknown", error: "missing_scope" })])).toBeNull();
  });
});
