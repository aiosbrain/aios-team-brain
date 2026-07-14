import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptGatewayRequestEnvelope,
  encryptGatewayRequestEnvelope,
  GatewayEnvelopeError,
} from "@/lib/gateway/envelope";

describe("gateway-wrong-key", () => {
  it("fails closed with one typed error for a wrong key, tampering, or binding change", () => {
    const binding = { executionId: randomUUID(), serviceIdentityId: randomUUID() };
    const key = Buffer.alloc(32, 44);
    const envelope = encryptGatewayRequestEnvelope({ owner: "acme", repo: "private" }, binding, key);
    const assertClosed = (candidate: Buffer, candidateBinding = binding, candidateKey = key) => {
      try {
        decryptGatewayRequestEnvelope(candidate, candidateBinding, candidateKey);
        throw new Error("unexpected plaintext fallback");
      } catch (error) {
        expect(error).toBeInstanceOf(GatewayEnvelopeError);
        expect(error).toMatchObject({ code: "gateway_envelope_invalid" });
        expect(String(error)).not.toContain("private");
      }
    };
    assertClosed(envelope, binding, Buffer.alloc(32, 45));
    const tampered = Buffer.from(envelope);
    tampered[tampered.length - 1] ^= 1;
    assertClosed(tampered);
    assertClosed(envelope, { ...binding, executionId: randomUUID() });
    expect(decryptGatewayRequestEnvelope(envelope, binding, key)).toEqual({ owner: "acme", repo: "private" });
  });
});
