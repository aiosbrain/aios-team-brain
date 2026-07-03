import { describe, expect, it } from "vitest";
import { normalizeRepo, addRepo, removeRepo, RepoFormatError } from "./github-repos";

/**
 * Spec: the GitHub repos panel manages a team's `config.repos` list. Users may paste a bare
 * `owner/repo` OR a github.com URL; the list is de-duplicated case-insensitively (GitHub owner/repo
 * are case-insensitive) and stored immutably. Bad input is rejected with a clear error, never
 * silently dropped — the panel surfaces the message.
 */

describe("normalizeRepo", () => {
  it("accepts a bare owner/repo and preserves case", () => {
    expect(normalizeRepo("Acme/Api")).toBe("Acme/Api");
  });

  it("extracts owner/repo from a github URL and strips .git / trailing slash", () => {
    expect(normalizeRepo("https://github.com/acme/api.git")).toBe("acme/api");
    expect(normalizeRepo("https://github.com/acme/api/")).toBe("acme/api");
    expect(normalizeRepo("github.com/acme/web")).toBe("acme/web");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeRepo("  acme/infra  ")).toBe("acme/infra");
  });

  it("rejects malformed input with RepoFormatError", () => {
    for (const bad of ["", "acme", "acme/", "/repo", "acme/api/extra", "a b/c d", "acme repo"]) {
      expect(() => normalizeRepo(bad), `should reject ${JSON.stringify(bad)}`).toThrow(RepoFormatError);
    }
  });
});

describe("addRepo", () => {
  it("appends a valid repo without mutating the input array", () => {
    const before = ["acme/api"];
    const after = addRepo(before, "acme/web");
    expect(after).toEqual(["acme/api", "acme/web"]);
    expect(before).toEqual(["acme/api"]); // immutable
  });

  it("de-duplicates case-insensitively (keeps the existing entry)", () => {
    expect(addRepo(["acme/api"], "ACME/API")).toEqual(["acme/api"]);
  });

  it("throws on malformed input", () => {
    expect(() => addRepo([], "not-a-repo")).toThrow(RepoFormatError);
  });
});

describe("removeRepo", () => {
  it("removes the matching repo case-insensitively, immutably", () => {
    const before = ["acme/api", "acme/web"];
    const after = removeRepo(before, "ACME/API");
    expect(after).toEqual(["acme/web"]);
    expect(before).toEqual(["acme/api", "acme/web"]); // immutable
  });

  it("is a no-op when the repo is absent", () => {
    expect(removeRepo(["acme/api"], "acme/other")).toEqual(["acme/api"]);
  });
});
