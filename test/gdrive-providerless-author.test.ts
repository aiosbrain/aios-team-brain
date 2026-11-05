import { describe, expect, it } from "vitest";

import { parseAuthorRefs, resolveAuthors } from "@/lib/attribution/resolve-authors";
import type { IdentityMap } from "@/lib/identity/resolve";

/**
 * AIO-1167 R76 F4 — Google author evidence that names no provider is still GOOGLE evidence.
 *
 * Spec (Astra R75 adjudication F4). On a known `source: gdrive` item, a structured author ref without a
 * provider and a scalar `author_email` keep their Google origin and take the ONE Google authority
 * decision — exact confirmed email only, a held (unlinked/ambiguous) address bridges nowhere, a linked
 * owner that disagrees with the confirmed owner credits neither — never the generic heuristics (a
 * local part, a handle). An explicit foreign provider keeps its own path, stable ids win, and every
 * non-Google source is unchanged.
 */

const E = "shared@example.com";
const KEY = `gdrive:author-email:${E}`;

function map(over: {
  byEmail?: Array<[string, string]>;
  byHandle?: Array<[string, string]>;
  emailDomains?: string[];
  byProviderId?: Array<[string, string]>;
  states?: Array<[string, "linked" | "unlinked" | "ambiguous"]>;
  ambiguousProviderIds?: string[];
} = {}): IdentityMap {
  return {
    byEmail: new Map(over.byEmail ?? []),
    byHandle: new Map(over.byHandle ?? []),
    emailDomains: new Set(over.emailDomains ?? []),
    byProviderId: new Map(over.byProviderId ?? []),
    ambiguousEmails: new Set(),
    ambiguousProviderIds: new Set(over.ambiguousProviderIds ?? []),
    providerIdentityStates: new Map(over.states ?? []),
    activeMemberIds: new Set(["member-a", "member-b"]),
  };
}

const SHAPES = {
  "providerless structured ref": (email: string) => ({ source: "gdrive", authors: [{ email, role: "author" }] }),
  "scalar author_email": (email: string) => ({ source: "gdrive", author_email: email }),
} as const;

const credited = (identity: IdentityMap, fm: Record<string, unknown>) =>
  resolveAuthors(identity, parseAuthorRefs(fm)).memberId;

describe.each(Object.entries(SHAPES))("Google %s", (_shape, frontmatter) => {
  it("keeps its Google origin", () => {
    expect(parseAuthorRefs(frontmatter(E)).map((ref) => ref.provider)).toEqual(["gdrive"]);
  });

  it("exact confirmed email credits its owner", () => {
    expect(credited(map({ byEmail: [[E, "member-b"]] }), frontmatter(E))).toBe("member-b");
  });

  it("a canonical or equivalent unlink holds it — no bridge", () => {
    const unlinked = map({ byEmail: [[E, "member-b"]], states: [[KEY, "unlinked"]] });
    expect(credited(unlinked, frontmatter(E))).toBeNull();
    expect(credited(unlinked, frontmatter(` ${E.toUpperCase()} `))).toBeNull();
  });

  it("a linked owner that conflicts with the confirmed email owner credits neither", () => {
    const conflicted = map({ byEmail: [[E, "member-b"]], byProviderId: [[KEY, "member-a"]], states: [[KEY, "linked"]] });
    expect(credited(conflicted, frontmatter(E))).toBeNull();
  });

  it("an ambiguous Google email history holds it", () => {
    expect(credited(map({ byEmail: [[E, "member-b"]], ambiguousProviderIds: [KEY] }), frontmatter(E))).toBeNull();
  });

  it("a local-part or handle collision never credits a Google author", () => {
    const collision = map({ byHandle: [["shared", "member-a"]], emailDomains: ["example.com"] });
    expect(credited(collision, frontmatter(E))).toBeNull();
  });
});

describe("controls", () => {
  const collision = map({ byHandle: [["shared", "member-a"]], emailDomains: ["example.com"] });

  it("a providerless handle-only ref on a Drive item is not resolved by handle", () => {
    expect(credited(collision, { source: "gdrive", authors: [{ handle: "shared", role: "author" }] })).toBeNull();
  });

  it("an explicitly named foreign provider keeps its own path, and stable ids still win", () => {
    const identity = map({ byProviderId: [["github:octo", "member-a"]], byEmail: [[E, "member-b"]] });
    const fm = { source: "gdrive", authors: [{ provider: "github", external_id: "octo", email: E, role: "author" }] };
    expect(parseAuthorRefs(fm)[0].provider).toBe("github");
    expect(credited(identity, fm)).toBe("member-a");
  });

  it("non-Google sources are unchanged: the generic resolver still applies", () => {
    const scalar = { source: "notion", author_email: E };
    expect(parseAuthorRefs(scalar)[0].provider).toBeUndefined();
    expect(credited(map({ byEmail: [[E, "member-b"]] }), scalar)).toBe("member-b");
    const structured = { source: "notion", authors: [{ handle: "shared", role: "author" }] };
    expect(credited(collision, structured)).toBe("member-a");
  });
});
