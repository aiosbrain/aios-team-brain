import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { redactText } from "../scripts/staging-ops/redact-artifacts.mjs";
import { parseReceipts } from "../scripts/staging-ops/receipts.mjs";
import { LocalMaintenance } from "../scripts/staging-ops/local-maintenance.mjs";
import { waitForImportedBoot } from "../scripts/staging-ops/importer.mjs";

/**
 * DIAGNOSTIC SCOPE ONLY (`runtime-fourth-adjudication.md`).
 *
 * Runtime 4 got past the connection termination, then bootstrap "timed out" and the recovery child
 * was observed `CRASHED`. Neither statement identifies anything: maintenance calls, object-store
 * reads and the health poll all carry their own deadlines and nothing said which was running; the
 * health poll swallowed every fetch failure, so a probe that timed out and one that answered 503
 * produced the same message; and `CRASHED` describes the local controller's tracked child, with no
 * PID, exit code or signal recorded anywhere.
 *
 * These tests pin what the added diagnostics must say. **No timeout was increased, no fence
 * weakened, no lifecycle behaviour changed** — the signal, the unbounded stop wait and every
 * deadline are exactly as they were, and the tests below assert the ORIGINAL failure still surfaces.
 */

const captureReceipts = async (run: () => Promise<unknown>) => {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
  try {
    const outcome = await run().then(() => null, (error: unknown) => error);
    return { outcome, receipts: parseReceipts(lines.join("\n")), lines };
  } finally { log.mockRestore(); }
};

describe("the health poll says WHY it gave up", () => {
  const maintenance = (status: string, lifecycle: Record<string, unknown> | null = null) => ({
    readDeployment: async () => ({ id: "dep-1", serviceId: "app-local", status, ...(lifecycle ? { lifecycle } : {}) }),
  });
  const args = (fetchImpl: unknown, maint: unknown) => ({
    maintenance: maint as never, deploymentId: "dep-1", commit: "c".repeat(40),
    origin: "https://staging.example.com", token: "health-token",
    fetchImpl: fetchImpl as never, timeoutMs: 30, sleep: async () => {},
  });

  it("distinguishes a probe that TIMED OUT from one that answered", async () => {
    // The measured ambiguity. Both of these used to end in the identical sentence.
    const timedOut = await captureReceipts(() => waitForImportedBoot(args(
      vi.fn(async () => { throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }); }),
      maintenance("SUCCESS"),
    )));
    expect((timedOut.outcome as Error).message).toMatch(/failed with TimeoutError/);
    expect(timedOut.receipts.find((r) => r.kind === "health-poll-timed-out")?.fields.lastFetchError).toBe("TimeoutError");

    const answered = await captureReceipts(() => waitForImportedBoot(args(
      vi.fn(async () => ({ status: 503, json: async () => ({ ok: false }) })),
      maintenance("SUCCESS"),
    )));
    expect((answered.outcome as Error).message).toMatch(/answered 503 ok=false/);
    expect((answered.outcome as Error).message).not.toMatch(/TimeoutError/);
    const receipt = answered.receipts.find((r) => r.kind === "health-poll-timed-out")!;
    expect(receipt.fields).toMatchObject({ deploymentId: "dep-1", lastResponseStatus: 503, lastDeploymentStatus: "SUCCESS", lastFetchError: null });
    expect(Number(receipt.fields.attempts)).toBeGreaterThan(0);
  });

  it("still refuses, with the ORIGINAL failure, when the deployment is dead", async () => {
    // The diagnostics must not become the outcome: a CRASHED deployment is still a refusal, and the
    // sentence still leads with the status. What is added is the child's identity.
    const { outcome, receipts } = await captureReceipts(() => waitForImportedBoot(args(
      vi.fn(), maintenance("CRASHED", { pid: 4242, exitCode: 1, exitSignal: null, spawnError: null }),
    )));
    expect((outcome as Error).message).toMatch(/^fresh staging deployment failed in CRASHED/);
    expect((outcome as Error).message).toMatch(/pid 4242, exit 1/);
    expect(receipts.find((r) => r.kind === "deployment-observed-dead")?.fields)
      .toMatchObject({ status: "CRASHED", pid: 4242, exitCode: 1 });
  });

  it("says 'unknown' rather than inventing a PID when the controller recorded none", async () => {
    const { outcome } = await captureReceipts(() => waitForImportedBoot(args(vi.fn(), maintenance("FAILED"))));
    expect((outcome as Error).message).toMatch(/pid unknown, exit none/);
  });

  it("succeeds silently on a healthy answer — the diagnostics are for failures", async () => {
    const { outcome, receipts } = await captureReceipts(() => waitForImportedBoot(args(
      vi.fn(async () => ({ status: 202, json: async () => ({ booted: true, commit: "c".repeat(40) }) })),
      maintenance("SUCCESS"),
    )));
    expect(outcome).toBeNull();
    expect(receipts).toEqual([]);
  });
});

describe("maintenance calls name their route and their duration", () => {
  const client = (fetchImpl: unknown) => new LocalMaintenance({
    baseUrl: "http://maintenance:8080", token: "local-token", environmentId: "staging-local",
    appServiceId: "app-local", graphitiServiceId: "graphiti-local", fetchImpl: fetchImpl as never,
  });

  it("reports the route and the elapsed time on a refusal", async () => {
    const { outcome, receipts } = await captureReceipts(() =>
      client(vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))).call("/deployments?serviceId=app-local"));
    expect((outcome as Error).message).toMatch(/local maintenance refused \(500\) on \/deployments after \d+ms/);
    const receipt = receipts.find((r) => r.kind === "maintenance-call")!;
    // The QUERY STRING IS DROPPED, and the base URL never appears: the route is the diagnostic, the
    // rest is surface a log does not need.
    expect(receipt.fields.route).toBe("/deployments");
    expect(receipt.fields).toMatchObject({ status: 500, outcome: "refused" });
  });

  it("names a transport failure by its error NAME, so a timeout is not read as a refusal", async () => {
    const { outcome, receipts } = await captureReceipts(() =>
      client(vi.fn(async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); })).call("/deploy", { method: "POST" }));
    expect((outcome as Error).message).toMatch(/call to \/deploy failed after \d+ms \(TimeoutError\)/);
    expect(receipts.find((r) => r.kind === "maintenance-call")?.fields)
      .toMatchObject({ route: "/deploy", method: "POST", outcome: "failed", errorName: "TimeoutError" });
  });

  it("stays silent on an ordinary fast success", async () => {
    const { outcome, receipts } = await captureReceipts(() =>
      client(vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ environmentId: "staging-local" }) }))).call("/identity"));
    expect(outcome).toBeNull();
    expect(receipts).toEqual([]);
  });

  it("emits no receipt field that could carry a credential", async () => {
    // `emitReceipt` refuses a field whose NAME looks like a credential, so a route named `/token`
    // would throw rather than log — the diagnostics must not be able to break the caller.
    const { outcome } = await captureReceipts(() =>
      client(vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }))).call("/identity"));
    expect((outcome as Error).message).toMatch(/local maintenance refused \(401\)/);
    expect((outcome as Error).message).not.toMatch(/local-token/);
  });
});

describe("the harness preserves evidence BEFORE it destroys the containers", () => {
  const harness = readFileSync("scripts/staging-pair-isolated.sh", "utf8");

  it("captures service logs first, and maintenance among them", () => {
    // `maintenance` spawns its children with `stdio: "inherit"`, so it is the ONLY place the app's
    // own output exists. On the runtime-4 failure only cleanup output and empty receipts survived,
    // because `compose down` removes the containers before the artifact copy runs.
    expect(harness).toContain("capture_service_logs");
    for (const service of ["maintenance", "staging-pg", "prod-pg", "staging-neo4j", "source-object-store", "network-spy"]) {
      expect(harness, service).toMatch(new RegExp(`\\b${service}\\b`));
    }
    const capture = harness.indexOf("capture_service_logs || echo");
    const down = harness.indexOf('"${compose[@]}" down -v --remove-orphans');
    expect(capture).toBeGreaterThan(-1);
    expect(capture, "logs must be captured before the containers are removed").toBeLessThan(down);
  });

  it("captures the bootstrap CLI separately, because `run --rm` output is in no service log", () => {
    expect(harness).toContain('>"$harness_root/bootstrap.log"');
    // The step's ORIGINAL exit status decides the run — not a pipeline's, and not `tee`'s.
    expect(harness).toContain("bootstrap_status=$?");
    expect(harness).toContain('exit "$bootstrap_status"');
    expect(harness).not.toMatch(/bootstrap-rollback[^\n]*\|\s*tee/);
  });

  it("surfaces a redaction failure instead of preserving nothing in silence", () => {
    expect(harness).toContain("harness diagnostics: artifact redaction failed");
    expect(harness).not.toMatch(/redact-artifacts\.mjs "\$harness_root".*\|\| true/);
    // Cleanup is still bounded and still removes the raw root, which holds the keys.
    expect(harness).toContain('rm -rf -- "$harness_root"');
  });
});

describe("redaction covers the shapes the new service logs can carry", () => {
  // The adjudication's caveat: the masking is not comprehensive for arbitrary environment dumps or
  // prefixed multiline PEM, so none is produced — and the shapes that ARE produced are verified.
  const secrets = ["a-generated-harness-secret-value"];

  it("masks through a Compose service+timestamp line prefix", () => {
    const line = "maintenance-1  | 2026-09-07T23:07:22.000Z connecting to postgres://app:stagingpass@staging-pg:5432/brain";
    const out = redactText(line, secrets);
    expect(out).toContain("postgres://[redacted]:[redacted]@staging-pg:5432/brain");
    expect(out).not.toContain("stagingpass");
    // …and the prefix itself survives, or the log stops being attributable to a service.
    expect(out).toContain("maintenance-1  | 2026-09-07T23:07:22.000Z");
  });

  it("masks the health token, which travels in its own header and no bearer rule saw", () => {
    const line = "maintenance-1  | GET /api/health x-aios-staging-health-token: staging-health-token-01234567890123456789";
    expect(redactText(line, secrets)).toContain("x-aios-staging-health-token: [redacted]");
    expect(redactText(line, secrets)).not.toContain("01234567890123456789");
  });

  it("still masks generated secrets and bearer tokens through the same prefix", () => {
    const line = "importer-1  | 2026-09-07T23:07:22.000Z -H 'authorization: Bearer local-maintenance-token' a-generated-harness-secret-value";
    const out = redactText(line, secrets);
    expect(out).not.toContain("local-maintenance-token");
    expect(out).not.toContain("a-generated-harness-secret-value");
  });
});

describe("the controller records what its child actually did", () => {
  const source = readFileSync("scripts/staging-ops/local-maintenance-service.mjs", "utf8");

  it("emits the PID, the exit code and the signal — not just CRASHED", () => {
    for (const receipt of ["deployment-spawned", "deployment-spawn-failed", "deployment-exited", "deployment-stop-requested", "deployment-stop-completed"]) {
      expect(source, receipt).toContain(`emitReceipt("${receipt}"`);
    }
    expect(source).toContain("exitSignal: signal ?? null");
    expect(source).toContain("killedByUs: Boolean(child.killed)");
    // `SUCCESS` is assigned on spawn, not on readiness — recorded in the receipt so nothing
    // downstream reads it as an application health claim.
    expect(source).toContain("statusMeans: \"process spawned, NOT application readiness\"");
  });

  it("changes NO lifecycle behaviour: same signal, same unbounded wait", () => {
    // This pass is diagnostics only. A stop deadline or a process-group kill would be the
    // speculative fix the adjudication defers until the evidence identifies the failure.
    expect(source).toContain('deployment.child.kill("SIGTERM")');
    expect(source).not.toMatch(/SIGKILL/);
    expect(source).not.toMatch(/process\.kill\(-/);
    expect(source).not.toMatch(/detached:\s*true/);
  });

  it("logs no command, no arguments and no environment", () => {
    // The redactor's masking is not comprehensive for arbitrary environment dumps, so none exists.
    const receiptCalls = [...source.matchAll(/emitReceipt\("[a-z-]+", \{([^}]*)\}/g)].map((m) => m[1]);
    expect(receiptCalls.length).toBeGreaterThanOrEqual(5);
    for (const fields of receiptCalls) {
      expect(fields, fields).not.toMatch(/\bcommand\b|\bargs\b|process\.env|\benv\b/);
    }
  });
});
