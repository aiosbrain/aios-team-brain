import { describe, expect, it } from "vitest";
import { hashPassword, verifyPasswordHash, isPasswordStrongEnough, randomPassword, MIN_PASSWORD_LENGTH } from "./password";

describe("password hashing", () => {
  it("round-trips: the correct password verifies against its own hash", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPasswordHash("correct-horse-battery-staple", hash)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPasswordHash("wrong-password", hash)).toBe(false);
  });

  it("is salted — hashing the same password twice yields different hashes", async () => {
    const a = await hashPassword("same-password-both-times");
    const b = await hashPassword("same-password-both-times");
    expect(a).not.toBe(b);
    // ...but both still verify the original password.
    expect(await verifyPasswordHash("same-password-both-times", a)).toBe(true);
    expect(await verifyPasswordHash("same-password-both-times", b)).toBe(true);
  });

  it("never throws on a malformed stored hash — treats it as a non-match", async () => {
    await expect(verifyPasswordHash("anything", "not-a-real-hash")).resolves.toBe(false);
    await expect(verifyPasswordHash("anything", "scrypt:bad:bad:bad:zz:zz")).resolves.toBe(false);
    await expect(verifyPasswordHash("anything", "")).resolves.toBe(false);
  });

  it("isPasswordStrongEnough enforces the minimum length", () => {
    expect(isPasswordStrongEnough("a".repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false);
    expect(isPasswordStrongEnough("a".repeat(MIN_PASSWORD_LENGTH))).toBe(true);
  });

  it("randomPassword generates strong, distinct passwords", () => {
    const a = randomPassword();
    const b = randomPassword();
    expect(a).not.toBe(b);
    expect(isPasswordStrongEnough(a)).toBe(true);
  });
});
