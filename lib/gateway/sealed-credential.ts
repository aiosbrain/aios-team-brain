import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { canonicalize } from "./canonical";

const SALT = createHash("sha256")
  .update("aios-gateway-sealed-credential:v1", "ascii")
  .digest();
export const SEALED_CREDENTIAL_MAX_LIFETIME_SECONDS = 15;
type Header = {
  v: 1;
  kid: string;
  sid: string;
  eid: string;
  provider: "github";
  iat: number;
  exp: number;
};

function key(secret: Buffer, credentialId: string, version: number): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      SALT,
      Buffer.from(`${credentialId}\0${version}`, "utf8"),
      32,
    ),
  );
}

export function sealCredential(input: {
  pat: Buffer;
  serviceSecret: Buffer;
  credentialId: string;
  credentialVersion: number;
  serviceIdentityId: string;
  executionId: string;
  now?: number;
  nonce?: Buffer;
}): { sealedCredential: string; expiresAt: number } {
  const iat = input.now ?? Math.floor(Date.now() / 1000);
  const exp = iat + SEALED_CREDENTIAL_MAX_LIFETIME_SECONDS;
  const header: Header = {
    v: 1,
    kid: `${input.credentialId}.v${input.credentialVersion}`,
    sid: input.serviceIdentityId,
    eid: input.executionId,
    provider: "github",
    iat,
    exp,
  };
  const protectedBytes = Buffer.from(canonicalize(header), "utf8");
  const nonce = input.nonce ?? randomBytes(12);
  if (nonce.length !== 12) throw new Error("gateway_seal_failed");
  const derived = key(
    input.serviceSecret,
    input.credentialId,
    input.credentialVersion,
  );
  try {
    const cipher = createCipheriv("aes-256-gcm", derived, nonce);
    cipher.setAAD(protectedBytes);
    const payload = Buffer.concat([
      cipher.update(input.pat),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return {
      sealedCredential: `v1.${protectedBytes.toString("base64url")}.${nonce.toString("base64url")}.${payload.toString("base64url")}`,
      expiresAt: exp,
    };
  } finally {
    derived.fill(0);
  }
}

export function openSealedCredential(input: {
  sealedCredential: string;
  serviceSecret: Buffer;
  credentialId: string;
  credentialVersion: number;
  serviceIdentityId: string;
  executionId: string;
  now?: number;
}): Buffer {
  const [wireVersion, encodedHeader, encodedNonce, encodedPayload, extra] =
    input.sealedCredential.split(".");
  if (
    wireVersion !== "v1" ||
    !encodedHeader ||
    !encodedNonce ||
    !encodedPayload ||
    extra
  )
    throw new Error("gateway_sealed_credential_invalid");
  const headerBytes = Buffer.from(encodedHeader, "base64url");
  const nonce = Buffer.from(encodedNonce, "base64url");
  const payload = Buffer.from(encodedPayload, "base64url");
  let header: Header;
  try {
    header = JSON.parse(headerBytes.toString("utf8")) as Header;
  } catch {
    throw new Error("gateway_sealed_credential_invalid");
  }
  const expectedKeys = ["eid", "exp", "iat", "kid", "provider", "sid", "v"];
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (
    headerBytes.toString("base64url") !== encodedHeader ||
    nonce.toString("base64url") !== encodedNonce ||
    payload.toString("base64url") !== encodedPayload ||
    canonicalize(header) !== headerBytes.toString("utf8") ||
    JSON.stringify(Object.keys(header).sort()) !==
      JSON.stringify(expectedKeys) ||
    header.v !== 1 ||
    header.kid !== `${input.credentialId}.v${input.credentialVersion}` ||
    header.sid !== input.serviceIdentityId ||
    header.eid !== input.executionId ||
    header.provider !== "github" ||
    !Number.isInteger(header.iat) ||
    !Number.isInteger(header.exp) ||
    header.exp <= header.iat ||
    header.exp - header.iat > SEALED_CREDENTIAL_MAX_LIFETIME_SECONDS ||
    now < header.iat ||
    now >= header.exp ||
    nonce.length !== 12 ||
    payload.length < 16
  )
    throw new Error("gateway_sealed_credential_invalid");
  const derived = key(
    input.serviceSecret,
    input.credentialId,
    input.credentialVersion,
  );
  try {
    const decipher = createDecipheriv("aes-256-gcm", derived, nonce);
    decipher.setAAD(headerBytes);
    decipher.setAuthTag(payload.subarray(-16));
    return Buffer.concat([
      decipher.update(payload.subarray(0, -16)),
      decipher.final(),
    ]);
  } catch {
    throw new Error("gateway_sealed_credential_invalid");
  } finally {
    derived.fill(0);
  }
}
