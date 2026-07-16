import { createCipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalize } from "@/lib/gateway/canonical";
import {
  decryptGatewayRequestEnvelope,
  encryptGatewayRequestEnvelope,
} from "@/lib/gateway/envelope";
import { sealCredential } from "@/lib/gateway/sealed-credential";

const fixturePath = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "contract",
  "gateway-approval-v1.10.json",
);
const bytes = readFileSync(fixturePath);
const fixture = JSON.parse(bytes.toString("utf8"));

describe("gateway approval v1.10 vendored contract", () => {
  it("is the reviewed Workspace fixture and pins the AIO-401 base", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "b1bed83fbdd4e6cfff2200a4cefa828a2d770c66f898e9e7d704511935cc5e62",
    );
    expect(fixture.baseContract.sha256).toBe(
      "4ddd6495fa505b76118080865d60255bfba94a9ccda249defe428babb3d0c205",
    );
    expect(fixture.versionBoundary).toEqual({
      documentRevision: "1.10",
      memberApi: "1.9",
      internalGateway: "1.10",
    });
  });

  it("discovers every required route and failure family non-vacuously", () => {
    const expected = fixture.discovery.expected;
    expect(Number(expected.resumeRoutes)).toBeGreaterThan(0);
    expect(Number(expected.adminRoutes)).toBeGreaterThan(0);
    expect(Object.keys(fixture.admin.routes)).toHaveLength(expected.adminRoutes);
    expect(fixture.resumeClaim.path).toContain("resume-claim");
    expect(Object.keys(fixture.transport.errors)).toHaveLength(expected.errors);
    expect(fixture.transport.nonEnumerating404).toHaveLength(
      expected.nonEnumerating404Families,
    );
  });

  it("matches every frozen non-vacuous discovery count", () => {
    const actual = {
      resumeRoutes: 1,
      adminRoutes: Object.keys(fixture.admin.routes).length,
      errors: Object.keys(fixture.transport.errors).length,
      nonEnumerating404Families: fixture.transport.nonEnumerating404.length,
      authorizationRoles: Object.keys(fixture.admin.authorizationMatrix).length,
      policyVectors: fixture.policyPrecedence.vectors.length,
      stateTransitions: fixture.stateMachine.transitions.length,
      outcomeClassifications: fixture.stateMachine.transitions.filter(
        (transition: { event: string }) => transition.event.startsWith("outcome-"),
      ).length,
      cryptographicVectors: Object.keys(fixture.vectors).length,
      securityNeverExpose: fixture.security.neverExpose.length,
    };
    expect(actual).toEqual(fixture.discovery.expected);
    expect(Object.values(actual).every((count) => count > 0)).toBe(true);
  });

  it("freezes the exact resume request and credential-free retry", () => {
    expect(fixture.resumeClaim.request.required).toEqual([
      "executorTenantId",
      "executorSubjectId",
      "toolkit",
      "tool",
      "requestHash",
      "correlationId",
      "idempotencyKey",
    ]);
    expect(fixture.resumeClaim.request.additionalProperties).toBe(false);
    const retry = fixture.resumeClaim.responses.alreadyClaimed;
    expect(retry.credentialBearing).toBe(false);
    expect(retry.body.forbidden).toEqual([
      "normalizedArgs",
      "sealedCredential",
      "credentialExpiresAt",
    ]);
  });

  it("matches the resume fingerprint vector", () => {
    const vector = fixture.vectors.resumeFingerprint;
    expect(canonicalize(vector.value)).toBe(vector.jcs);
    expect(createHash("sha256").update(vector.jcs).digest("hex")).toBe(
      vector.sha256,
    );
  });

  it("seals exactly to the rotated credential version vector", () => {
    const vector = fixture.vectors.rotatedCredentialSeal;
    const sealed = sealCredential({
      pat: Buffer.from(vector.plaintextUtf8),
      serviceSecret: Buffer.from(vector.materialBase64url, "base64url"),
      credentialId: vector.credentialId,
      credentialVersion: vector.credentialVersion,
      serviceIdentityId: "11111111-1111-4111-8111-111111111111",
      executionId: "22222222-2222-4222-8222-222222222222",
      now: 1784044800,
      nonce: Buffer.from(vector.nonceHex, "hex"),
    });
    expect(sealed.sealedCredential).toBe(vector.sealed);
  });

  it("encrypts, hashes, and decrypts the request-envelope vector", () => {
    const vector = fixture.vectors.requestEnvelope;
    const envelope = encryptGatewayRequestEnvelope(
      JSON.parse(vector.normalizedArgsJcs),
      {
        executionId: "22222222-2222-4222-8222-222222222222",
        serviceIdentityId: "11111111-1111-4111-8111-111111111111",
      },
      Buffer.from(vector.keyHex, "hex"),
      Buffer.from(vector.nonceHex, "hex"),
    );
    expect(envelope.toString("ascii")).toBe(vector.wire);
    expect(createHash("sha256").update(envelope).digest("hex")).toBe(
      vector.wireSha256,
    );
    expect(
      decryptGatewayRequestEnvelope(
        envelope,
        {
          executionId: "22222222-2222-4222-8222-222222222222",
          serviceIdentityId: "11111111-1111-4111-8111-111111111111",
        },
        Buffer.from(vector.keyHex, "hex"),
      ),
    ).toEqual({ owner: "octo", repo: "project" });
  });

  it("continues decrypting committed AIO-401 binary envelopes", () => {
    const executionId = "22222222-2222-4222-8222-222222222222";
    const serviceIdentityId = "11111111-1111-4111-8111-111111111111";
    const key = Buffer.alloc(32, 7);
    const nonce = Buffer.alloc(12, 8);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(
      Buffer.from(
        `gateway-request-envelope:v1:${executionId}:${serviceIdentityId}`,
      ),
    );
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ owner: "octo", repo: "project" })),
      cipher.final(),
    ]);
    const legacy = Buffer.concat([
      Buffer.from([1]),
      nonce,
      cipher.getAuthTag(),
      ciphertext,
    ]);
    expect(
      decryptGatewayRequestEnvelope(
        legacy,
        { executionId, serviceIdentityId },
        key,
      ),
    ).toEqual({ owner: "octo", repo: "project" });
  });

  it("requires authoritative credential rows and two approved writers", () => {
    expect(fixture.persistence.credentialTable).toBe(
      "gateway_service_credentials",
    );
    expect(fixture.persistence.legacyPreflightError).toBe(
      "gateway_service_identity_legacy_preflight",
    );
    expect(fixture.persistence.gatewaySqlWriters).toEqual([
      "lib/gateway/persistence.ts",
      "lib/gateway/admin-persistence.ts",
    ]);
  });

  it("exhaustively discovers precedence and state transitions", () => {
    const expected = fixture.discovery.expected;
    expect(fixture.policyPrecedence.vectors).toHaveLength(expected.policyVectors);
    expect(fixture.stateMachine.transitions).toHaveLength(
      expected.stateTransitions,
    );
    expect(fixture.stateMachine.oneEventIndexes).toEqual([
      "decision",
      "claim",
      "rotation",
      "revocation",
      "expiry",
      "settlement",
    ]);
  });

  it("keeps the admin queue and credential metadata secret-free", () => {
    const queue =
      fixture.admin.routes.approvalQueue.response.properties.approvals.items
        .required;
    expect(queue).not.toContain("encryptedRequestEnvelope");
    expect(queue).not.toContain("credentialCiphertext");
    expect(queue).not.toContain("requestHash");
    expect(fixture.admin.credentialMetadataFieldsExactly).not.toContain("secret");
    expect(fixture.security.neverExpose).toHaveLength(
      fixture.discovery.expected.securityNeverExpose,
    );
  });

  it("vendors exhaustive strict admin schemas", () => {
    const schemas = fixture.admin.schemas;
    expect(Object.keys(schemas)).toEqual([
      "gateway-subject-selector",
      "gateway-policy-mutation",
      "gateway-policy-metadata",
      "gateway-credential-metadata",
    ]);
    for (const route of Object.values(fixture.admin.routes) as Array<{
      method: string;
      path: string;
      response?: unknown;
    }>) {
      expect(route.response, `${route.method} ${route.path}`).toBeDefined();
    }
    const rotation = fixture.admin.routes.credentialRotate.request;
    expect(rotation.additionalProperties).toBe(false);
    expect(rotation.properties.secret).toMatchObject({
      decodedBytes: 32,
      minimumEntropyBits: 256,
    });
    const tier = schemas["gateway-subject-selector"].oneOf.find(
      (candidate: { properties: { type: { const: string } } }) =>
        candidate.properties.type.const === "tier",
    );
    expect(tier.properties.tier.enum).toEqual(["team", "external"]);
    expect(schemas["gateway-policy-mutation"].properties.priority).toEqual({
      type: "integer",
      minimum: -2147483648,
      maximum: 2147483647,
    });
  });
});
