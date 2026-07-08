import { describe, expect, it } from "vitest";
import { toOrQuery } from "@/lib/query/retrieve";

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

describe("adversarial: short-token recall gap (worsens with eng-heavy channels)", () => {
  // toOrQuery drops every token shorter than 3 chars. In an engineering Slack that means the most
  // load-bearing search terms — CI, QA, PR, AI, UX, S3, k8, v2, DB — are silently discarded, so a
  // query ABOUT them searches on the leftover filler words instead. This is invisible today (one
  // low-volume channel) and becomes a routine "why didn't it find the CI outage thread?" at scale.

  it("KNOWN GAP: a 2-char acronym is dropped from the FTS query", () => {
    // "what is the status of CI" → only "status" survives; "ci" is gone.
    // This documents (pins) the current lossy behavior so the fix below is legible.
    expect(toOrQuery("what is the status of CI")).toBe("status");
  });

  it.fails("SHOULD keep short but meaningful acronyms (CI/QA/PR/AI/S3)", () => {
    const terms = toOrQuery("did CI pass and is the PR ready for QA on S3?").split(" or ");
    // desired: the acronyms are searchable terms, not discarded
    expect(terms).toContain("ci");
    expect(terms).toContain("pr");
    expect(terms).toContain("qa");
    expect(terms).toContain("s3");
  });

  it.fails("SHOULD keep short version identifiers (v2, k8)", () => {
    const terms = toOrQuery("is v2 deployed to k8?").split(" or ");
    expect(terms).toContain("v2");
    expect(terms).toContain("k8");
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

describe("strength: recall-friendly normalization we get RIGHT", () => {
  it("drops question words + stopwords and de-dups (the recall fix that shipped)", () => {
    expect(toOrQuery("What has John been posting to Slack, and to slack again?")).toBe(
      "john or posting or slack or again"
    );
  });

  it("falls back to the raw question when nothing significant survives", () => {
    expect(toOrQuery("who is it?")).toBe("who is it?");
  });
});
