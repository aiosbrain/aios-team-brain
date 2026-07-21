import { describe, expect, it } from "vitest";
import { parseAuthorRefs, resolveAuthors } from "@/lib/attribution/resolve-authors";
import type { IdentityMap } from "@/lib/identity/resolve";

/**
 * Spec for source-agnostic author attribution at ingest. Derived from the intent: any source's author
 * signal (structured `authors[]`, or the connectors' source-specific keys) resolves to the right roster
 * member with an honest confidence, and NEVER to a connector or the ingesting actor. Pure, no DB.
 */

const map: IdentityMap = {
  byEmail: new Map([
    ["alice@corp.com", "m-alice"],
    ["sync@corp.com", "m-connector"],
  ]),
  byHandle: new Map([
    ["bob", "m-bob"],
    ["dave", "m-dave"],
  ]),
  emailDomains: new Set(["corp.com"]),
  byProviderId: new Map([["slack:u123", "m-carol"]]),
};

describe("parseAuthorRefs — extract author signals from frontmatter", () => {
  it("prefers the structured authors[] array (the source-agnostic path)", () => {
    const refs = parseAuthorRefs({ authors: [{ role: "author", email: "alice@corp.com", external_id: "n1", provider: "notion" }] });
    expect(refs).toEqual([{ role: "author", email: "alice@corp.com", provider: "notion", externalId: "n1", handle: undefined, displayName: undefined }]);
  });
  it("preserves the connectors' source-specific keys (slack/linear/plane/git)", () => {
    expect(parseAuthorRefs({ source: "slack", author_id: "u123" })).toEqual([{ provider: "slack", externalId: "u123", role: "author" }]);
    expect(parseAuthorRefs({ source: "linear", assignee_id: "L9" })).toEqual([{ provider: "linear", externalId: "L9", role: "assignee" }]);
    expect(parseAuthorRefs({ source: "git", author: "Alice <alice@corp.com>" })[0]).toMatchObject({ email: "alice@corp.com", role: "author" });
  });
  it("falls back to a generic author_email, and returns [] when there's no signal", () => {
    expect(parseAuthorRefs({ author_email: "alice@corp.com" })[0]).toMatchObject({ email: "alice@corp.com" });
    expect(parseAuthorRefs({ source: "gdrive" })).toEqual([]);
    expect(parseAuthorRefs({})).toEqual([]);
  });
});

describe("resolveAuthors — primary member + confidence + never-a-connector", () => {
  it("resolves an exact email match with 'email' confidence", () => {
    expect(resolveAuthors(map, [{ email: "alice@corp.com" }])).toMatchObject({ memberId: "m-alice", method: "email" });
  });
  it("resolves a provider user-id with 'provider' confidence", () => {
    expect(resolveAuthors(map, [{ provider: "slack", externalId: "u123" }])).toMatchObject({ memberId: "m-carol", method: "provider" });
  });
  it("flags the soft email-local-part → team-handle guess as 'heuristic'", () => {
    expect(resolveAuthors(map, [{ email: "dave@corp.com" }])).toMatchObject({ memberId: "m-dave", method: "heuristic" });
  });
  it("picks the PRIMARY by role precedence (author > editor), keeping all resolved for multi-credit", () => {
    const res = resolveAuthors(map, [{ role: "editor", email: "alice@corp.com" }, { role: "author", handle: "bob" }]);
    expect(res.memberId).toBe("m-bob"); // author outranks editor
    expect(res.resolvedMemberIds.sort()).toEqual(["m-alice", "m-bob"]);
  });
  it("returns null + collects the unresolved when nothing maps (NOT the ingesting actor)", () => {
    const res = resolveAuthors(map, [{ email: "stranger@nowhere.com" }]);
    expect(res).toMatchObject({ memberId: null, method: "unresolved", resolvedMemberIds: [] });
    expect(res.unresolved).toEqual(["stranger@nowhere.com"]);
  });
  it("NEVER resolves to an excluded (connector) member — treats it as unresolved", () => {
    const res = resolveAuthors(map, [{ email: "sync@corp.com" }], new Set(["m-connector"]));
    expect(res.memberId).toBeNull();
    expect(res.unresolved).toEqual(["sync@corp.com"]);
  });
});
