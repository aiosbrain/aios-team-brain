import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import snapshot from "../fixtures/contract/brain-contract.json";
import { BRAIN_API_VERSION, GATEWAY_CONTRACT_VERSION } from "@/lib/api/version";
import { MAX_INTAKE_BYTES } from "@/lib/codebases/debt-intake-body";

const directory = join(import.meta.dirname, "../fixtures/contract");
const contract = snapshot.debtIntakeEventsContract;

describe("AIO-1101 immutable upstream contract", () => {
  it("implements member 1.26 without relabeling scanner or gateway payloads", () => {
    expect(BRAIN_API_VERSION).toBe(contract.version);
    expect(BRAIN_API_VERSION).toBe("1.26");
    expect(snapshot.codebasePayloadContract.version).toBe("1.25");
    expect(GATEWAY_CONTRACT_VERSION).toBe("1.10");
    expect(MAX_INTAKE_BYTES).toBe(contract.maxRawBodyBytes);
  });
  it("vendors every intake byte at the hash declared by merged Workspace689", () => {
    const references = [contract.canonicalContract, contract.canonicalSchema,
      contract.knownAnswers, contract.trustedConfig, contract.schema,
      contract.ackSchema, contract.fixtures, ...contract.canonicalFixtures];
    for (const reference of references) {
      const bytes = readFileSync(join(directory, reference.path));
      expect(createHash("sha256").update(bytes).digest("hex"), reference.path).toBe(reference.sha256);
    }
    expect(contract.harnessCommit).toBe("691762a469f5e816d35a6263467c9e2d8cc98e8e");
    expect(contract.canonicalSchema.sha256).toBe("a51f360769ab26440287891867447baf6e3df93073df6f0d7febc1f3c10322b2");
  });
});
