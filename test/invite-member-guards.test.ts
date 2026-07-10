import { describe, expect, it } from "vitest";
import { isValidInviteEmail, isMemberUniqueConstraintViolation, MemberExistsError } from "@/lib/admin/members";

// Spec: inviteMember (app/t/[team]/admin/actions.ts) must reject a malformed email BEFORE ever
// calling createMember — no malformed address should reach the DB or mint a member row. The
// validator is a thin zod .email() wrapper; the assertion is about the boundary it draws (what's
// accepted vs rejected), not about re-testing zod itself.
describe("isValidInviteEmail", () => {
  it("accepts well-formed addresses", () => {
    expect(isValidInviteEmail("ada@acme.test")).toBe(true);
    expect(isValidInviteEmail("first.last+tag@sub.example.co")).toBe(true);
  });

  it("rejects malformed addresses", () => {
    expect(isValidInviteEmail("")).toBe(false);
    expect(isValidInviteEmail("not-an-email")).toBe(false);
    expect(isValidInviteEmail("missing-domain@")).toBe(false);
    expect(isValidInviteEmail("@missing-local.test")).toBe(false);
    expect(isValidInviteEmail("spaces in@email.test")).toBe(false);
  });
});

// Spec: createMember must turn a raw pg unique-constraint violation on `members` (team+email or
// team+actor_handle) into a friendly, dedicated MemberExistsError — never leak the raw
// "duplicate key value violates unique constraint ..." pg text to the admin UI or CLI.
describe("isMemberUniqueConstraintViolation", () => {
  it("recognizes the team+email unique-constraint violation", () => {
    const msg =
      'duplicate key value violates unique constraint "members_team_id_email_key"';
    expect(isMemberUniqueConstraintViolation(msg)).toBe(true);
  });

  it("recognizes the team+actor_handle unique-constraint violation", () => {
    const msg =
      'duplicate key value violates unique constraint "members_team_id_actor_handle_key"';
    expect(isMemberUniqueConstraintViolation(msg)).toBe(true);
  });

  it("does not match unrelated pg errors", () => {
    expect(isMemberUniqueConstraintViolation("connection terminated unexpectedly")).toBe(false);
    expect(isMemberUniqueConstraintViolation('violates foreign key constraint "members_team_id_fkey"')).toBe(
      false
    );
  });
});

describe("MemberExistsError", () => {
  it("carries the friendly message, not the raw pg text", () => {
    const err = new MemberExistsError();
    expect(err.message).toBe("a member with this email or handle already exists");
    expect(err.name).toBe("MemberExistsError");
    expect(err).toBeInstanceOf(Error);
  });
});
