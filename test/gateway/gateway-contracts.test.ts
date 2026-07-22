import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GATEWAY_CONTRACT_VERSION } from "@/lib/api/version";
import { canonicalize } from "@/lib/gateway/canonical";
import {
  gatewayRequestHash,
  normalizeGatewayArgs,
} from "@/lib/gateway/normalize";
import {
  evaluateGatewayPolicy,
  type GatewayPolicyRow,
} from "@/lib/gateway/policy";
import {
  openSealedCredential,
  sealCredential,
} from "@/lib/gateway/sealed-credential";

const path = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "contract",
  "gateway-v1.10.json",
);
const bytes = readFileSync(path);
const fixture = JSON.parse(bytes.toString("utf8"));

describe("gateway-v1.10 vendored contract", () => {
  it("is the reviewed byte-for-byte fixture", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "4ddd6495fa505b76118080865d60255bfba94a9ccda249defe428babb3d0c205",
    );
    expect(fixture.version).toBe(GATEWAY_CONTRACT_VERSION);
    expect(Object.keys(fixture.routes)).toHaveLength(3);
    expect(Object.keys(fixture.tools.definitions)).toHaveLength(7);
  });
  it("normalizes and hashes every positive vector", () => {
    for (const vector of fixture.tools.hashVectors) {
      const normalized = normalizeGatewayArgs(vector.tool, vector.input);
      expect(normalized, vector.name).toEqual(vector.normalizedArgs);
      expect(canonicalize(normalized), vector.name).toBe(vector.jcs);
      expect(gatewayRequestHash(normalized), vector.name).toBe(
        vector.requestHash,
      );
    }
  });
  it("rejects every negative vector", () => {
    for (const vector of fixture.tools.negativeVectors)
      expect(
        () => normalizeGatewayArgs(vector.tool, vector.input),
        vector.name,
      ).toThrow("Invalid gateway arguments");
  });
  it("independently seals and opens the fixed vector", () => {
    const v = fixture.sealedCredential.vector;
    const sealed = sealCredential({
      pat: Buffer.from(v.plaintextUtf8),
      serviceSecret: Buffer.from(v.materialBytesHex, "hex"),
      credentialId: v.credentialId,
      credentialVersion: v.credentialVersion,
      serviceIdentityId: v.serviceIdentityId,
      executionId: v.executionId,
      now: v.iat,
      nonce: Buffer.from(v.nonceHex, "hex"),
    });
    expect(sealed.sealedCredential).toBe(v.sealed);
    expect(
      openSealedCredential({
        sealedCredential: sealed.sealedCredential,
        serviceSecret: Buffer.from(v.materialBytesHex, "hex"),
        credentialId: v.credentialId,
        credentialVersion: v.credentialVersion,
        serviceIdentityId: v.serviceIdentityId,
        executionId: v.executionId,
        now: v.iat,
      }).toString(),
    ).toBe(v.plaintextUtf8);
  });
});

describe("gateway policy precedence", () => {
  const row = (over: Partial<GatewayPolicyRow>): GatewayPolicyRow => ({
    id: randomUUID(),
    subject_role: null,
    subject_tier: null,
    subject_actor: null,
    action: "gateway.aios-github-readonly.*",
    resource: "github.repository:*",
    priority: 0,
    effect: "allow",
    updated_at: "2026-07-14T00:00:00.000Z",
    ...over,
  });
  const input = {
    principal: {
      actor: "alex",
      role: "member" as const,
      tier: "team" as const,
    },
    tool: "github.repository.get",
    owner: "octo",
    repo: "project",
  };
  it("orders subject, tool, resource, priority, then restrictive effect", () => {
    const winner = row({
      id: "00000000-0000-4000-8000-000000000001",
      subject_actor: "alex",
      action: "gateway.aios-github-readonly.github.repository.get",
      resource: "github.repository:octo/project",
      priority: 3,
      effect: "require_approval",
    });
    const result = evaluateGatewayPolicy(
      [row({ priority: 999, effect: "deny" }), winner],
      input,
    );
    expect(result.decision).toBe("require_approval");
    expect(result.policyRuleId).toBe(winner.id);
  });
  it("defaults to block", () =>
    expect(evaluateGatewayPolicy([], input).decision).toBe("block"));
});
