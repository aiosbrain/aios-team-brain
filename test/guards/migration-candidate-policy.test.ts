import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UNPROMOTED_CANDIDATE as C, inspectUnpromotedCandidate, verifiedCandidateExemption, assertCandidateHasNoRelease, candidateGitFacts } from "../../scripts/migration-candidate-policy.mjs";
import { DEFAULT_TAGS, nextTagPolicy } from "../../scripts/migrate-from-existing.mjs";

const declared = ["v0.11.0", "v0.12.0"];
const known = [...declared, C.tag];
function facts(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    "rev-parse --is-shallow-repository": "false",
    [`cat-file -t refs/tags/${C.tag}`]: "tag",
    [`rev-parse refs/tags/${C.tag}`]: C.object,
    [`rev-parse refs/tags/${C.tag}^{commit}`]: C.commit,
    [`for-each-ref --format=%(contents) refs/tags/${C.tag}`]: C.annotation,
    ...overrides,
  };
  return { readGit: (args: string[]) => {
    const key = args.join(" ");
    if (!(key in values)) throw new Error(`unexpected git query ${key}`);
    return values[key];
  }, ancestor: vi.fn(() => false) };
}
const absent = () => ({ token: "synthetic-fixture", fetchImpl: vi.fn(async () => new Response(null, { status: 404 })) });

describe("exact unpromoted migration candidate", () => {
  it("requires verified publication evidence and retains all known usable tags", async () => {
    expect(() => nextTagPolicy(declared, known)).toThrow(/stale/);
    expect(() => nextTagPolicy(declared, known, { candidateExemption: C })).toThrow(/stale/);
    const local = facts();
    const api = absent();
    const candidateExemption = await verifiedCandidateExemption(declared, known, { ...local, ...api });
    expect(nextTagPolicy(declared, known, { candidateExemption }).usable).toEqual(declared);
    expect(local.ancestor).toHaveBeenCalledWith(C.commit, "HEAD");
    expect(local.ancestor).toHaveBeenCalledWith(C.commit, "refs/remotes/origin/main");
    expect(api.fetchImpl).toHaveBeenCalledWith(expect.stringMatching(/\/releases\/tags\/v0\.13\.0$/), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer synthetic-fixture", "Cache-Control": "no-cache" }), redirect: "error",
    }));
    expect(() => nextTagPolicy(declared, [...known, "v0.99.0"], { candidateExemption })).toThrow(/stale: v0\.99\.0/);
    expect(nextTagPolicy([C.tag], known, { allowPending: false, candidateExemption }).usable).toEqual([C.tag]);
    expect(nextTagPolicy([...declared, C.tag], known, { candidateExemption }).usable).toEqual(known);
    expect(() => nextTagPolicy(["v0.99.0"], known, { allowPending: false, candidateExemption })).toThrow(/unknown git tag/);
  });
  it.each([
    { usingDeclaration: false }, { declared: [...declared, C.tag] },
    { declared: ["v0.14.0"] }, { declared: [] }, { existing: declared },
  ])("never classifies an ineligible declaration %j", async variant => {
    const api = absent();
    expect(await verifiedCandidateExemption(variant.declared ?? declared, variant.existing ?? known, { ...facts(), ...api, usingDeclaration: variant.usingDeclaration ?? true })).toBeNull();
    expect(api.fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    [`cat-file -t refs/tags/${C.tag}`, "commit"],
    [`rev-parse refs/tags/${C.tag}`, "a".repeat(40)],
    [`rev-parse refs/tags/${C.tag}^{commit}`, "b".repeat(40)],
    [`for-each-ref --format=%(contents) refs/tags/${C.tag}`, "some other unpromoted validation candidate"],
  ])("does not exempt changed metadata %s", async (key, value) => {
    const api = absent();
    expect(await verifiedCandidateExemption(declared, known, { ...facts({ [key]: value }), ...api })).toBeNull();
    expect(api.fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["HEAD", "refs/remotes/origin/main"])("does not exempt a candidate reachable from %s", ref => {
    expect(inspectUnpromotedCandidate(declared, known, { ...facts(), ancestor: (_commit: string, asked: string) => asked === ref })).toBeNull();
  });
  it("fails closed on shallow or unavailable history", () => {
    expect(() => inspectUnpromotedCandidate(declared, known, facts({ "rev-parse --is-shallow-repository": "true" }))).toThrow(/complete git history/);
    expect(() => inspectUnpromotedCandidate(declared, known, { ...facts(), readGit: () => { throw new Error("git failed"); } })).toThrow(/git failed/);
    expect(() => inspectUnpromotedCandidate(declared, known, { ...facts(), ancestor: () => { throw new Error("missing ref"); } })).toThrow(/missing ref/);
  });
  it("rechecks the immutable tag after the network response", async () => {
    const local = facts();
    let changed = false;
    const readGit = (args: string[]) => changed && args.join(" ") === `rev-parse refs/tags/${C.tag}` ? "c".repeat(40) : local.readGit(args);
    await expect(verifiedCandidateExemption(declared, known, { ...local, readGit, token: "fixture", fetchImpl: async () => {
      changed = true;
      return new Response(null, { status: 404 });
    } })).rejects.toThrow(/git state changed/);
  });
  it.each([200, 401, 403, 429, 500, 302])("HTTP %s never grants an exception", async status => {
    await expect(assertCandidateHasNoRelease(C, { token: "fixture", fetchImpl: async () => new Response(null, { status }) })).rejects.toThrow();
  });
  it("missing authentication, network failure and timeout never grant an exception", async () => {
    await expect(assertCandidateHasNoRelease(C, { token: "" })).rejects.toThrow(/authenticated/);
    for (const error of [new Error("offline"), new DOMException("timeout", "TimeoutError")]) {
      await expect(assertCandidateHasNoRelease(C, { token: "fixture", fetchImpl: async () => { throw error; } })).rejects.toThrow(/unavailable/);
    }
  });
});

describe("candidate ancestry against actual Git objects", () => {
  const root = path.join(__dirname, "..", "..");
  // Optional real corpus arm: the CI unit checkout intentionally has no historical objects.
  const available = (() => { try { execFileSync("git", ["cat-file", "-e", C.object], { cwd: root, stdio: "ignore" }); return true; } catch { return false; } })();
  (available ? it : it.skip)("uses exact tag objects, correct ancestry direction, and refuses missing refs", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "migration-candidate-"));
    const run = (args: string[]) => execFileSync("git", args, { cwd: scratch, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      run(["init", "--quiet"]);
      const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
      mkdirSync(path.join(scratch, ".git", "objects", "info"), { recursive: true });
      writeFileSync(path.join(scratch, ".git", "objects", "info", "alternates"), path.join(common, "objects") + "\n");
      const main = execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], { cwd: root, encoding: "utf8" }).trim();
      run(["update-ref", "HEAD", main]);
      run(["update-ref", "refs/remotes/origin/main", main]);
      run(["update-ref", `refs/tags/${C.tag}`, C.object]);
      const real = candidateGitFacts(scratch);
      expect(inspectUnpromotedCandidate(DEFAULT_TAGS, known, real)).toEqual(C);
      run(["update-ref", "HEAD", C.commit]);
      expect(inspectUnpromotedCandidate(DEFAULT_TAGS, known, real)).toBeNull();
      run(["update-ref", "HEAD", main]);
      run(["update-ref", "refs/remotes/origin/main", C.commit]);
      expect(inspectUnpromotedCandidate(DEFAULT_TAGS, known, real)).toBeNull();
      run(["update-ref", "-d", "refs/remotes/origin/main"]);
      expect(() => inspectUnpromotedCandidate(DEFAULT_TAGS, known, real)).toThrow(/ancestry check unavailable/);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});
