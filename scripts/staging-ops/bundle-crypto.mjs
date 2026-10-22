import {
  createCipheriv,
  createDecipheriv,
  createHash,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  sign,
  verify,
  constants,
} from "node:crypto";

/**
 * Canonical bytes for signing. It must agree with what actually TRAVELS, and the transport is
 * `JSON.stringify`.
 *
 * `JSON.stringify` treats `undefined` three different ways: it DROPS an object property, it emits
 * `null` for an array hole or element, and it returns `undefined` (not a string) at the top level.
 * This serializer walked into all three — `JSON.stringify(undefined)` returns the JavaScript value
 * `undefined`, which template-interpolates as the literal text `undefined` and is not JSON at all.
 * So a manifest carrying an undefined field would be signed over bytes describing a field that
 * never leaves, and verification on the far side would be over a different document.
 *
 * Refused before signing rather than normalised, because there is no normalisation that is right:
 * dropping matches the object case and contradicts the array case. Currently valid manifests are
 * unaffected — no field is legitimately undefined, and every byte they produce is unchanged. Also
 * refuses the other non-JSON values that would silently become `undefined` or a wrong literal:
 * functions, symbols and BigInt (which throws), and non-finite numbers (which stringify to `null`).
 */
function assertJsonSerializable(value, path = "manifest") {
  if (value === null) return;
  const type = typeof value;
  if (type === "undefined") throw new Error(`${path} is undefined, which JSON cannot represent consistently`);
  if (type === "function" || type === "symbol" || type === "bigint") throw new Error(`${path} is a ${type}, which JSON cannot represent`);
  if (type === "number" && !Number.isFinite(value)) throw new Error(`${path} is a non-finite number, which JSON cannot represent`);
  if (Array.isArray(value)) {
    // A HOLE is `undefined` on read but is not an own property, so `hasOwn` is the only way to see
    // it. `[,1]` and `[undefined,1]` both stringify to `[null,1]`, and both are refused.
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new Error(`${path}[${index}] is an array hole, which JSON cannot represent consistently`);
      assertJsonSerializable(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (type === "object") for (const key of Object.keys(value)) assertJsonSerializable(value[key], `${path}.${key}`);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalJson(value) {
  assertJsonSerializable(value);
  return canonical(value);
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function signedBytes(manifest) {
  const { signature: _signature, ...unsigned } = manifest;
  return Buffer.from(canonicalJson(unsigned));
}

const authenticatedRollbackOpenings = new WeakSet();

export function createSignedEncryptedBundle({ payload, manifest, exporterSigningPrivateKey, importerEncryptionPublicKey }) {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(payload)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const unsigned = {
    ...manifest,
    encryption: "AES-256-GCM+RSA-OAEP-SHA256",
    signing: "Ed25519",
    ciphertextSha256: sha256(ciphertext),
  };
  const signature = sign(null, signedBytes(unsigned), exporterSigningPrivateKey).toString("base64");
  const sealedKey = publicEncrypt(
    { key: importerEncryptionPublicKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING },
    key
  );
  return {
    manifest: { ...unsigned, signature },
    nonce: nonce.toString("base64"),
    authTag: authTag.toString("base64"),
    sealedKey: sealedKey.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function openSignedEncryptedBundle({ bundle, exporterSigningPublicKey, importerEncryptionPrivateKey, signerPurpose = "source" }) {
  const manifest = bundle?.manifest ?? {};
  const signature = Buffer.from(String(manifest.signature ?? ""), "base64");
  if (!verify(null, signedBytes(manifest), exporterSigningPublicKey, signature)) throw new Error("bundle publisher signature verification failed");
  const ciphertext = Buffer.from(String(bundle.ciphertext ?? ""), "base64");
  if (sha256(ciphertext) !== manifest.ciphertextSha256) throw new Error("bundle ciphertext digest mismatch");
  const key = privateDecrypt(
    { key: importerEncryptionPrivateKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(String(bundle.sealedKey ?? ""), "base64")
  );
  try {
    // `authTagLength: 16` is load-bearing, not decoration. Node's GCM decipher accepts a SHORT tag
    // by default (4, 8, 12–16 bytes), and a short tag is verified by comparing only that many
    // bytes — so a valid 16-byte tag truncated to 4 bytes still authenticates and the bundle
    // opens. That reduces forgery resistance from 2^-128 to 2^-32 against an attacker who can
    // edit the transported `authTag` field. Every bundle this module produces carries the full
    // 16-byte tag `getAuthTag()` returns, so pinning the length rejects only tampered inputs.
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(String(bundle.nonce ?? ""), "base64"), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(String(bundle.authTag ?? ""), "base64"));
    const payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const { signature: _signature, ...unsigned } = manifest;
    const opened = { manifest: unsigned, payload };
    if (signerPurpose === "rollback") authenticatedRollbackOpenings.add(opened);
    return opened;
  } catch {
    throw new Error("bundle authenticated decryption failed");
  }
}

/** Opaque proof minted only after successful verification with the importer-owned rollback key. */
export function rollbackOpeningProvenance(opened) {
  if (!authenticatedRollbackOpenings.has(opened)) return null;
  const token = Object.freeze({});
  authenticatedRollbackOpenings.add(token);
  return token;
}

/** A caller-controlled manifest kind or lookalike object can never satisfy this predicate. */
export function isAuthenticatedRollbackProvenance(value) {
  return Boolean(value && authenticatedRollbackOpenings.has(value));
}
