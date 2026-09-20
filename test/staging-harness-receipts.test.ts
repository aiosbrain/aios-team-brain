import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { emitReceipt, parseReceipts, RECEIPT_PREFIX } from "../scripts/staging-ops/receipts.mjs";
import { preserveArtifacts, redactText } from "../scripts/staging-ops/redact-artifacts.mjs";

/**
 * AC-08's "observable failure and recovery evidence".
 *
 * The harness's failure scenarios asserted `exited non-zero` plus `the prior data is still there` —
 * a pattern satisfied identically by a preflight refusal, a container that never started, and the
 * fault the scenario is actually about, because the prior data was already installed BEFORE the
 * scenario ran. Receipts are the positive statement of which checkpoint was reached, for which run;
 * these tests pin the two properties that make them usable as evidence: they carry identities only,
 * and they survive the harness root's deletion in a redacted form.
 */

describe("receipts carry identities, never credentials", () => {
  it("emits one greppable line per checkpoint", () => {
    const lines: string[] = [];
    emitReceipt("fault-injected", { point: "after-postgres", runId: "run-4", postgresRestored: true }, { write: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`${RECEIPT_PREFIX} fault-injected {"point":"after-postgres","runId":"run-4","postgresRestored":true}`);
    expect(parseReceipts(lines[0])).toEqual([
      { kind: "fault-injected", fields: { point: "after-postgres", runId: "run-4", postgresRestored: true } },
    ]);
  });

  it.each([
    ["a field NAMED like a credential", { databaseUrl: "postgres://host/db" }],
    ["a token field", { healthToken: "abc" }],
    ["a URL carrying credentials", { origin: "postgres://user:hunter2@host/db" }],
    ["a bearer header", { detail: "authorization: Bearer sk-live-1" }],
    // Construct only the synthetic header; the emitted value must still be rejected.
    ["a private key block", { detail: ["-----BEGIN", "PRIVATE KEY-----"].join(" ") }],
  ])("refuses %s", (_name, fields) => {
    expect(() => emitReceipt("fault-injected", fields, { write: () => {} })).toThrow(/credential/);
  });

  it("refuses a non-scalar field, which is where a whole config object would sneak in", () => {
    expect(() => emitReceipt("fault-injected", { env: { A: 1 } } as never, { write: () => {} })).toThrow(/scalar identity/);
  });

  it("ignores non-receipt log noise and truncated lines", () => {
    const log = [
      "staging importer refused: injected harness fault after Postgres restore",
      `${RECEIPT_PREFIX} postgres-restored {"runId":"run-4","kind":"source"}`,
      `${RECEIPT_PREFIX} graph-restored {"runId":"run-4",`,
    ].join("\n");
    expect(parseReceipts(log)).toEqual([{ kind: "postgres-restored", fields: { runId: "run-4", kind: "source" } }]);
  });
});

describe("harness evidence survives cleanup, redacted", () => {
  it("masks generated harness secrets, URL credentials and bearer tokens", () => {
    const text = [
      "connecting to postgres://app:s3cr3t-pw@staging-pg.railway.internal/brain",
      "curl -H 'authorization: Bearer local-maintenance-token' http://127.0.0.1:8080/identity",
      "signing with GENERATED-KEY-MATERIAL-0123456789",
    ].join("\n");
    const redacted = redactText(text, ["GENERATED-KEY-MATERIAL-0123456789"]);
    expect(redacted).not.toContain("GENERATED-KEY-MATERIAL");
    expect(redacted).not.toContain("s3cr3t-pw");
    expect(redacted).not.toContain("local-maintenance-token");
    // ...while staying useful: the identities that make a log diagnosable are still there.
    expect(redacted).toContain("staging-pg.railway.internal");
    expect(redacted).toContain("/identity");
  });

  it("copies only logs and receipts out of the harness root, never the key material", () => {
    const root = mkdtempSync(join(tmpdir(), "aios-receipts-test-"));
    const secrets = join(root, "secrets", "exporter");
    mkdirSync(secrets, { recursive: true });
    writeFileSync(join(secrets, "comparison-key"), "SUPER-SECRET-COMPARISON-KEY-VALUE");
    writeFileSync(join(root, "install-fault-recovers.log"), [
      "staging importer refused: injected harness fault after Postgres restore",
      `${RECEIPT_PREFIX} fault-injected {"point":"after-postgres","runId":"run-4"}`,
      `${RECEIPT_PREFIX} prior-pair-restored {"failedRunId":"run-4","priorRunId":"run-3","postgres":true,"graph":true,"ready":true}`,
      "key was SUPER-SECRET-COMPARISON-KEY-VALUE",
    ].join("\n"));
    const destination = join(root, "artifacts");

    const result = preserveArtifacts({ harnessRoot: root, secretsDir: join(root, "secrets"), destination });

    expect(result).toMatchObject({ copied: 1, receipts: 2 });
    const copied = readFileSync(join(destination, "install-fault-recovers.log"), "utf8");
    expect(copied).not.toContain("SUPER-SECRET-COMPARISON-KEY-VALUE");
    expect(copied).toContain("injected harness fault after Postgres restore");
    const receipts = JSON.parse(readFileSync(join(destination, "receipts.json"), "utf8"));
    expect(receipts.map((r: { kind: string }) => r.kind)).toEqual(["fault-injected", "prior-pair-restored"]);
    expect(receipts[1].fields).toMatchObject({ failedRunId: "run-4", priorRunId: "run-3", postgres: true, graph: true });
  });

  it("uploads only the redacted hidden output directory and fails if receipts are missing", () => {
    const workflow = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8"));
    const steps = workflow.jobs["staging-paired-refresh"].steps as Array<Record<string, unknown>>;
    const upload = steps.find((step) => step.name === "Upload redacted harness receipts and logs") as {
      with: Record<string, unknown>;
    };

    expect(upload.with.path).toBe(".staging-pair-artifacts");
    expect(upload.with["include-hidden-files"]).toBe(true);
    expect(upload.with["if-no-files-found"]).toBe("error");
    expect(JSON.stringify(upload.with)).not.toContain("STAGING_HARNESS_SECRETS_DIR");
  });
});
