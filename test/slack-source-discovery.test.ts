import { describe, expect, it } from "vitest";

import {
  classifySlackCall,
  needsSlackPublicProof,
  slackWorkspaceUrl,
  validateSlackHistoryPage,
  SLACK_METADATA_INTERVAL_MS,
  type SlackHistoryPageValidation,
} from "@/lib/ingest/slack-source-discovery";
import {
  canonicalSlackChannelIds,
  resolveEnvSlackToken,
  slackConfigRevision,
} from "@/lib/ingest/slack-source-binding";
import type { SlackPage } from "@/lib/ingest/sources/slack-page-request";

/**
 * AIO-1170 — the PURE halves of source discovery: what a history page is allowed to certify, how a
 * transport outcome maps to a source disposition, and how a selection's cache-validity stamps are
 * computed. No database, no provider.
 */

function page(over: Partial<SlackPage> = {}): SlackPage {
  return { messages: [], hasMore: false, nextCursor: null, ...over };
}

function ok(result: SlackHistoryPageValidation): Extract<SlackHistoryPageValidation, { ok: true }> {
  if (!result.ok) throw new Error(`expected a valid page, got ${result.category}`);
  return result;
}

describe("validateSlackHistoryPage", () => {
  it("takes every top-level root in page order, whatever it contains", () => {
    const result = ok(
      validateSlackHistoryPage(
        page({
          messages: [
            { ts: "1718900000.000400", subtype: "tombstone", text: "This message was deleted." },
            { ts: "1718900000.000300" },
            { ts: "1718900000.000200", thread_ts: "1718900000.000200", reply_count: 2 },
            { ts: "1718900000.000150", thread_ts: "1718900000.000100" },
            { ts: "1718900000.000100", text: "hello" },
          ],
        }),
        { sentCursor: null }
      )
    );

    // Structural only: no author, text, subtype or reply-count filter can discard discovery work.
    expect(result.roots).toEqual([
      "1718900000.000400",
      "1718900000.000300",
      "1718900000.000200",
      "1718900000.000100",
    ]);
    // …and the oldest instant on the page, which is what a completed interval is measured to.
    expect(result.oldestTs).toBe("1718900000.000100");
  });

  it("keeps a `ts` byte-exact, never re-rendered from a parsed number", () => {
    const padded = "0001718900000.000100";
    const result = ok(validateSlackHistoryPage(page({ messages: [{ ts: padded }] }), { sentCursor: null }));
    // Zero-padding is the provider's spelling of a thread identity: normalizing it here would mint a
    // path and a queue key for a thread that does not exist.
    expect(result.roots).toEqual([padded]);
  });

  it("accepts a consistent EMPTY page — an empty range is provider data", () => {
    const result = ok(validateSlackHistoryPage(page({ messages: [] }), { sentCursor: null }));
    expect(result.roots).toEqual([]);
    expect(result.oldestTs).toBeNull();
    expect(result.hasMore).toBe(false);
  });

  it("refuses the WHOLE page when any message cannot be placed", () => {
    for (const messages of [
      [{ ts: "1718900000.000100" }, { ts: "not-a-timestamp" }],
      [{ ts: "1718900000.000100" }, { ts: "" }],
      [{ ts: "1718900000.000100" }, {} as { ts: string }],
      [{ ts: "1718900000.000100", thread_ts: "nonsense" }],
    ]) {
      const result = validateSlackHistoryPage(page({ messages }), { sentCursor: null });
      // NOT "the readable half": dropping a message while certifying its interval is how a real
      // root disappears inside a range we later claim to have read completely.
      expect(result).toMatchObject({ ok: false, category: "malformed_timestamp" });
    }
  });

  it("refuses a page whose paging cannot be continued or is looping", () => {
    expect(validateSlackHistoryPage(page({ hasMore: true, nextCursor: null }), { sentCursor: null })).toMatchObject(
      { ok: false, category: "pagination_incomplete" }
    );
    expect(
      validateSlackHistoryPage(page({ hasMore: true, nextCursor: "same" }), { sentCursor: "same" })
    ).toMatchObject({ ok: false, category: "cursor_repeated" });
  });

  it("refuses a response that carried no `messages` field at all", () => {
    // `conversations.history` always answers with a messages array. ABSENT is not `[]`: the
    // transport preserves that difference precisely so this reading — "no messages, therefore an
    // empty range I may certify" — is impossible here.
    expect(validateSlackHistoryPage({ hasMore: false, nextCursor: null }, { sentCursor: null })).toMatchObject({
      ok: false,
      category: "malformed_page",
    });
  });
});

describe("classifySlackCall", () => {
  it("maps every transport outcome to a disposition, and invents no retry time", () => {
    expect(classifySlackCall({ outcome: "ok", method: "auth.test", body: { ok: true }, page: page() })).toMatchObject({
      kind: "ok",
    });
    expect(
      classifySlackCall({
        outcome: "deferred",
        method: "auth.test",
        nextPermittedAt: "2026-01-01T00:00:00.000Z",
        retryAfterMs: 1000,
      })
    ).toMatchObject({ kind: "deferred", nextPermittedAt: "2026-01-01T00:00:00.000Z" });
    expect(
      classifySlackCall({
        outcome: "rate_limited",
        method: "auth.test",
        category: "rate_limited",
        nextPermittedAt: "2026-01-01T00:00:00.000Z",
        retryAfterMs: 1000,
      })
    ).toMatchObject({ kind: "transient", category: "rate_limited", nextPermittedAt: "2026-01-01T00:00:00.000Z" });

    // ⚠️ A DURABLE BLOCK IS NOT A LONG COOLDOWN. The bucket's marker is owned by the request layer,
    // is never cleared by a token or config change, and carries no deadline — so this disposition
    // must not acquire one on the way out.
    const blocked = classifySlackCall({
      outcome: "blocked",
      method: "auth.test",
      category: "retry_after_unrepresentable",
    });
    expect(blocked).toEqual({ kind: "blocked", category: "retry_after_unrepresentable" });

    expect(
      classifySlackCall({ outcome: "auth_error", method: "auth.test", category: "missing_scope" })
    ).toMatchObject({ kind: "blocked", category: "missing_scope" });
    expect(
      classifySlackCall({ outcome: "transport_error", method: "auth.test", category: "timeout" })
    ).toMatchObject({ kind: "transient", category: "timeout" });
  });

  it("splits provider errors by what a caller can do about them", () => {
    // Retryable provider faults are transient…
    for (const category of ["ratelimited", "internal_error", "service_unavailable", "request_timeout", "fatal_error"]) {
      expect(classifySlackCall({ outcome: "provider_error", method: "conversations.history", category })).toMatchObject(
        { kind: "transient", category }
      );
    }
    // …everything else is a stated refusal, which a timer cannot fix.
    for (const category of ["channel_not_found", "not_in_channel", "invalid_cursor", "provider_error"]) {
      expect(classifySlackCall({ outcome: "provider_error", method: "conversations.history", category })).toMatchObject(
        { kind: "refused", category }
      );
    }
  });
});

describe("the effective selection", () => {
  it("resolves both env aliases, the canonical spelling first", () => {
    expect(resolveEnvSlackToken({ SLACK_BOT_TOKEN: "a", slack_bot_token: "b" })).toBe("a");
    expect(resolveEnvSlackToken({ slack_bot_token: "b" })).toBe("b");
    expect(resolveEnvSlackToken({})).toBeNull();
    // A blank env var is not a token; treating it as one produces an unauthenticated request.
    expect(resolveEnvSlackToken({ SLACK_BOT_TOKEN: "   " })).toBeNull();
  });

  it("canonicalizes the channel selection and REPORTS what it refuses", () => {
    const { selected, rejected } = canonicalSlackChannelIds({ channelIds: ["C2", "C1", "C2", "bad id", ""] });
    expect(selected).toEqual(["C1", "C2"]);
    // Silently dropping a malformed id would make a channel simply never sync, with nothing to see.
    expect(rejected).toEqual(["bad id", ""]);
  });

  it("changes the revision when the selection or the row changes, and not otherwise", () => {
    const base = {
      updatedAt: "2026-09-09T00:00:00.000Z",
      status: "enabled",
      type: "slack",
      channelIds: ["C1", "C2"],
    };
    const revision = slackConfigRevision(base);
    // Re-ordering is the SAME selection: an invalidation there would re-bootstrap for nothing.
    expect(slackConfigRevision({ ...base, channelIds: ["C2", "C1"] })).toBe(revision);
    expect(slackConfigRevision({ ...base, channelIds: ["C1"] })).not.toBe(revision);
    expect(slackConfigRevision({ ...base, updatedAt: "2026-09-09T00:00:01.000Z" })).not.toBe(revision);
    expect(slackConfigRevision({ ...base, status: "disabled" })).not.toBe(revision);
    expect(revision).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("slackWorkspaceUrl", () => {
  // This is URL INTEGRITY for a stored permalink base — not an SSRF control. Nothing in this slice
  // fetches the stored value; what it must not do is record a link that points somewhere else.
  it("canonicalizes a workspace ROOT under .slack.com", () => {
    // The shape Slack's own auth.test reference documents.
    expect(slackWorkspaceUrl("https://acme.slack.com/")).toBe("https://acme.slack.com/");
    // A missing trailing slash is the same root; an explicit default port is the same origin.
    expect(slackWorkspaceUrl("https://acme.slack.com")).toBe("https://acme.slack.com/");
    expect(slackWorkspaceUrl("https://acme.slack.com:443/")).toBe("https://acme.slack.com/");
    // Host case is not identity; the stored value is the normalized one, never the original bytes.
    expect(slackWorkspaceUrl("https://ACME.slack.com/")).toBe("https://acme.slack.com/");
    expect(slackWorkspaceUrl("https://work-space-1.slack.com/")).toBe("https://work-space-1.slack.com/");
  });

  it("refuses every host that is not exactly one label under .slack.com", () => {
    for (const value of [
      "https://example.invalid/",
      // The suffix trick: `.slack.com` appears, and the registrable domain is somebody else's.
      "https://acme.slack.com.evil.invalid/",
      // A nested label is a deep host, not a workspace root — one label, no more.
      "https://nested.foo.slack.com/",
      "https://slack.com/",
      "https://-acme.slack.com/",
      "https://127.0.0.1/",
      "https://localhost/",
    ]) {
      expect(slackWorkspaceUrl(value)).toBeNull();
    }
  });

  it("refuses credentials, a non-default port, a non-root path, a query or a fragment", () => {
    for (const value of [
      // Credentials in a stored link would be a credential in every log that renders it.
      "https://user:secret@acme.slack.com/",
      "https://user@acme.slack.com/",
      "https://acme.slack.com:8443/",
      "https://acme.slack.com/archives/C0SOURCE1",
      "https://acme.slack.com/?redirect=https://evil.invalid",
      "https://acme.slack.com/#/somewhere",
      "http://acme.slack.com/",
      "ftp://acme.slack.com/",
      "acme.slack.com",
      "",
      "   ",
    ]) {
      expect(slackWorkspaceUrl(value)).toBeNull();
    }
    for (const value of [null, undefined, 42, {}, ["https://acme.slack.com/"]]) {
      expect(slackWorkspaceUrl(value)).toBeNull();
    }
  });
});

describe("needsSlackPublicProof", () => {
  const REF = { integrationId: "i-1", configRevision: "r-1" };
  const NOW = Date.parse("2026-09-09T12:00:00.000Z");
  const proof = (over: Partial<Parameters<typeof needsSlackPublicProof>[0]> = {}) => ({
    publicState: "public" as const,
    publicCheckedAt: "2026-09-09T11:59:00.000Z",
    bindingIntegrationId: "i-1",
    bindingConfigRevision: "r-1",
    ...over,
  });

  it("reuses a proof made under this binding, inside the cadence", () => {
    expect(needsSlackPublicProof(proof(), REF, NOW, SLACK_METADATA_INTERVAL_MS)).toBe(false);
  });

  it("re-observes when there is no proof, or none this binding made", () => {
    expect(
      needsSlackPublicProof(
        proof({ publicState: "unknown", publicCheckedAt: null }),
        REF,
        NOW,
        SLACK_METADATA_INTERVAL_MS
      )
    ).toBe(true);
    expect(needsSlackPublicProof(proof({ publicCheckedAt: null }), REF, NOW, SLACK_METADATA_INTERVAL_MS)).toBe(true);
    expect(
      needsSlackPublicProof(proof({ bindingIntegrationId: "i-2" }), REF, NOW, SLACK_METADATA_INTERVAL_MS)
    ).toBe(true);
    expect(
      needsSlackPublicProof(proof({ bindingConfigRevision: "r-2" }), REF, NOW, SLACK_METADATA_INTERVAL_MS)
    ).toBe(true);
    // A definitive refusal is re-observed on the same cadence: a channel can become public again.
    expect(
      needsSlackPublicProof(
        proof({ publicState: "private", publicCheckedAt: "2026-09-09T10:00:00.000Z" }),
        REF,
        NOW,
        SLACK_METADATA_INTERVAL_MS
      )
    ).toBe(true);
  });

  it("takes the cadence from its ARGUMENT — no interval is baked into the decision", () => {
    const aged = proof({ publicCheckedAt: "2026-09-09T11:15:00.000Z" }); // 45 minutes old
    // The default cadence is the existing scheduled observation interval, not an invented TTL…
    expect(SLACK_METADATA_INTERVAL_MS).toBe(30 * 60 * 1000);
    expect(needsSlackPublicProof(aged, REF, NOW, SLACK_METADATA_INTERVAL_MS)).toBe(true);
    // …and a caller that configures a longer one gets a longer one. A constant read straight from
    // the module would make this pair impossible to write, which is the point of the parameter.
    expect(needsSlackPublicProof(aged, REF, NOW, 6 * 60 * 60 * 1000)).toBe(false);
    // The boundary is inclusive: exactly one cadence old is due.
    expect(
      needsSlackPublicProof(
        proof({ publicCheckedAt: new Date(NOW - SLACK_METADATA_INTERVAL_MS).toISOString() }),
        REF,
        NOW,
        SLACK_METADATA_INTERVAL_MS
      )
    ).toBe(true);
  });
});
