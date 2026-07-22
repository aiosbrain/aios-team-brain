import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decryptSecret,
  decryptSecretBytes,
  encryptSecret,
  generateSecretsKey,
} from "@/lib/secrets/crypto";

const KEY = randomBytes(32);

describe("connector secret crypto (AES-256-GCM)", () => {
  it("round-trips plaintext", () => {
    const token = "xoxb-1234567890-abcdefABCDEF";
    expect(decryptSecret(encryptSecret(token, KEY), KEY)).toBe(token);
  });

  it("can return caller-owned plaintext bytes without consuming a supplied key", () => {
    const key = Buffer.from(KEY);
    const plaintext = decryptSecretBytes(encryptSecret("gateway-pat", key), key);
    expect(plaintext.toString("utf8")).toBe("gateway-pat");
    expect(key).toEqual(KEY);
    plaintext.fill(0);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptSecret("same", KEY)).not.toBe(encryptSecret("same", KEY));
  });

  it("fails to decrypt with the wrong key", () => {
    const blob = encryptSecret("secret", KEY);
    expect(() => decryptSecret(blob, randomBytes(32))).toThrow();
  });

  it("detects tampering (auth tag)", () => {
    const blob = encryptSecret("secret", KEY);
    const buf = Buffer.from(blob, "base64");
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext bit
    expect(() => decryptSecret(buf.toString("base64"), KEY)).toThrow();
  });

  it("rejects a malformed/too-short blob", () => {
    expect(() => decryptSecret("AAAA", KEY)).toThrow();
  });

  it("generateSecretsKey yields a 32-byte base64 key", () => {
    expect(Buffer.from(generateSecretsKey(), "base64").length).toBe(32);
  });
});
