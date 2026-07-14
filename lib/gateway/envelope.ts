import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GATEWAY_ENVELOPE_MAX_BYTES } from "./types";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const OVERHEAD_BYTES = 1 + IV_BYTES + TAG_BYTES;

export type GatewayEnvelopeErrorCode =
  | "gateway_envelope_key_invalid"
  | "gateway_envelope_too_large"
  | "gateway_envelope_invalid";

export class GatewayEnvelopeError extends Error {
  constructor(readonly code: GatewayEnvelopeErrorCode) {
    super(code);
    this.name = "GatewayEnvelopeError";
  }
}

function envelopeKey(raw = process.env.GATEWAY_REQUEST_ENVELOPE_KEY): Buffer {
  if (!raw) throw new GatewayEnvelopeError("gateway_envelope_key_invalid");
  const trimmed = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== 32) throw new GatewayEnvelopeError("gateway_envelope_key_invalid");
  return key;
}

function aad(executionId: string, serviceIdentityId: string): Buffer {
  return Buffer.from(`gateway-request-envelope:v1:${executionId}:${serviceIdentityId}`, "utf8");
}

export function encryptGatewayRequestEnvelope(
  normalizedArgs: unknown,
  binding: { executionId: string; serviceIdentityId: string },
  key: Buffer = envelopeKey()
): Buffer {
  const plaintext = Buffer.from(JSON.stringify(normalizedArgs), "utf8");
  if (plaintext.length + OVERHEAD_BYTES > GATEWAY_ENVELOPE_MAX_BYTES) {
    throw new GatewayEnvelopeError("gateway_envelope_too_large");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(binding.executionId, binding.serviceIdentityId));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptGatewayRequestEnvelope<T = unknown>(
  envelope: Buffer,
  binding: { executionId: string; serviceIdentityId: string },
  key: Buffer = envelopeKey()
): T {
  try {
    if (
      envelope.length < OVERHEAD_BYTES ||
      envelope.length > GATEWAY_ENVELOPE_MAX_BYTES ||
      envelope[0] !== VERSION
    ) {
      throw new Error("malformed");
    }
    const iv = envelope.subarray(1, 1 + IV_BYTES);
    const tag = envelope.subarray(1 + IV_BYTES, OVERHEAD_BYTES);
    const ciphertext = envelope.subarray(OVERHEAD_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad(binding.executionId, binding.serviceIdentityId));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch (error) {
    if (error instanceof GatewayEnvelopeError && error.code === "gateway_envelope_key_invalid") {
      throw error;
    }
    throw new GatewayEnvelopeError("gateway_envelope_invalid");
  }
}
