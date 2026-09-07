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

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalJson(value) {
  return canonical(value);
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function signedBytes(manifest) {
  const { signature: _signature, ...unsigned } = manifest;
  return Buffer.from(canonicalJson(unsigned));
}

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

export function openSignedEncryptedBundle({ bundle, exporterSigningPublicKey, importerEncryptionPrivateKey }) {
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
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(String(bundle.nonce ?? ""), "base64"));
    decipher.setAuthTag(Buffer.from(String(bundle.authTag ?? ""), "base64"));
    const payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const { signature: _signature, ...unsigned } = manifest;
    return { manifest: unsigned, payload };
  } catch {
    throw new Error("bundle authenticated decryption failed");
  }
}
