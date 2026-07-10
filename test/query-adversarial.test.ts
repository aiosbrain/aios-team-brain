import { describe, expect, it } from "vitest";
import { toOrQuery, parseChannelScope } from "@/lib/query/retrieve";

/**
 * ADVERSARIAL — query-transformation limits (pure, deterministic). These probe the FTS query builder
 * `toOrQuery` for failure modes that get WORSE as the corpus grows across many channels. Where the
 * current behavior is a real gap, the test asserts the DESIRED behavior and is marked `it.fails()`
 * (per CLAUDE.md §1: a confirmed-but-unfixed gap stays green via it.fails, and flips RED — "come fix
 * me" — the moment the gap is closed). Green `it()` tests below document what the transform does WELL.
 *
 * Companion real-Postgres scenarios (crowding-out, false grounding, cap truncation, channel bleed,
 * tier isolation across channels) live in test/datamechanics/multichannel-adversarial.datamechanics.
 */

describe("short-token recall (FIXED — was Gap #1; eng-heavy channels)", () => {
  // toOrQuery used to drop every token < 3 chars, discarding the most load-bearing eng terms —
  // CI, QA, PR, S3, v2, k8 — so a query ABOUT them searched on the leftover filler. Now a 2-char
  // token is kept when it's an upper-cased acronym or carries a digit (version/product), while
  // lowercase common words (us, up, so, no) are still dropped.

  it("keeps an upper-cased 2-char acronym alongside the other terms", () => {
    expect(toOrQuery("what is the status of CI")).toBe("status or ci");
  });

  it("keeps short but meaningful acronyms (CI/PR/QA/S3)", () => {
    const terms = toOrQuery("did CI pass and is the PR ready for QA on S3?").split(" or ");
    expect(terms).toContain("ci");
    expect(terms).toContain("pr");
    expect(terms).toContain("qa");
    expect(terms).toContain("s3");
  });

  it("keeps short version identifiers (v2, k8)", () => {
    const terms = toOrQuery("is v2 deployed to k8?").split(" or ");
    expect(terms).toContain("v2");
    expect(terms).toContain("k8");
  });

  it("still drops lowercase 2-char common words (no acronym/version signal)", () => {
    // "us"/"up"/"so" are noise, not acronyms — they must NOT become OR terms. (A real term keeps
    // this off the raw-question fallback path.)
    const terms = toOrQuery("so is the deployment up for us").split(" or ");
    expect(terms).toContain("deployment");
    for (const noise of ["us", "up", "so"]) expect(terms).not.toContain(noise);
  });
});

describe("adversarial: OR-semantics trades precision for recall (multi-topic queries)", () => {
  // toOrQuery OR-joins every significant term. That's a deliberate recall win for single-topic
  // paraphrase queries, but it means a multi-topic question can't be expressed as a conjunction:
  // "the AUTH decision in the PAYMENTS project" becomes auth|decision|payments, which also matches a
  // pure-payments doc that has nothing to do with auth. At one channel this is tolerable noise; across
  // dozens of channels the top-N (capped, unranked — see the DB suite) fills with these weak matches.

  it("documents: OR-joins topics (recall bias) — no way to require ALL terms", () => {
    expect(toOrQuery("the auth decision in the payments project")).toBe(
      "auth or decision or payments or project"
    );
  });

  it.fails("SHOULD support conjunctive intent so a 2-topic query can require both topics", () => {
    // A precision-preserving transform would let "auth AND payments" narrow to docs about both.
    // Today there is no AND path — this asserts the capability we lack.
    const q = toOrQuery("auth AND payments");
    expect(q).toMatch(/auth.*and.*payments/i);
    expect(q).not.toBe("auth or payments");
  });
});

describe("adversarial: a channel name is treated as a content term, not a scope", () => {
  // "what was decided in the #payments channel" — the user means "scope to the payments channel".
  // The transform has no notion of channels: "payments" and "channel" become ordinary OR terms, so a
  // decision that merely MENTIONS payments in some other channel matches just as well. Real
  // channel-scoping (path-prefix filter) has to happen in retrieval; the DB suite proves it doesn't.

  it("documents: the channel name leaks in as a plain search term", () => {
    expect(toOrQuery("what was decided in the payments channel").split(" or ")).toContain("payments");
  });
});

describe("channel scope parsing (Gap #4 — conservative)", () => {
  it("extracts a '#channel' scope and strips it from the query", () => {
    const { channel, cleaned } = parseChannelScope("what shipped in #eng lately?");
    expect(channel).toBe("eng");
    expect(cleaned).not.toContain("#eng");
  });

  it("extracts an 'in the X channel' scope and strips the phrase", () => {
    const { channel, cleaned } = parseChannelScope("what's the latest on Atlas in the sales channel?");
    expect(channel).toBe("sales");
    expect(cleaned).not.toMatch(/sales channel/i); // channel word doesn't leak into search terms
    expect(toOrQuery(cleaned).split(" or ")).toContain("atlas");
    expect(toOrQuery(cleaned).split(" or ")).not.toContain("sales");
  });

  it("does NOT scope when 'channel' is absent (no false positives)", () => {
    expect(parseChannelScope("what's the sales pipeline forecast?").channel).toBeNull();
    expect(parseChannelScope("how do users sign in?").channel).toBeNull();
  });
});

describe("strength: recall-friendly normalization we get RIGHT", () => {
  it("drops question words + stopwords and de-dups (the recall fix that shipped)", () => {
    expect(toOrQuery("What has John been posting to Slack, and to slack again?")).toBe(
      "john or posting or slack or again"
    );
  });

  it("falls back to the raw question when nothing significant survives", () => {
    expect(toOrQuery("who is it?")).toBe("who is it?");
  });

  it("drops temporal deictics so they don't become search/grounding noise (Gap #3 support)", () => {
    // "latest"/"today"/"recent" are query intent, not content — recency is handled elsewhere.
    expect(toOrQuery("what are the latest updates today?")).toBe("updates");
    expect(toOrQuery("any recent deployment news").split(" or ")).not.toContain("recent");
  });
});
