import { describe, expect, it } from "vitest";
import {
  assessPackageInventory,
  classifyTagReadback,
  hasNextPage,
  listPackageVersions,
  normalizeVersion,
  readPackageIdentity,
  reconcilePackageInventory,
} from "../scripts/staging-ops/image-audit/registry.mjs";
import { SUBJECT } from "../scripts/staging-ops/image-audit/subject.mjs";
import { sha256 } from "../scripts/staging-ops/image-audit/layers.mjs";
import { EXPECTED_REGISTRY_ORIGIN, recipeEvidence } from "../scripts/staging-ops/image-audit/recipe.mjs";
import { syntheticSecret } from "./helpers/tar-fixture";

/** The shapes this file reads back. Narrow local types, so no fixture needs `any`. */
interface RecipeAssertion {
  id: string;
  status: "satisfied" | "violated" | "unverified";
  detail: string;
}
interface PackageVersion {
  digest: string;
  untagged: boolean;
}

/**
 * PUB-05's inventory rows and M3's recipe rows.
 *
 * THE FAILURE MODE UNDER TEST: an unreadable list and an empty list produce the same array. Every
 * case below asks whether the code can tell them apart, because the consequence of getting it wrong
 * is exposing an unaudited digest in the same package — and the transition is irreversible.
 */

const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}`;
const AUDITED = SUBJECT.digest;

/**
 * `readPackageIdentity`'s CONFIRMED answer, as `assessPackageInventory` consumes it.
 *
 * Passed explicitly by every case that is about the VERSIONS read, because the identity read is a
 * separate measurement and an absent one is now unverified (it used to skip the check entirely and
 * reach the verified route — "we did not measure it" treated better than "we measured it and it
 * failed"). Stating it here keeps each case below about one condition.
 */
const IDENTIFIED = Object.freeze({
  status: "verified",
  visibility: "private",
  linkage: SUBJECT.repository,
  expectedVisibility: "private",
  expectedLinkage: SUBJECT.repository,
});

function page(body: unknown, { next = false, status = 200 } = {}) {
  return {
    status,
    headers: { get: (name: string) => (name === "link" && next ? '<https://api.github.com/...&page=2>; rel="next"' : null) },
    json: async () => body,
  };
}

const version = (name: string, tags: string[] | undefined, id = 1) => ({ id, name, metadata: { container: { tags } } });

describe("package version pagination is walked to its end (PUB-05)", () => {
  it("follows the `next` link and returns every page's versions", async () => {
    const pages = [
      page([version(AUDITED, ["sha-abc-run-1.1"], 1)], { next: true }),
      page([version(digest("b"), [], 2)], { next: false }),
    ];
    const result = await listPackageVersions({ token: "t", fetchImpl: async () => pages.shift() });
    expect(result.status).toBe("verified");
    expect(result.pages).toBe(2);
    expect(result.versions.map((v: PackageVersion) => v.digest)).toEqual([AUDITED, digest("b")]);
  });

  /** THE MUTANT: stopping after page one. It returns a plausible, complete-looking, wrong inventory. */
  it("an UNTAGGED version on a later page still blocks the transition", async () => {
    const pages = [
      page([version(AUDITED, ["sha-abc-run-1.1"], 1)], { next: true }),
      page([version(digest("c"), undefined, 2)], { next: false }),
    ];
    const inventory = await listPackageVersions({ token: "t", fetchImpl: async () => pages.shift() });
    const assessment = assessPackageInventory(inventory, AUDITED, IDENTIFIED);
    expect(assessment.status).toBe("verified");
    expect(assessment.untagged).toBe(1);
    expect(assessment.otherVersions).toBe(1);
    // Named exactly, because the answer to "what else is in this package" has to be actionable.
    expect(assessment.additionalSubjects).toEqual([digest("c")]);
  });

  it("marks an untagged version untagged whether tags are [] or absent", () => {
    expect(normalizeVersion(version(AUDITED, [])).untagged).toBe(true);
    expect(normalizeVersion(version(AUDITED, undefined)).untagged).toBe(true);
    expect(normalizeVersion(version(AUDITED, ["x"])).untagged).toBe(false);
  });

  it("parses the `next` relation without matching `prev`/`last`", () => {
    expect(hasNextPage('<https://x?page=2>; rel="next"')).toBe(true);
    expect(hasNextPage('<https://x?page=1>; rel="prev", <https://x?page=9>; rel="last"')).toBe(false);
    expect(hasNextPage(null)).toBe(false);
  });
});

describe("an unreadable inventory is UNVERIFIED, never an empty package (PUB-05)", () => {
  it("returns unverified for a 403 and carries NO version list", async () => {
    const result = await listPackageVersions({ token: "t", fetchImpl: async () => page([], { status: 403 }) });
    expect(result.status).toBe("unverified");
    // The whole defect in one assertion: no `versions` key at all, so nothing downstream can count
    // zero and conclude the package holds only the audited digest.
    expect(result.versions).toBeUndefined();
    expect(result.reason).toMatch(/not evidence of an empty package/);
  });

  it("returns unverified for 404, a transport error, a non-array body and an unparseable body", async () => {
    const cases = [
      async () => page([], { status: 404 }),
      async () => { throw new Error("network down"); },
      async () => page({ message: "nope" }),
      async () => ({ status: 200, headers: { get: () => null }, json: async () => { throw new Error("bad json"); } }),
    ];
    for (const fetchImpl of cases) {
      expect((await listPackageVersions({ token: "t", fetchImpl })).status).toBe("unverified");
    }
  });

  it("returns unverified with no token, rather than attempting an anonymous read", async () => {
    expect((await listPackageVersions({})).status).toBe("unverified");
  });

  it("refuses to walk forever, and reports the bound as unverified", async () => {
    const result = await listPackageVersions({ token: "t", fetchImpl: async () => page([version(AUDITED, [])], { next: true }) });
    expect(result.status).toBe("unverified");
    expect(result.reason).toMatch(/page bound/);
  });

  it("is unverified when the audited digest is not in the package's own inventory", () => {
    const assessment = assessPackageInventory(
      { status: "verified", versions: [normalizeVersion(version(digest("d"), []))], pages: 1 },
      AUDITED,
      IDENTIFIED,
    );
    expect(assessment.status).toBe("unverified");
    expect(assessment.reason).toMatch(/does not appear in the package/);
  });

  it("carries the API status through as unverified when the read failed", () => {
    const assessment = assessPackageInventory({ status: "unverified", reason: "403" }, AUDITED, IDENTIFIED);
    expect(assessment).toMatchObject({ apiStatus: "unverified", status: "unverified", source: "actions-api" });
    expect(assessment.otherVersions).toBeUndefined();
  });

  /**
   * F4's wiring, at the ARGUMENT rather than at the function.
   *
   * The guard read `identity !== undefined && identity?.status !== "verified"`, so a caller that
   * passed no metadata at all skipped it and could reach the VERIFIED route on a versions list alone
   * — which cannot establish that the enumerated package is the private one linked to this
   * repository. Undefined is the same answer as unverified, and it says which one it was.
   */
  it("treats UNDEFINED identity metadata as unverified, never as the verified route", () => {
    const inventory = { status: "verified", versions: [normalizeVersion(version(AUDITED, []))], pages: 1 };
    // The positive control FIRST: with the metadata read, this exact inventory IS verified. Without
    // it the only difference between the two calls is the argument under test.
    expect(assessPackageInventory(inventory, AUDITED, IDENTIFIED).status).toBe("verified");

    const unmeasured = assessPackageInventory(inventory, AUDITED);
    expect(unmeasured.status).toBe("unverified");
    expect(unmeasured.identityStatus).toBe("unverified");
    expect(unmeasured.reason).toMatch(/identity\/visibility\/linkage was not established: not measured/);
    // The versions walk really did succeed — reported as measured, so a coordinator can see that the
    // block is about the metadata read and not about the pages.
    expect(unmeasured.apiStatus).toBe("verified");
    // …and no count is offered from an unverified route, which is what would let a reader conclude
    // "one version, the audited one, safe to expose".
    expect(unmeasured.otherVersions).toBeUndefined();
  });

  it("is unverified when the metadata read itself failed", () => {
    const inventory = { status: "verified", versions: [normalizeVersion(version(AUDITED, []))], pages: 1 };
    const assessment = assessPackageInventory(inventory, AUDITED, { status: "unverified", reason: "404 — absent OR invisible" });
    expect(assessment.status).toBe("unverified");
    expect(assessment.identityStatus).toBe("unverified");
  });
});

/**
 * PUB-04 at the registry boundary: a transport error's own message is the library's, and it quotes
 * the URL, the proxy and occasionally a certificate subject. These reasons are written into the
 * PUBLIC evidence artifact as `packageInventory.reason`.
 */
describe("a transport failure is reported by FIXED reason, never by the error's message", () => {
  it("keeps the thrown message out of both the versions read and the metadata read", async () => {
    const marker = syntheticSecret("proxy_");
    const throwing = async () => { throw new Error(`connect ECONNREFUSED via ${marker}`); };

    const versions = await listPackageVersions({ token: "t", fetchImpl: throwing });
    expect(versions.status).toBe("unverified");
    expect(versions.reason).not.toContain(marker);
    // Still says WHICH page, because the page number is this walk's own counter rather than the
    // library's text — a fixed reason has to stay diagnostic to be worth writing.
    expect(versions.reason).toMatch(/transport error on page 1/);

    const identity = await readPackageIdentity({ token: "t", fetchImpl: throwing });
    expect(identity.status).toBe("unverified");
    expect(identity.reason).not.toContain(marker);
    expect(identity.reason).toMatch(/transport error/);
  });
});

/**
 * PUB-05's alternate path. THE FIXTURES HERE WERE STALE, and the staleness is the lesson: they were
 * written against an earlier operator shape (`digests: [...]`) and the function was later tightened
 * to require full version ROWS (`{ id, digest, tags }`), a stated visibility, this repository's
 * linkage and a caller-bound `subjectDigest`. The old fixtures then failed for reasons that had
 * nothing to do with what each case was named for — and the two positive ones failed outright.
 *
 * So every case below starts from ONE complete, valid record and breaks exactly one field, and each
 * asserts the failure it is named for. A case that merely comes back rejected proves only that
 * something was wrong with it.
 */
describe("operator-supplied evidence can satisfy the gate WITHOUT rewriting the API result (PUB-05)", () => {
  const failed = assessPackageInventory({ status: "unverified", reason: "403 on page 1" }, AUDITED, IDENTIFIED);
  const bound = { subjectDigest: AUDITED };

  /** A complete administrator inventory for the pinned subject. Each case below breaks one field. */
  const operator = (overrides: Record<string, unknown> = {}) => ({
    capturedAt: "2026-09-09T18:00:00Z",
    coversAllPages: true,
    coversUntagged: true,
    auditedDigest: AUDITED,
    visibility: "private",
    repositoryLinkage: SUBJECT.repository,
    versions: [{ id: 41, digest: AUDITED, tags: [] }],
    ...overrides,
  });

  it("accepts a complete, timestamped, full-digest inventory", () => {
    const reconciled = reconcilePackageInventory(failed, operator(), bound);
    expect(reconciled.status).toBe("verified");
    expect(reconciled.otherVersions).toBe(0);
    expect(reconciled.total).toBe(1);
    expect(reconciled.untagged).toBe(1);
    // The row an administrator would have to act on, not just the content it holds.
    expect(reconciled.operatorEvidence).toMatchObject({ accepted: true, versionIds: ["41"] });
    // THE PROPERTY A SHORTCUT WOULD LOSE: the workflow's own read still reads as failed. Anyone
    // reading this record later can see the gate stood on operator evidence, not on the API.
    expect(reconciled.apiStatus).toBe("unverified");
    expect(reconciled.source).toBe("operator-evidence");
  });

  it("rejects each missing or malformed field, for its OWN reason", () => {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      // A truncated digest is what a screenshot of the packages page actually shows. Listed BESIDE
      // the valid subject row, so the pinned-digest-present check cannot be what fails.
      ["truncated digest", { versions: [{ id: 1, digest: AUDITED, tags: [] }, { id: 2, digest: "sha256:0005824", tags: [] }] }, /no full sha256 digest/],
      ["no version id", { versions: [{ digest: AUDITED, tags: [] }] }, /no numeric version id/],
      ["tags absent rather than empty", { versions: [{ id: 1, digest: AUDITED }] }, /do not state their tags/],
      ["no page attestation", { coversAllPages: undefined }, /every page was covered/],
      ["no untagged attestation", { coversUntagged: undefined }, /untagged versions were included/],
      ["no capture timestamp", { capturedAt: undefined }, /ISO-8601 capture timestamp/],
      ["a capture timestamp that is not ISO-8601", { capturedAt: "yesterday" }, /ISO-8601 capture timestamp/],
      ["no versions at all", { versions: [] }, /lists no package versions/],
      ["no stated visibility", { visibility: undefined }, /measured visibility/],
      ["another repository's linkage", { repositoryLinkage: "someone-else/repo" }, /this repository as the package's linkage/],
      ["a different audited digest", { auditedDigest: digest("f") }, /different audited digest than the pinned subject/],
      ["the pinned subject absent from the list", { versions: [{ id: 9, digest: digest("e"), tags: [] }] }, /does not list the pinned subject digest/],
    ];
    for (const [label, broken, reason] of cases) {
      const reconciled = reconcilePackageInventory(failed, operator(broken), bound);
      expect(reconciled.status, `${label} was accepted`).toBe("unverified");
      expect(reconciled.operatorEvidence.accepted).toBe(false);
      // The named failure, not merely A failure: a case that passes on someone else's condition is
      // a case that proves nothing about the condition it is named for.
      expect(reconciled.operatorEvidence.failures.join(" "), `${label} failed for another reason`).toMatch(reason);
    }
  });

  /** The CALLER's binding, which is the one thing an operator record must not be able to supply. */
  it("refuses a reconciliation that was not bound to the pinned subject digest", () => {
    const reconciled = reconcilePackageInventory(failed, operator(), {});
    expect(reconciled.status).toBe("unverified");
    expect(reconciled.operatorEvidence.failures.join(" ")).toMatch(/not bound to a pinned subject digest/);
  });

  it("still blocks when the operator's own inventory lists another digest", () => {
    const reconciled = reconcilePackageInventory(failed, operator({
      versions: [{ id: 41, digest: AUDITED, tags: [] }, { id: 42, digest: digest("e"), tags: ["latest"] }],
    }), bound);
    expect(reconciled.otherVersions).toBe(1);
    expect(reconciled.additionalSubjects).toEqual([digest("e")]);
    // Tagged, so the untagged count is the audited row alone — a count that moved with the wrong
    // versions would be the quiet way an extra subject disappears.
    expect(reconciled.untagged).toBe(1);
  });

  it("leaves the assessment untouched when no operator evidence exists", () => {
    expect(reconcilePackageInventory(failed, undefined)).toBe(failed);
  });
});

describe("the original receipt tag readback (L1)", () => {
  it("confirms ONLY for bytes that actually hash to the pinned digest", () => {
    const bytes = Buffer.from('{"mediaType":"application/vnd.oci.image.manifest.v1+json"}');
    // There is no "confirmed" argument to pass: the only way to make this confirm is to hand it
    // bytes whose own sha256 IS the digest, so the fixture computes the digest from the bytes.
    expect(classifyTagReadback(bytes, sha256(bytes))).toMatchObject({ status: "confirmed", digest: sha256(bytes) });
    // …and the real pinned subject's digest is not that, which is what makes the assertion above a
    // check rather than a tautology about whatever was passed in.
    expect(sha256(bytes)).not.toBe(SUBJECT.digest);
  });

  it("reports a MISMATCH without changing the audit subject", () => {
    const outcome = classifyTagReadback(Buffer.from("some other manifest"), SUBJECT.digest);
    expect(outcome.status).toBe("mismatch");
    // A tag is mutable and a digest is not. A moved tag is evidence about the tag; it must never
    // select a new artifact to inspect.
    expect(outcome.reason).toMatch(/the audit subject is unchanged/);
  });

  it("reports an unreadable tag as unverified, not as absent", () => {
    expect(classifyTagReadback(undefined, SUBJECT.digest).status).toBe("unverified");
    expect(classifyTagReadback(Buffer.alloc(0), SUBJECT.digest).status).toBe("unverified");
  });
});

describe("recipe assertions are measured, and capped honestly (M3)", () => {
  const publisher = [
    "on:\n  workflow_dispatch:",
    "      - uses: actions/checkout@abc\n        with:\n          persist-credentials: false",
    "      - uses: docker/build-push-action@def\n        with:\n          context: .",
  ].join("\n");

  const statuses = (evidence: { assertions: RecipeAssertion[] }) =>
    Object.fromEntries(evidence.assertions.map((a) => [a.id, a.status]));

  it("records satisfied rows for a recipe with no secret, arg or mount", () => {
    const evidence = recipeEvidence({
      ".github/workflows/staging-ops-image.yml": publisher,
      "docker/staging-ops.Dockerfile": "FROM node:20-bookworm-slim\nCOPY . .\n",
      ".dockerignore": ".git\n.env\n.context\n",
      "package-lock.json": JSON.stringify({ packages: { "": {}, "node_modules/x": { version: "1", resolved: "https://registry.npmjs.org/x", integrity: "sha512-a" } } }),
    });
    // Four workflow rows, two Dockerfile rows, one dockerignore row and the three lockfile rows the
    // spec asks to be measured separately: origin, embedded auth, integrity.
    expect(evidence.counts).toEqual({ satisfied: 10 });
    expect(evidence.sourceHashes[".dockerignore"]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("records VIOLATED rows for secret refs, a build ARG, a secret mount and a loose lockfile", () => {
    const evidence = recipeEvidence({
      ".github/workflows/staging-ops-image.yml": "password: ${{ secrets.GHCR_PAT }}\nbuild-args: |\n  TOKEN=x\n",
      "docker/staging-ops.Dockerfile": "FROM node:20\nARG NPM_TOKEN\nRUN --mount=type=secret,id=npm npm ci\n",
      ".dockerignore": "node_modules\n",
      "package-lock.json": JSON.stringify({ packages: { "node_modules/y": { version: "1" } } }),
    });
    const byId = statuses(evidence);
    expect(byId["workflow.no-secret-refs"]).toBe("violated");
    expect(byId["workflow.checkout-credentials-off"]).toBe("violated");
    expect(byId["workflow.no-build-secret-forwarding"]).toBe("violated");
    expect(byId["dockerfile.no-build-args"]).toBe("violated");
    expect(byId["dockerfile.no-secret-mounts"]).toBe("violated");
    expect(byId["dockerignore.excludes-sensitive-trees"]).toBe("violated");
    expect(byId["lockfile.registry-origin"]).toBe("violated");
    expect(byId["lockfile.integrity-present"]).toBe("violated");
    // An entry with NO resolved URL cannot be shown to carry no credential either. "There was nothing
    // to check" is not a pass.
    expect(byId["lockfile.no-embedded-credentials"]).toBe("unverified");
  });

  /**
   * THE OVER-CLAIM THIS REPLACES. The lockfile row used to accept ANY `https://…` as a measured npm
   * origin, so `https://packages.internal.example/x.tgz` — or a URL with a token in its userinfo —
   * satisfied a row the spec wanted to say "resolved from the public npm registry".
   */
  it("MEASURES the npm registry origin and embedded credentials, without emitting either", () => {
    const token = syntheticSecret();
    const evidence = recipeEvidence({
      "package-lock.json": JSON.stringify({
        packages: {
          "": {},
          "node_modules/ok": { resolved: `${EXPECTED_REGISTRY_ORIGIN}/ok/-/ok-1.0.0.tgz`, integrity: "sha512-a" },
          "node_modules/elsewhere": { resolved: "https://packages.internal.example/elsewhere.tgz", integrity: "sha512-b" },
          "node_modules/withauth": { resolved: `https://ci:${token}@registry.npmjs.org/withauth.tgz`, integrity: "sha512-c" },
          // A workspace link has no registry origin to pin, by construction, and is not counted.
          "packages/local": { link: true },
        },
      }),
    });
    const byId = statuses(evidence);
    expect(byId["lockfile.registry-origin"]).toBe("violated");
    expect(byId["lockfile.no-embedded-credentials"]).toBe("violated");
    expect(byId["lockfile.integrity-present"]).toBe("satisfied");

    const serialized = JSON.stringify(evidence);
    // Counts against a NAMED expected origin — never the foreign host, the package path or the URL.
    expect(serialized).toContain(EXPECTED_REGISTRY_ORIGIN);
    for (const withheld of [token, "packages.internal.example", "node_modules/elsewhere", "withauth"]) {
      expect(serialized, `the recipe evidence emits ${withheld}`).not.toContain(withheld);
    }
    // Three counted entries: the two foreign/auth-bearing ones and the good one. The link is not one.
    expect(byId["lockfile.registry-origin"]).toBe("violated");
    expect(serialized).toContain("of 3 package entries");
  });

  it("records UNVERIFIED — not satisfied — for a file it could not read or parse", () => {
    const evidence = recipeEvidence({ "package-lock.json": "{not json" });
    expect(evidence.counts.unverified).toBe(4);
    expect(evidence.counts.satisfied).toBeUndefined();
    expect(evidence.sourceHashes["docker/staging-ops.Dockerfile"]).toBe("unreadable");
  });

  it("states its own ceiling IN the artifact, not only in a comment", () => {
    // A reader of the evidence must not be able to mistake these rows for a hermeticity proof — the
    // limitation travels with the data, because comments do not.
    expect(recipeEvidence({}).limitation).toMatch(/NOT a hermeticity claim/);
  });
});
