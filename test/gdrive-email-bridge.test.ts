import { describe, expect, it } from "vitest";

import { parseAuthorRefs, resolveAuthors } from "@/lib/attribution/resolve-authors";
import { googleDriveContributionEvidence } from "@/lib/dashboard/gdrive-contributions";
import { googleEmailBridge, googleEmailBridgeMember, type IdentityMap } from "@/lib/identity/resolve";

/**
 * AIO-1167 R53 — the ONE Google email-bridge decision.
 *
 * Spec (Astra adjudication of the R52 final Fable MEDIUM). A Google observation's email is the only
 * evidence for a permission id nobody has decided, and for a bare-email observation. Before that email
 * bridges to a roster/alias owner, the address's own `author-email:` authority is consulted:
 *   · unlinked or ambiguous → held: no bridge (PR743, unchanged);
 *   · linked (a decided link, or a live legacy mapping — with or without a stored email) to a member
 *     who is not the address's one confirmed owner → conflict: neither member is credited;
 *   · linked owner and confirmed owner agree, or only one exists → that member;
 *   · nothing → none.
 * Exact permission authority is asked first and never replaced, a direct `author-email:` observation
 * keeps its linked owner, and `author-email:` stays non-stable: one permission id still absorbs the
 * email-only observation, two competing ids still leave it as it is.
 */

const E = "shared@example.com";
const KEY = `gdrive:author-email:${E}`;

function map(over: {
  byEmail?: Array<[string, string]>;
  ambiguousEmails?: string[];
  byProviderId?: Array<[string, string]>;
  states?: Array<[string, "linked" | "unlinked" | "ambiguous"]>;
  ambiguousProviderIds?: string[];
} = {}): IdentityMap {
  return {
    byEmail: new Map(over.byEmail ?? []),
    byHandle: new Map(),
    emailDomains: new Set(),
    byProviderId: new Map(over.byProviderId ?? []),
    ambiguousEmails: new Set(over.ambiguousEmails ?? []),
    ambiguousProviderIds: new Set(over.ambiguousProviderIds ?? []),
    providerIdentityStates: new Map(over.states ?? []),
    activeMemberIds: new Set(["member-a", "member-b"]),
  };
}

/**
 * R54: two live legacy spellings of `author-email:E` mapped to DIFFERENT members, no decided state and
 * no stored email — the map drops the owner as ambiguous — while E has one unique roster/alias owner B.
 */
const LEGACY_SPLIT = map({ byEmail: [[E, "member-b"]], ambiguousProviderIds: [KEY] });

/** `author-email:E` deliberately linked to A, while the roster/alias email E belongs to B. */
const CONFLICTED = map({
  byEmail: [[E, "member-b"]],
  byProviderId: [[KEY, "member-a"]],
  states: [[KEY, "linked"]],
});

describe("googleEmailBridge — the decision", () => {
  it("bridges an ordinary confirmed email with no Google authority to its one owner", () => {
    expect(googleEmailBridge(map({ byEmail: [[E, "member-b"]] }), ` ${E.toUpperCase()} `))
      .toEqual({ outcome: "member", memberId: "member-b" });
    expect(googleEmailBridge(map(), E)).toEqual({ outcome: "none" });
    expect(googleEmailBridge(map({ byEmail: [[E, "member-b"]] }), "")).toEqual({ outcome: "none" });
    // An ambiguous address with no authority bridges nowhere, as before.
    expect(googleEmailBridge(map({ ambiguousEmails: [E] }), E)).toEqual({ outcome: "none" });
  });

  it.each(["unlinked", "ambiguous"] as const)("an %s author-email history holds the address (PR743)", (state) => {
    expect(googleEmailBridge(map({ byEmail: [[E, "member-b"]], states: [[KEY, state]] }), E))
      .toEqual({ outcome: "held" });
  });

  it("legacy spellings of the address mapped to different members are ambiguous authority: held (R54)", () => {
    expect(googleEmailBridge(LEGACY_SPLIT, E)).toEqual({ outcome: "held" });
    expect(googleEmailBridge(LEGACY_SPLIT, ` ${E.toUpperCase()} `)).toEqual({ outcome: "held" });
    expect(googleEmailBridgeMember(LEGACY_SPLIT, E)).toBeNull();
    // Another address's ambiguity holds nothing here: the control still bridges to its roster owner.
    const elsewhere = map({ byEmail: [[E, "member-b"]], ambiguousProviderIds: ["gdrive:author-email:other@example.com"] });
    expect(googleEmailBridge(elsewhere, E)).toEqual({ outcome: "member", memberId: "member-b" });
  });

  it("a linked author-email owner that disagrees with the confirmed owner is a conflict: neither is credited", () => {
    expect(googleEmailBridge(CONFLICTED, E))
      .toEqual({ outcome: "conflict", linkedMemberId: "member-a", emailMemberId: "member-b" });
    expect(googleEmailBridgeMember(CONFLICTED, E)).toBeNull();
  });

  it("a stored email on the link that makes the address ambiguous is still a conflict, never the link alone", () => {
    const stored = map({
      ambiguousEmails: [E], byProviderId: [[KEY, "member-a"]], states: [[KEY, "linked"]],
    });
    expect(googleEmailBridge(stored, E))
      .toEqual({ outcome: "conflict", linkedMemberId: "member-a", emailMemberId: null });
  });

  it("a live legacy author-email mapping with no decided state is consulted too", () => {
    const legacy = map({ byEmail: [[E, "member-b"]], byProviderId: [[KEY, "member-a"]] });
    expect(googleEmailBridge(legacy, E).outcome).toBe("conflict");
  });

  it("a linked owner this map cannot resolve (e.g. deactivated, when linking) blocks the roster owner", () => {
    const unresolvable = map({ byEmail: [[E, "member-b"]], states: [[KEY, "linked"]] });
    expect(googleEmailBridge(unresolvable, E))
      .toEqual({ outcome: "conflict", linkedMemberId: null, emailMemberId: "member-b" });
    expect(googleEmailBridge(map({ states: [[KEY, "linked"]] }), E)).toEqual({ outcome: "none" });
  });

  it("agreeing owners, or a linked owner alone (a legacy link with no stored email), bridge to that member", () => {
    const agreeing = map({ byEmail: [[E, "member-a"]], byProviderId: [[KEY, "member-a"]], states: [[KEY, "linked"]] });
    expect(googleEmailBridge(agreeing, E)).toEqual({ outcome: "member", memberId: "member-a" });
    const alone = map({ byProviderId: [[KEY, "member-a"]], states: [[KEY, "linked"]] });
    expect(googleEmailBridge(alone, E)).toEqual({ outcome: "member", memberId: "member-a" });
  });
});

describe("every Google consumer gives the same answer (consumer parity)", () => {
  const AT = "2026-10-20T10:00:00.000Z";
  const PERMISSION = { provider: "gdrive", external_id: "permission:P", email: E, role: "editor", at: AT };
  const AUTHOR_EMAIL = { ...PERMISSION, external_id: `author-email:${E}` };
  const author = (m: IdentityMap, ref: Record<string, unknown>) => resolveAuthors(m, parseAuthorRefs({
    source: "gdrive", authors: [ref],
  }), new Set()).memberId;
  const timeline = (m: IdentityMap, contributions: Array<Record<string, unknown>>) =>
    googleDriveContributionEvidence({ source: "gdrive", title: "Doc", contributions }, "item-1", m)
      .map((row) => row.memberId);

  it("a never-decided permission id bridged only by a conflicted email credits nobody in either reader", () => {
    expect(author(CONFLICTED, PERMISSION)).toBeNull();
    expect(timeline(CONFLICTED, [PERMISSION])).toEqual([]);
    // The email-only form carries no provider authority of its own: it bridges the same way.
    expect(author(CONFLICTED, { provider: "gdrive", email: E, role: "editor" })).toBeNull();
    expect(timeline(CONFLICTED, [{ email: E, role: "editor", at: AT }])).toEqual([]);
  });

  it("ambiguous legacy author-email spellings give no fallback credit in any reader (R54)", () => {
    expect(author(LEGACY_SPLIT, PERMISSION)).toBeNull();
    expect(timeline(LEGACY_SPLIT, [PERMISSION])).toEqual([]);
    expect(author(LEGACY_SPLIT, { provider: "gdrive", email: E, role: "editor" })).toBeNull();
    expect(timeline(LEGACY_SPLIT, [{ email: E, role: "editor", at: AT }])).toEqual([]);
    // The direct author-email observation resolves to neither spelling's owner, nor to the roster owner.
    expect(author(LEGACY_SPLIT, AUTHOR_EMAIL)).toBeNull();
    expect(timeline(LEGACY_SPLIT, [AUTHOR_EMAIL])).toEqual([]);
    // An exact, independently established permission mapping keeps its authority.
    const decided = map({
      byEmail: [[E, "member-b"]], ambiguousProviderIds: [KEY],
      byProviderId: [["gdrive:permission:P", "member-a"]], states: [["gdrive:permission:P", "linked"]],
    });
    expect(author(decided, PERMISSION)).toBe("member-a");
    expect(timeline(decided, [PERMISSION])).toEqual(["member-a"]);
  });

  it("a direct author-email observation keeps its deliberately linked owner", () => {
    expect(author(CONFLICTED, AUTHOR_EMAIL)).toBe("member-a");
    expect(timeline(CONFLICTED, [AUTHOR_EMAIL])).toEqual(["member-a"]);
  });

  it("an exact permission mapping keeps its authority over a conflicted email", () => {
    const decided = map({
      byEmail: [[E, "member-b"]],
      byProviderId: [[KEY, "member-a"], ["gdrive:permission:P", "member-b"]],
      states: [[KEY, "linked"], ["gdrive:permission:P", "linked"]],
    });
    expect(author(decided, PERMISSION)).toBe("member-b");
    expect(timeline(decided, [PERMISSION])).toEqual(["member-b"]);
  });

  it("positive controls: agreeing owners, and an ordinary confirmed email, still credit", () => {
    const agreeing = map({ byEmail: [[E, "member-a"]], byProviderId: [[KEY, "member-a"]], states: [[KEY, "linked"]] });
    expect(author(agreeing, PERMISSION)).toBe("member-a");
    expect(timeline(agreeing, [PERMISSION])).toEqual(["member-a"]);
    const ordinary = map({ byEmail: [[E, "member-b"]] });
    expect(author(ordinary, PERMISSION)).toBe("member-b");
    expect(timeline(ordinary, [PERMISSION])).toEqual(["member-b"]);
  });

  it("one permission id absorbs the author-email observation, which then credits nobody — never B", () => {
    expect(timeline(CONFLICTED, [AUTHOR_EMAIL, PERMISSION])).toEqual([]);
    expect(timeline(CONFLICTED, [PERMISSION, AUTHOR_EMAIL])).toEqual([]);
  });

  it("two competing permission ids gain no uniqueness from the email mapping: the author-email row stands", () => {
    const Q = { ...PERMISSION, external_id: "permission:Q" };
    expect(timeline(CONFLICTED, [AUTHOR_EMAIL, PERMISSION, Q])).toEqual(["member-a"]);
  });
});
