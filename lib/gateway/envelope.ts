import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GATEWAY_ENVELOPE_MAX_BYTES } from "./types";
import { canonicalize } from "./canonical";

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
  if (key.length !== 32) {
    key.fill(0);
    throw new GatewayEnvelopeError("gateway_envelope_key_invalid");
  }
  return key;
}

function legacyAad(executionId: string, serviceIdentityId: string): Buffer {
  return Buffer.from(`gateway-request-envelope:v1:${executionId}:${serviceIdentityId}`, "utf8");
}

function aad(executionId: string): Buffer {
  return Buffer.from(`aios-gateway-request-envelope:v1\0${executionId}`, "utf8");
}

export function encryptGatewayRequestEnvelope(
  normalizedArgs: unknown,
  binding: { executionId: string; serviceIdentityId: string },
  key?: Buffer,
  fixedNonce?: Buffer,
): Buffer {
  const plaintext = Buffer.from(canonicalize(normalizedArgs as never), "utf8");
  const resolvedKey = key ?? envelopeKey();
  try {
    const iv = fixedNonce ?? randomBytes(IV_BYTES);
    if (iv.length !== IV_BYTES)
      throw new GatewayEnvelopeError("gateway_envelope_invalid");
    const cipher = createCipheriv("aes-256-gcm", resolvedKey, iv);
    cipher.setAAD(aad(binding.executionId));
    const ciphertextAndTag = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const wire = Buffer.from(
      `v1.${iv.toString("base64url")}.${ciphertextAndTag.toString("base64url")}`,
      "ascii",
    );
    if (wire.length > GATEWAY_ENVELOPE_MAX_BYTES)
      throw new GatewayEnvelopeError("gateway_envelope_too_large");
    return wire;
  } finally {
    plaintext.fill(0);
    if (!key) resolvedKey.fill(0);
  }
}

export function decryptGatewayRequestEnvelope<T = unknown>(
  envelope: Buffer,
  binding: { executionId: string; serviceIdentityId: string },
  key?: Buffer,
): T {
  const resolvedKey = key ?? envelopeKey();
  let plaintext: Buffer | null = null;
  try {
    if (envelope.length > GATEWAY_ENVELOPE_MAX_BYTES) {
      throw new Error("malformed");
    }
    let iv: Buffer;
    let tag: Buffer;
    let ciphertext: Buffer;
    let authenticatedData: Buffer;
    if (envelope[0] === VERSION) {
      if (envelope.length < OVERHEAD_BYTES) throw new Error("malformed");
      iv = envelope.subarray(1, 1 + IV_BYTES);
      tag = envelope.subarray(1 + IV_BYTES, OVERHEAD_BYTES);
      ciphertext = envelope.subarray(OVERHEAD_BYTES);
      authenticatedData = legacyAad(binding.executionId, binding.serviceIdentityId);
    } else {
      const parts = envelope.toString("ascii").split(".");
      if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2])
        throw new Error("malformed");
      iv = Buffer.from(parts[1], "base64url");
      const payload = Buffer.from(parts[2], "base64url");
      if (
        iv.length !== IV_BYTES ||
        payload.length < TAG_BYTES ||
        iv.toString("base64url") !== parts[1] ||
        payload.toString("base64url") !== parts[2]
      )
        throw new Error("malformed");
      tag = payload.subarray(-TAG_BYTES);
      ciphertext = payload.subarray(0, -TAG_BYTES);
      authenticatedData = aad(binding.executionId);
    }
    const decipher = createDecipheriv("aes-256-gcm", resolvedKey, iv);
    decipher.setAAD(authenticatedData);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch (error) {
    if (error instanceof GatewayEnvelopeError && error.code === "gateway_envelope_key_invalid") {
      throw error;
    }
    throw new GatewayEnvelopeError("gateway_envelope_invalid");
  } finally {
    plaintext?.fill(0);
    if (!key) resolvedKey.fill(0);
  }
}
