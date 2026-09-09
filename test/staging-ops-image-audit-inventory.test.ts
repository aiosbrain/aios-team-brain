import { describe, expect, it } from "vitest";
import {
  assessPackageInventory,
  classifyTagReadback,
  hasNextPage,
  listPackageVersions,
  normalizeVersion,
  reconcilePackageInventory,
} from "../scripts/staging-ops/image-audit/registry.mjs";
import { SUBJECT } from "../scripts/staging-ops/image-audit/subject.mjs";
import { sha256 } from "../scripts/staging-ops/image-audit/layers.mjs";
import { recipeEvidence } from "../scripts/staging-ops/image-audit/recipe.mjs";

/**
 * PUB-05's inventory rows and M3's recipe rows.
 *
 * THE FAILURE MODE UNDER TEST: an unreadable list and an empty list produce the same array. Every
 * case below asks whether the code can tell them apart, because the consequence of getting it wrong
 * is exposing an unaudited digest in the same package — and the transition is irreversible.
 */

const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}`;
const AUDITED = SUBJECT.digest;

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
    expect(result.versions.map((v: any) => v.digest)).toEqual([AUDITED, digest("b")]);
  });

  /** THE MUTANT: stopping after page one. It returns a plausible, complete-looking, wrong inventory. */
  it("an UNTAGGED version on a later page still blocks the transition", async () => {
    const pages = [
      page([version(AUDITED, ["sha-abc-run-1.1"], 1)], { next: true }),
      page([version(digest("c"), undefined, 2)], { next: false }),
    ];
    const inventory = await listPackageVersions({ token: "t", fetchImpl: async () => pages.shift() });
    const assessment = assessPackageInventory(inventory, AUDITED);
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
    );
    expect(assessment.status).toBe("unverified");
    expect(assessment.reason).toMatch(/does not appear in the package/);
  });

  it("carries the API status through as unverified when the read failed", () => {
    const assessment = assessPackageInventory({ status: "unverified", reason: "403" }, AUDITED);
    expect(assessment).toMatchObject({ apiStatus: "unverified", status: "unverified", source: "actions-api" });
    expect(assessment.otherVersions).toBeUndefined();
  });
});

describe("operator-supplied evidence can satisfy the gate WITHOUT rewriting the API result (PUB-05)", () => {
  const failed = assessPackageInventory({ status: "unverified", reason: "403 on page 1" }, AUDITED);

  it("accepts a complete, timestamped, full-digest inventory", () => {
    const reconciled = reconcilePackageInventory(failed, {
      capturedAt: "2026-09-09T18:00:00Z",
      coversAllPages: true,
      coversUntagged: true,
      auditedDigest: AUDITED,
      digests: [AUDITED],
    });
    expect(reconciled.status).toBe("verified");
    expect(reconciled.otherVersions).toBe(0);
    // THE PROPERTY A SHORTCUT WOULD LOSE: the workflow's own read still reads as failed. Anyone
    // reading this record later can see the gate stood on operator evidence, not on the API.
    expect(reconciled.apiStatus).toBe("unverified");
    expect(reconciled.source).toBe("operator-evidence");
  });

  it("rejects a truncated digest, a missing page attestation and a missing untagged attestation", () => {
    const cases = [
      { capturedAt: "x", coversAllPages: true, coversUntagged: true, digests: ["sha256:0005824"] },
      { capturedAt: "x", coversUntagged: true, digests: [AUDITED] },
      { capturedAt: "x", coversAllPages: true, digests: [AUDITED] },
      { coversAllPages: true, coversUntagged: true, digests: [AUDITED] },
      { capturedAt: "x", coversAllPages: true, coversUntagged: true, digests: [] },
    ];
    for (const evidence of cases) {
      const reconciled = reconcilePackageInventory(failed, evidence);
      expect(reconciled.status).toBe("unverified");
      expect(reconciled.operatorEvidence.accepted).toBe(false);
    }
  });

  it("still blocks when the operator's own inventory lists another digest", () => {
    const reconciled = reconcilePackageInventory(failed, {
      capturedAt: "2026-09-09T18:00:00Z",
      coversAllPages: true,
      coversUntagged: true,
      auditedDigest: AUDITED,
      digests: [AUDITED, digest("e")],
    });
    expect(reconciled.otherVersions).toBe(1);
    expect(reconciled.additionalSubjects).toEqual([digest("e")]);
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

  it("records satisfied rows for a recipe with no secret, arg or mount", () => {
    const evidence = recipeEvidence({
      ".github/workflows/staging-ops-image.yml": publisher,
      "docker/staging-ops.Dockerfile": "FROM node:20-bookworm-slim\nCOPY . .\n",
      ".dockerignore": ".git\n.env\n.context\n",
      "package-lock.json": JSON.stringify({ packages: { "": {}, "node_modules/x": { version: "1", resolved: "https://registry.npmjs.org/x", integrity: "sha512-a" } } }),
    });
    expect(evidence.counts).toEqual({ satisfied: 8 });
    expect(evidence.sourceHashes[".dockerignore"]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("records VIOLATED rows for secret refs, a build ARG, a secret mount and a loose lockfile", () => {
    const evidence = recipeEvidence({
      ".github/workflows/staging-ops-image.yml": "password: ${{ secrets.GHCR_PAT }}\nbuild-args: |\n  TOKEN=x\n",
      "docker/staging-ops.Dockerfile": "FROM node:20\nARG NPM_TOKEN\nRUN --mount=type=secret,id=npm npm ci\n",
      ".dockerignore": "node_modules\n",
      "package-lock.json": JSON.stringify({ packages: { "node_modules/y": { version: "1" } } }),
    });
    const byId = Object.fromEntries(evidence.assertions.map((a: any) => [a.id, a.status]));
    expect(byId["workflow.no-secret-refs"]).toBe("violated");
    expect(byId["workflow.checkout-credentials-off"]).toBe("violated");
    expect(byId["workflow.no-build-secret-forwarding"]).toBe("violated");
    expect(byId["dockerfile.no-build-args"]).toBe("violated");
    expect(byId["dockerfile.no-secret-mounts"]).toBe("violated");
    expect(byId["dockerignore.excludes-sensitive-trees"]).toBe("violated");
    expect(byId["lockfile.resolved-and-pinned"]).toBe("violated");
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
