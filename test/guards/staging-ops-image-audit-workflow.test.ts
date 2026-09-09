import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { AUDIT_LIMITS, AUDIT_WORKFLOW_PATH, SUBJECT, SUBJECT_REFERENCE } from "../../scripts/staging-ops/image-audit/subject.mjs";

/**
 * BUILD-FAILING GUARD on `.github/workflows/staging-ops-image-audit.yml` (AIO-997, PUB-01/PUB-07).
 *
 * WHY A GUARD AT ALL. Every property that makes a read-only audit read-only is a line in a YAML file
 * that no test tier executes: the grant is `packages: read` and not `write`, the trigger is one
 * manual dispatch with no inputs, the refusal is a red step before the checkout, and the evidence
 * upload runs on every path. On the runner GitHub enforces them; here, only this file does.
 *
 * WHAT IT CANNOT DO. It reads THIS file on THIS ref — a divergent copy of the workflow on another ref
 * is outside it, which is exactly why the audit's own context guard pins `workflow_ref`/`workflow_sha`
 * to the dispatch commit.
 */

const FILE = join(process.cwd(), ".github", "workflows", "staging-ops-image-audit.yml");
const raw = readFileSync(FILE, "utf8");
const workflow = YAML.parse(raw);
const job = workflow.jobs.audit;
const steps: any[] = job.steps;
const stepIndex = (predicate: (s: any) => boolean) => steps.findIndex(predicate);
const byRun = (fragment: string) => stepIndex((s) => typeof s.run === "string" && s.run.includes(fragment));
const byUses = (prefix: string) => stepIndex((s) => typeof s.uses === "string" && s.uses.startsWith(prefix));

describe("guard: the audit can only be dispatched from trusted staging (PUB-01)", () => {
  it("has exactly one trigger, workflow_dispatch, and declares NO inputs", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    // An inputs map would be the arbitrary-image service the spec rules out: no registry,
    // repository, ref or digest exists for an operator to supply. The subject is reviewed source.
    expect(workflow.on.workflow_dispatch ?? null).toBeNull();
  });

  it("refuses an untrusted context in a FAILING step, not a green skipped job", () => {
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
    ]) {
      expect(guard.run, `the pre-checkout guard does not check ${term}`).toContain(term);
    }
  });

  /**
   * THE MUTANT THIS EXISTS FOR. Copying the publisher's guard verbatim leaves the expected
   * `workflow_ref` pointing at `staging-ops-image.yml` — one word different, still a 40-hex SHA on
   * `refs/heads/staging`, and it would accept a run of the PUBLISHER as though it were this audit.
   */
  it("expects its OWN workflow path, not the publisher's", () => {
    expect(steps[0].run).toContain(`${AUDIT_WORKFLOW_PATH}@refs/heads/staging`);
    expect(steps[0].run).not.toContain("staging-ops-image.yml@refs/heads/staging");
    // …and the constant the helper uses is the same path this file lives at.
    expect(AUDIT_WORKFLOW_PATH).toBe(".github/workflows/staging-ops-image-audit.yml");
  });

  it("runs that guard BEFORE checkout, login and the helper, and disables shell tracing", () => {
    expect(steps[0].uses).toBeUndefined();
    for (const later of ["actions/checkout@", "docker/login-action@"]) {
      expect(byUses(later), `${later} is missing`).toBeGreaterThan(0);
    }
    expect(byRun("image-audit.mjs")).toBeGreaterThan(0);
    // `set -x` would echo every context value into a log this public repository publishes.
    expect(steps[0].run).toContain("set +x");
  });

  it("passes context through env and never interpolates an expression into a shell body", () => {
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
    const checkout = steps[byUses("actions/checkout@")];
    expect(checkout.with).toMatchObject({ ref: "${{ github.sha }}", "persist-credentials": false });
    expect(checkout.id).toBe("checkout");
    expect(byRun("image-audit.mjs verify-context")).toBeGreaterThan(byUses("actions/checkout@"));
  });
});

describe("guard: the audit's credentials are READ-ONLY (PUB-01, PUB-06)", () => {
  it("grants contents:read and packages:READ — never packages:write", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "read", packages: "read" });
    // The single most important line in this file: an audit that could push cannot be described as
    // read-only, and `write` is one character from `read` in a diff nobody re-reads.
    expect(job.permissions.packages).toBe("read");
  });

  it("requests no write scope of any kind", () => {
    const writes = Object.entries(job.permissions).filter(([, v]) => v === "write").map(([k]) => k);
    expect(writes).toEqual([]);
    for (const forbidden of ["id-token", "attestations", "statuses", "checks", "deployments", "actions"]) {
      expect(job.permissions[forbidden], `${forbidden} is granted`).toBeUndefined();
    }
  });

  it("uses only the ephemeral job token — no PAT, no provider or app secret", () => {
    const secrets = raw.match(/secrets\.[A-Z_]+/g) ?? [];
    expect(secrets, `the audit reads repository secrets: ${secrets.join(", ")}`).toEqual([]);
    expect(raw).not.toContain("vars.");
    expect(raw).toContain("password: ${{ github.token }}");
  });

  it("holds no credential for any lifecycle system it must never touch", () => {
    const envKeys = steps.flatMap((s) => Object.keys(s.env ?? {}));
    const envValues = steps.flatMap((s) => Object.values(s.env ?? {}).map(String));
    for (const forbidden of ["RAILWAY", "AWS_", "LINEAR", "GRAPHITI", "DATABASE_URL", "OPENAI", "ANTHROPIC", "OPENROUTER"]) {
      expect(envKeys.filter((k) => k.includes(forbidden)), `${forbidden} is in scope`).toEqual([]);
      expect(envValues.filter((v) => v.includes(forbidden)), `${forbidden} is in scope`).toEqual([]);
    }
    const shell = steps.map((s) => s.run ?? "").join("\n");
    // Every verb that would publish, deploy, move a ref or destroy an artifact — and `docker run`,
    // because inspecting an image must never start one.
    for (const verb of ["railway ", "git push", "gh pr merge", "gh api", "docker push", "docker run", "docker rmi", "-X DELETE", "-X PATCH", "-X PUT"]) {
      expect(shell, `the audit runs ${verb}`).not.toContain(verb);
    }
    for (const install of ["npm ", "pip ", "npx ", "uv "]) {
      expect(shell, `the audit installs with ${install}`).not.toContain(install);
    }
    for (const trigger of ["workflow_run", "repository_dispatch", "workflow_call", "push", "schedule"]) {
      expect(Object.keys(workflow.on), `${trigger} can start the audit`).not.toContain(trigger);
    }
  });

  it("builds and pushes nothing — no build action is present at all", () => {
    expect(byUses("docker/build-push-action@")).toBe(-1);
    expect(raw).not.toContain("push: true");
  });
});

describe("guard: bounds, serialization and evidence (PUB-01, PUB-04)", () => {
  it("bounds the job, and reserves time after the internal deadline for the failure record", () => {
    expect(job["timeout-minutes"]).toBe(AUDIT_LIMITS.jobTimeoutMinutes);
    // THE ORDERING THAT MATTERS: the helper's own deadline must expire FIRST, or the job is killed
    // mid-write and the sanitized record the upload exists for was never produced.
    expect(AUDIT_LIMITS.internalDeadlineMs).toBeLessThan(AUDIT_LIMITS.jobTimeoutMinutes * 60_000);
    const reserveMs = AUDIT_LIMITS.jobTimeoutMinutes * 60_000 - AUDIT_LIMITS.internalDeadlineMs;
    expect(reserveMs, "too little job time is reserved for the sanitized record and the upload").toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("shares the publisher's concurrency group so an audit and a publication cannot interleave", () => {
    expect(workflow.concurrency).toMatchObject({ group: "staging-ops-image-publish", "cancel-in-progress": false });
  });

  it("uploads the evidence on EVERY path, with the 30-day retention stated", () => {
    const upload = steps[byUses("actions/upload-artifact@")];
    // `always()`: a REFUSED audit's sanitized record is the evidence that matters most, and a
    // conditional upload would drop exactly the run a coordinator needs to read.
    expect(upload.if).toBe("always()");
    expect(upload.with["retention-days"]).toBe(30);
    expect(upload.with.path).toBe("staging-ops-image-audit.json");
    expect(upload.with["if-no-files-found"]).toBe("warn");
    expect(upload.with.name).toContain("${{ github.run_attempt }}");
    // And it is the LAST step: nothing runs after it that could add an unaccounted-for surface.
    expect(byUses("actions/upload-artifact@")).toBe(steps.length - 1);
  });

  it("uploads exactly ONE artifact, and never the scratch tree", () => {
    const uploads = steps.filter((s) => typeof s.uses === "string" && s.uses.startsWith("actions/upload-artifact@"));
    expect(uploads).toHaveLength(1);
    // Raw layer content lives in runner scratch. A path anywhere near it in an upload would publish
    // the image's bytes to a public repository's artifacts.
    expect(String(uploads[0].with.path)).not.toMatch(/RUNNER_TEMP|scratch|layers|scan/);
  });

  it("runs the audit AFTER login and BEFORE the upload, and lets a bad verdict fail the job", () => {
    const audit = byRun("image-audit.mjs run");
    expect(audit).toBeGreaterThan(byUses("docker/login-action@"));
    expect(byUses("actions/upload-artifact@")).toBeGreaterThan(audit);
    // No `continue-on-error`: a verdict that is not transition-ready must be a red run, because a
    // green one reads as permission to expose the package.
    expect(steps[audit]["continue-on-error"]).toBeUndefined();
    expect(steps[audit].env.AUDIT_EVIDENCE_PATH).toBe("staging-ops-image-audit.json");
  });

  it("names NO image reference itself — the subject lives in reviewed source", () => {
    // Deliberately stronger than "targets the right package". A reference in the workflow would be a
    // second place the subject is decided, and the two could disagree; the only registry string here
    // is the login host.
    const references = raw.match(/ghcr\.io\/[^\s"'@:]+/g) ?? [];
    expect(references).toEqual([]);
    expect(raw).toContain("registry: ghcr.io");
    expect(SUBJECT_REFERENCE).toBe(`ghcr.io/aiosbrain/aios-staging-ops@${SUBJECT.digest}`);
  });

  it("uses only the fixed reviewed action allowlist", () => {
    const used = (raw.match(/uses:\s*(\S+)/g) ?? []).map((m) => m.replace(/uses:\s*/, ""));
    expect(new Set(used)).toEqual(new Set([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", // v7
      "docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f", // v3
      "docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9", // v3
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", // v4
    ]));
  });

  it("does not collide with an existing required check name", () => {
    expect(job.name).toBe("Audit the pinned staging ops runner image");
    expect(raw).not.toContain("Release candidate gate");
    expect(raw).not.toContain("Staging candidate validation");
  });
});

describe("guard: the publisher is untouched by this change (PUB-06)", () => {
  const publisher = readFileSync(join(process.cwd(), ".github", "workflows", "staging-ops-image.yml"), "utf8");
  const publisherWorkflow = YAML.parse(publisher);

  it("keeps the publisher's private-only precheck and its packages:write grant unchanged", () => {
    expect(publisherWorkflow.jobs.publish.permissions).toEqual({ contents: "read", packages: "write" });
    expect(publisher).toContain("image-publication.mjs precheck-package");
    // The publisher still refuses anything but a PRIVATE package. After an audited operator
    // transition it will therefore refuse to publish again — deliberately, and documented in OPS.
    const helper = readFileSync(join(process.cwd(), "scripts", "staging-ops", "image-publication.mjs"), "utf8");
    expect(helper).toContain('visibility is ${describe(visibility)}, expected private');
  });

  it("leaves the Dockerfile's contract alone", () => {
    const dockerfile = readFileSync(join(process.cwd(), "docker", "staging-ops.Dockerfile"), "utf8");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "-s", "--", "node"]');
    expect(dockerfile).toContain("USER node");
  });
});
