/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { publicationTag } from "../../scripts/staging-ops/image-publication.mjs";

/**
 * BUILD-FAILING GUARD on `.github/workflows/staging-ops-image.yml` (AIO-997).
 *
 * WHY A GUARD AT ALL. This workflow holds `packages: write` and publishes an artifact that a runner
 * is later commissioned against. Every property that makes that safe — one trigger, one ref, an
 * immutable checkout, a fixed destination, the REGISTRY digest rather than the local image id — is
 * a line in a YAML file that no test tier executes. On the runner it is enforced by GitHub; here,
 * only by this file. Each assertion below traces to a specific way the publisher would still be
 * green while publishing the wrong thing.
 *
 * WHAT IT CANNOT DO. It reads THIS file on THIS ref. A divergent copy of the workflow on another ref
 * is outside it, exactly as the workflow's own header says — which is why the receipt records
 * `workflow_ref`/`workflow_sha` for the coordinator to check against the real run.
 */

const FILE = join(process.cwd(), ".github", "workflows", "staging-ops-image.yml");
const raw = readFileSync(FILE, "utf8");
const workflow = YAML.parse(raw);
const job = workflow.jobs.publish;
const steps: any[] = job.steps;
const stepIndex = (predicate: (s: any) => boolean) => steps.findIndex(predicate);
const byRun = (fragment: string) => stepIndex((s) => typeof s.run === "string" && s.run.includes(fragment));

describe("guard: the ops image publisher can only be dispatched from trusted staging (OP-01)", () => {
  it("has exactly one trigger, workflow_dispatch, and declares NO inputs", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    // `on: workflow_dispatch:` parses to null. An inputs map would be the arbitrary-source feature
    // the spec rules out: no operator-supplied ref, sha, tag or destination exists to smuggle.
    expect(workflow.on.workflow_dispatch ?? null).toBeNull();
  });

  it("refuses an untrusted context in a FAILING step, not a green skipped job", () => {
    // A job-level `if` would render as a skipped job — which reads like "nothing to do" in the
    // Actions UI, and is indistinguishable from a successful no-op run. The refusal must be red.
    expect(job.if).toBeUndefined();
    const guard = steps[0];
    expect(guard.name).toMatch(/refuse/i);
    expect(guard.run).toContain("exit 1");
    for (const term of [
      'CTX_REPOSITORY" = "aiosbrain/aios-team-brain"',
      'CTX_EVENT" = "workflow_dispatch"',
      'CTX_REF" = "refs/heads/staging"',
      "[0-9a-f]{40}",
      'CTX_WORKFLOW_SHA" = "$CTX_SHA"',
      "staging-ops-image.yml@refs/heads/staging",
    ]) {
      expect(guard.run, `the pre-checkout guard does not check ${term}`).toContain(term);
    }
  });

  it("runs that guard BEFORE checkout, login, build and the helper", () => {
    // Two reasons, both required. (a) Nothing may authenticate to a registry or build from a tree
    // that was never trusted. (b) The guard must not consult repository code to decide whether to
    // trust the repository — at step 0 the tree is not on disk, which is what makes that structural
    // rather than a promise.
    const guard = 0;
    expect(steps[guard].uses).toBeUndefined();
    for (const later of ["actions/checkout@", "docker/login-action@", "docker/build-push-action@"]) {
      const at = stepIndex((s) => typeof s.uses === "string" && s.uses.startsWith(later));
      expect(at, `${later} is missing`).toBeGreaterThan(guard);
    }
    expect(byRun("image-publication.mjs")).toBeGreaterThan(guard);
  });

  it("passes context through env and never interpolates an expression into a shell body", () => {
    // `${{ … }}` inside a `run:` is textual substitution into the script BEFORE bash sees it. There
    // are no workflow inputs here, but the rule is asserted on the shape, not on today's inventory:
    // the day an input is added, this is what makes it a red diff instead of an injection.
    for (const step of steps) {
      if (typeof step.run === "string") expect(step.run, `${step.name} interpolates into shell`).not.toContain("${{");
    }
    expect(steps[0].env).toMatchObject({
      CTX_REPOSITORY: "${{ github.repository }}",
      CTX_SHA: "${{ github.sha }}",
      CTX_WORKFLOW_SHA: "${{ github.workflow_sha }}",
      CTX_WORKFLOW_REF: "${{ github.workflow_ref }}",
    });
  });

  it("checks out the IMMUTABLE dispatch commit with credentials off, then measures HEAD", () => {
    const checkout = steps.find((s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout@"));
    // The branch NAME would run whatever landed on staging between dispatch and job start — a
    // different artifact than the one whose checks the coordinator accepted.
    expect(checkout.with).toMatchObject({ ref: "${{ github.sha }}", "persist-credentials": false });
    // A stable id, because a later step's gating condition has to name this step. Without one, the
    // only way to ask "did the tree land?" is a positional reference that any inserted step breaks.
    expect(checkout.id).toBe("checkout");
    expect(JSON.stringify(checkout.with)).not.toContain("refs/heads/staging");
    // …and asking for it is not standing on it.
    expect(byRun("image-publication.mjs verify-context")).toBeGreaterThan(steps.indexOf(checkout));
  });
});

describe("guard: the publisher's credentials are the minimum (OP-02, OP-07)", () => {
  it("grants contents:read at the workflow level and adds ONLY packages:write to the job", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "read", packages: "write" });
  });

  it("requests no other write scope — in particular none that mints a context or moves a ref", () => {
    const writes = Object.entries(job.permissions).filter(([, v]) => v === "write").map(([k]) => k);
    expect(writes).toEqual(["packages"]);
    for (const forbidden of ["id-token", "attestations", "statuses", "checks", "deployments", "actions"]) {
      expect(job.permissions[forbidden], `${forbidden} is granted`).toBeUndefined();
    }
  });

  it("uses only the ephemeral job token — no PAT, no provider or app secret", () => {
    const secrets = raw.match(/secrets\.[A-Z_]+/g) ?? [];
    expect(secrets, `the publisher reads repository secrets: ${secrets.join(", ")}`).toEqual([]);
    expect(raw).not.toContain("vars.");
    expect(raw).toContain("password: ${{ github.token }}");
  });

  it("holds no credential for any lifecycle system it must never touch (OP-07)", () => {
    // Keyed on the PARSED env of every step, not on the file text: a raw-text search would also hit
    // the header comment that explains the rule, so the guard would depend on how the rule is
    // WORDED rather than on what the workflow does.
    const envKeys = steps.flatMap((s) => Object.keys(s.env ?? {}));
    const envValues = steps.flatMap((s) => Object.values(s.env ?? {}).map(String));
    for (const forbidden of ["RAILWAY", "AWS_", "LINEAR", "GRAPHITI", "DATABASE_URL", "OPENAI", "ANTHROPIC", "OPENROUTER"]) {
      expect(envKeys.filter((k) => k.includes(forbidden)), `${forbidden} is in scope`).toEqual([]);
      expect(envValues.filter((v) => v.includes(forbidden)), `${forbidden} is in scope`).toEqual([]);
    }
    // Nor any verb that would deploy, promote, move a ref or destroy an artifact.
    const shell = steps.map((s) => s.run ?? "").join("\n");
    for (const verb of ["railway ", "git push", "gh pr merge", "gh api", "curl ", "docker rmi", "-X DELETE"]) {
      expect(shell, `the publisher runs ${verb}`).not.toContain(verb);
    }
    // No dependency install outside the Dockerfile either: with `packages: write` in scope, the only
    // third-party code that executes is inside the image build, and the helper is builtins-only.
    for (const install of ["npm ", "pip ", "npx ", "uv "]) {
      expect(shell, `the publisher installs with ${install}`).not.toContain(install);
    }
    // …and no trigger that another workflow or an API caller could fire on its behalf.
    for (const trigger of ["workflow_run", "repository_dispatch", "workflow_call", "push", "schedule"]) {
      expect(Object.keys(workflow.on), `${trigger} can start the publisher`).not.toContain(trigger);
    }
  });

  it("passes no build secret, build-arg or host mount into the image build", () => {
    const build = steps.find((s) => typeof s.uses === "string" && s.uses.startsWith("docker/build-push-action@"));
    for (const key of ["secrets", "secret-files", "build-args", "ssh"]) {
      expect(build.with[key], `the build receives ${key}`).toBeUndefined();
    }
  });
});

describe("guard: the artifact is the reviewed ops image, unchanged (OP-03)", () => {
  const build = () => steps.find((s) => typeof s.uses === "string" && s.uses.startsWith("docker/build-push-action@"));

  it("builds the EXISTING Dockerfile from the root context, for the one recorded platform", () => {
    expect(build().with).toMatchObject({
      context: ".",
      file: "docker/staging-ops.Dockerfile",
      platforms: "linux/amd64",
      push: true,
    });
  });

  it("disables provenance and sbom explicitly, so the push is a manifest and not an index", () => {
    // Left implicit, buildx publishes an index carrying attestation descriptors — which the
    // readback then refuses as an unexpected shape. This is not disabling an existing gate; this
    // publisher has none, and inspects the top-level descriptor instead.
    expect(build().with.provenance).toBe(false);
    expect(build().with.sbom).toBe(false);
  });

  it("opts out of the action's own build record upload and build summary, as strings", () => {
    // Left at their defaults, `docker/build-push-action` uploads a build record artifact AND writes
    // its own summary into the job summary — a second, uncontrolled account of the publication
    // beside OP-05's one receipt artifact and controlled summary. Both are asserted, and asserted
    // as the STRING "false": a bare YAML `false` parses to a boolean here, and the equality below
    // is what makes that difference a red diff rather than a value the runner stringifies for us.
    const env = build().env ?? {};
    expect(env.DOCKER_BUILD_RECORD_UPLOAD).toBe("false");
    expect(env.DOCKER_BUILD_SUMMARY).toBe("false");
    // …and the inputs the build actually needs are still `with:`, not swallowed by that env block.
    expect(build().with.tags).toContain("ghcr.io/aiosbrain/aios-staging-ops:");
    expect(build().with.labels).toBeTruthy();
  });

  it("labels the image with its source repository and revision", () => {
    expect(build().with.labels).toContain("org.opencontainers.image.source=https://github.com/${{ github.repository }}");
    expect(build().with.labels).toContain("org.opencontainers.image.revision=${{ github.sha }}");
  });

  it("does not modify the Dockerfile's contract", () => {
    // The publisher's job is to publish the reviewed runner, not to become a second place where its
    // base, user or entrypoint is decided.
    const dockerfile = readFileSync(join(process.cwd(), "docker", "staging-ops.Dockerfile"), "utf8");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "-s", "--", "node"]');
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain("postgresql-client-18");
  });

  it("keeps `.git` and agent scratch trees out of the build context", () => {
    // Two independent layers, because either alone is a single point of failure: the checkout does
    // not persist credentials, AND `.dockerignore` keeps `.git` out of the context entirely.
    const ignored = readFileSync(join(process.cwd(), ".dockerignore"), "utf8").split("\n").map((l) => l.trim());
    for (const entry of [".git", ".github", ".context", ".env"]) expect(ignored).toContain(entry);
  });
});

describe("guard: the published identity is the registry digest (OP-04)", () => {
  const verify = () => steps[byRun("image-publication.mjs verify-publication")];

  it("takes outputs.DIGEST from the build step", () => {
    expect(verify().env.IMAGE_DIGEST).toBe("${{ steps.build.outputs.digest }}");
  });

  /**
   * THE MUTANT THIS EXISTS FOR. `steps.build.outputs.imageid` is the local image CONFIG digest. It
   * is the same `sha256:<64-hex>` shape, it is one word away in the same expression, and a receipt
   * built from it names nothing in the registry. No format check can see the difference, so the
   * WIRING is pinned here and the CONTENT is proved by the readback in the helper's tests.
   */
  it("never wires imageid, or any other build output, into the receipt", () => {
    // Read from the PARSED env/with values, so the comment that explains why imageid is wrong does
    // not itself trip the guard. What is asserted is what the steps RECEIVE.
    const wired = steps
      .flatMap((s) => [...Object.values(s.env ?? {}), ...Object.values(s.with ?? {})])
      .filter((v): v is string => typeof v === "string")
      .flatMap((v) => v.match(/steps\.build\.outputs\.\w+/g) ?? []);
    expect(wired.length, "no build output reaches the receipt at all").toBeGreaterThan(0);
    expect(new Set(wired)).toEqual(new Set(["steps.build.outputs.digest"]));
  });

  it("reads that exact by-digest reference back from the REGISTRY before claiming success", () => {
    expect(byRun("image-publication.mjs verify-publication")).toBeGreaterThan(
      stepIndex((s) => typeof s.uses === "string" && s.uses.startsWith("docker/build-push-action@"))
    );
    // `docker inspect` would answer from the local daemon's cache — the machine that just built the
    // image, which of course has it. The evidence has to come from the registry over the
    // authenticated session, at the exact by-digest reference.
    const helper = readFileSync(join(process.cwd(), "scripts", "staging-ops", "image-publication.mjs"), "utf8");
    expect(helper).toContain('["buildx", "imagetools", "inspect", "--raw", reference]');
  });

  it("publishes a run-unique tag and no moving tag", () => {
    const build = steps.find((s) => typeof s.uses === "string" && s.uses.startsWith("docker/build-push-action@"));
    const tags = String(build.with.tags).split("\n").map((t) => t.trim()).filter(Boolean);
    expect(tags).toHaveLength(1);
    expect(tags[0]).not.toMatch(/:latest\b|:staging\b|:main\b/);
    // The workflow's inline tag and the helper's `publicationTag` must agree, or the receipt names a
    // tag that was never pushed. Substituting the contexts is the only honest way to compare them.
    const substituted = tags[0]
      .replace("${{ github.sha }}", "d74fe08bad532e48d6d91199093189960033f77f")
      .replace("${{ github.run_id }}", "42")
      .replace("${{ github.run_attempt }}", "3");
    expect(substituted).toBe(
      `ghcr.io/aiosbrain/aios-staging-ops:${publicationTag({ sha: "d74fe08bad532e48d6d91199093189960033f77f", runId: "42", runAttempt: "3" })}`
    );
    // And the tag the RECEIPT records is the tag that was pushed — otherwise the receipt names
    // something that does not exist in the registry.
    const recorded = steps[byRun("image-publication.mjs verify-publication")].env.IMAGE_TAG;
    expect(`ghcr.io/aiosbrain/aios-staging-ops:${recorded}`).toBe(tags[0]);
  });

  it("targets the one fixed lowercase private package and nothing else", () => {
    const references = raw.match(/ghcr\.io\/[^\s"'@:]+/g) ?? [];
    expect(new Set(references)).toEqual(new Set(["ghcr.io/aiosbrain/aios-staging-ops"]));
    expect(raw).toContain("registry: ghcr.io");
  });
});

describe("guard: honest publication accounting (OP-05, OP-06)", () => {
  it("prechecks package visibility and linkage BEFORE authenticating to the registry", () => {
    const precheck = byRun("image-publication.mjs precheck-package");
    expect(precheck).toBeGreaterThan(-1);
    expect(stepIndex((s) => typeof s.uses === "string" && s.uses.startsWith("docker/login-action@"))).toBeGreaterThan(precheck);
  });

  it("records a failed or PARTIAL publication on every failure path where its helper exists", () => {
    const record = steps[byRun("image-publication.mjs record-failure")];
    // `failure()` is half of it. The other half is that this step RUNS THE REPOSITORY'S HELPER, and
    // the pre-checkout context refusal fails with no repository tree on disk — where this would add
    // a MODULE_NOT_FOUND on top of the real refusal. It must be gated on the checkout's own
    // outcome, by that step's id, and on nothing weaker (`always()`, or `failure()` alone).
    expect(record.if).toBe("failure() && steps.checkout.outcome == 'success'");
    // It must see BOTH: the build step's outcome decides whether a push happened at all — "partial
    // publication", not "nothing happened" — and the digest names what is in the registry.
    expect(record.env.BUILD_OUTCOME).toBe("${{ steps.build.outcome }}");
    expect(record.env.IMAGE_DIGEST).toBe("${{ steps.build.outputs.digest }}");
    // The gate names a step that EXISTS and precedes it, so the condition cannot silently be false
    // forever because an id was renamed.
    const checkoutAt = stepIndex((s) => s.id === "checkout");
    expect(checkoutAt).toBeGreaterThan(-1);
    expect(byRun("image-publication.mjs record-failure")).toBeGreaterThan(checkoutAt);
  });

  it("keeps the pre-checkout refusal loud and the receipt upload unconditional", () => {
    // The two halves of the same decision. Gating the failure record on the checkout must NOT be
    // paid for by narrowing the refusal or the upload: the context guard is still a red step with
    // no `if` at all, and the upload still runs on every path and only WARNS when the refusal
    // happened before any record could be written.
    expect(steps[0].if).toBeUndefined();
    const upload = steps.find((s) => typeof s.uses === "string" && s.uses.startsWith("actions/upload-artifact@"));
    expect(upload.if).toBe("always()");
    expect(upload.with["if-no-files-found"]).toBe("warn");
  });

  it("uploads the receipt on success AND on failure, with the 30-day retention stated", () => {
    const upload = steps.find((s) => typeof s.uses === "string" && s.uses.startsWith("actions/upload-artifact@"));
    expect(upload.if).toBe("always()");
    expect(upload.with["retention-days"]).toBe(30);
    expect(upload.with.path).toBe("staging-ops-image-receipt.json");
    // Named per run AND attempt, so a retry cannot silently replace the earlier run's evidence.
    expect(upload.with.name).toContain("${{ github.run_attempt }}");
  });

  /**
   * THE ORDER DEFECT THIS PINS. `record-failure` runs BEFORE the upload, so an upload that fails
   * after a verified run has no accounting step left: the job is red while its only publication
   * record says `published`, and OP-05's "a pushed image followed by receipt/upload failure is
   * reported as partially published" goes unmet. A test asserting `if: failure()` on a step BEFORE
   * the upload cannot see that — the position relative to the upload is the property.
   */
  it("accounts for evidence delivery in a step AFTER the upload", () => {
    const report = byRun("image-publication.mjs report-delivery");
    expect(report, "there is no post-upload delivery accounting step").toBeGreaterThan(-1);
    const upload = stepIndex((s) => typeof s.uses === "string" && s.uses.startsWith("actions/upload-artifact@"));
    const record = byRun("image-publication.mjs record-failure");
    expect(record).toBeGreaterThan(-1);
    // The whole point: the failure record is written before the upload, so only a step after it can
    // know whether the upload delivered anything.
    expect(upload).toBeGreaterThan(record);
    expect(report).toBeGreaterThan(upload);
  });

  it("feeds that step the ACTUAL outcomes of the build, the receipt emission and the upload", () => {
    const report = steps[byRun("image-publication.mjs report-delivery")];
    // Step OUTCOMES, not the job's overall state and not a re-derivation: which of the two evidence
    // steps failed is the thing being reported, and the build's own outcome is what decides whether
    // there is a publication to call partial at all.
    expect(report.env.BUILD_OUTCOME).toBe("${{ steps.build.outcome }}");
    expect(report.env.VERIFY_OUTCOME).toBe("${{ steps.verify.outcome }}");
    expect(report.env.UPLOAD_OUTCOME).toBe("${{ steps.upload.outcome }}");
    expect(report.env.RECEIPT_PATH).toBe("staging-ops-image-receipt.json");
    // Each id it names EXISTS and precedes it, so no condition is silently false forever because a
    // step was renamed — the same failure mode the `checkout` id guard exists for.
    for (const id of ["build", "verify", "upload"]) {
      const at = stepIndex((s) => s.id === id);
      expect(at, `no step is id'd ${id}`).toBeGreaterThan(-1);
      expect(byRun("image-publication.mjs report-delivery")).toBeGreaterThan(at);
    }
    // Gated exactly like the failure record: only on a failed run, and only where the helper it runs
    // is on disk. `always()` would make it speak on the quiet success path.
    expect(report.if).toBe("failure() && steps.checkout.outcome == 'success'");
  });

  it("keeps the id'd steps the ones that actually emit and upload the receipt", () => {
    // Ids are only useful if they name the right steps — an id moved onto a neighbour would leave
    // every assertion above green while reporting the wrong step's outcome.
    expect(steps[byRun("image-publication.mjs verify-publication")].id).toBe("verify");
    expect(steps.find((s) => typeof s.uses === "string" && s.uses.startsWith("actions/upload-artifact@")).id).toBe("upload");
  });

  it("never deletes a package or flips its visibility to make a check pass", () => {
    // The tempting repair for a failed privacy check is to delete the package and retry, or to make
    // it public. The workflow runs no API call of its own (pinned in the OP-07 credential test);
    // what is pinned HERE is the other half — the ONE endpoint the helper touches is read with no
    // method override, so it can only ever be a GET.
    const helper = readFileSync(join(process.cwd(), "scripts", "staging-ops", "image-publication.mjs"), "utf8");
    for (const verb of ["DELETE", "PATCH", "method:", '"PUT"', '"POST"']) {
      expect(helper, `the helper can issue ${verb}`).not.toContain(verb);
    }
  });
});

describe("guard: the publisher stays separate from the release and CI lanes", () => {
  it("does not collide with an existing required check name", () => {
    // Branch protection identifies a required check by its CONTEXT NAME. A publisher job that
    // happened to be named like a gate could satisfy a protection rule it never evaluated.
    expect(job.name).toBe("Publish staging ops runner image");
    expect(raw).not.toContain("Release candidate gate");
    expect(raw).not.toContain("Staging candidate validation");
  });

  it("serializes with itself so two dispatches cannot race the same destination", () => {
    expect(workflow.concurrency).toMatchObject({ group: "staging-ops-image-publish", "cancel-in-progress": false });
  });

  it("uses only the fixed reviewed action allowlist", () => {
    // A fixed list of COMMITS, so adding an action — or moving one to a new revision — is a
    // deliberate edit to BOTH files rather than a silent change to what runs with `packages: write`
    // in scope. A tag is a moving pointer its owner can repoint after review; only a commit names
    // one tree, and set equality here means an unpinned `@v4` cannot re-enter unnoticed.
    const used = (raw.match(/uses:\s*(\S+)/g) ?? []).map((m) => m.replace(/uses:\s*/, ""));
    expect(new Set(used)).toEqual(new Set([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", // v7, the revision already pinned elsewhere in this repo
      "docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f", // v3
      "docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9", // v3
      "docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8", // v6
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", // v4
    ]));
  });
});
