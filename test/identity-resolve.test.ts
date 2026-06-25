import { describe, expect, it } from "vitest";
import { resolveMember, resolveByProviderId, type IdentityMap } from "@/lib/identity/resolve";

// Pure-logic spec for the shared identity resolver (lib/identity/resolve). Locks the
// misattribution-prevention rules so codebase contributions and cost attribution stay aligned.

function mapOf(): IdentityMap {
  return {
    byEmail: new Map([
      ["jane@acme.com", "m-jane"],
      ["jane@users.noreply.github.com", "m-jane"], // explicit alias
    ]),
    byHandle: new Map([
      ["jane", "m-jane"],
      ["bob", "m-bob"],
    ]),
    emailDomains: new Set(["acme.com"]),
    byProviderId: new Map([["slack:u123", "m-jane"]]),
  };
}

describe("resolveMember()", () => {
  it("matches an exact roster email", () => {
    expect(resolveMember(mapOf(), { email: "Jane@Acme.com" })).toBe("m-jane");
  });

  it("matches an explicit git-author alias email", () => {
    expect(resolveMember(mapOf(), { email: "jane@users.noreply.github.com" })).toBe("m-jane");
  });

  it("derives a handle from the local-part ONLY when the email domain is in the roster", () => {
    expect(resolveMember(mapOf(), { email: "bob@acme.com" })).toBe("m-bob");
  });

  it("does NOT misattribute an external email whose local-part collides with a handle", () => {
    // bob@gmail.com must not map to handle "bob" — gmail.com is not a roster domain.
    expect(resolveMember(mapOf(), { email: "bob@gmail.com" })).toBeNull();
  });

  it("resolves an explicit non-email handle key", () => {
    expect(resolveMember(mapOf(), { key: "bob" })).toBe("m-bob");
  });

  it("returns null for an unknown identity", () => {
    expect(resolveMember(mapOf(), { email: "nobody@elsewhere.io", key: "ghost" })).toBeNull();
  });
});

describe("resolveByProviderId()", () => {
  it("resolves a provider user id (case-insensitive) to a member", () => {
    expect(resolveByProviderId(mapOf(), "slack", "U123")).toBe("m-jane");
    expect(resolveByProviderId(mapOf(), "Slack", "u123")).toBe("m-jane");
  });

  it("returns null for an unmapped provider id or empty external id", () => {
    expect(resolveByProviderId(mapOf(), "slack", "U999")).toBeNull();
    expect(resolveByProviderId(mapOf(), "linear", "U123")).toBeNull(); // wrong provider
    expect(resolveByProviderId(mapOf(), "slack", "")).toBeNull();
  });
});
