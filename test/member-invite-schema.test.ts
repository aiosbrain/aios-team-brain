import { describe, expect, it } from "vitest";
import { memberInviteRequestSchema } from "@/lib/api/schemas";

// Spec: the POST /api/v1/members/invite request body (brain-api v1.7) is snake_case, strict, and
// gates the provisioning `tools` vocabulary. These assert the contract's accept/reject boundary and
// its defaults — a route that parses a body outside this shape must 422, not silently coerce.

const valid = {
  email: "ada@acme.test",
  display_name: "Ada Lovelace",
  actor_handle: "ada",
};

describe("memberInviteRequestSchema", () => {
  it("accepts a minimal body and applies role + tools defaults", () => {
    const parsed = memberInviteRequestSchema.parse(valid);
    expect(parsed.role).toBe("member");
    expect(parsed.tools).toBe("all");
  });

  it("accepts an explicit tool array, the 'all' literal, and the 'none' literal", () => {
    expect(memberInviteRequestSchema.safeParse({ ...valid, tools: ["linear", "slack"] }).success).toBe(true);
    expect(memberInviteRequestSchema.safeParse({ ...valid, tools: "all" }).success).toBe(true);
    expect(memberInviteRequestSchema.safeParse({ ...valid, tools: "none" }).success).toBe(true);
    expect(memberInviteRequestSchema.safeParse({ ...valid, tools: [] }).success).toBe(true);
  });

  it("rejects an unknown tool name in the array", () => {
    expect(memberInviteRequestSchema.safeParse({ ...valid, tools: ["linear", "jira"] }).success).toBe(false);
    expect(memberInviteRequestSchema.safeParse({ ...valid, tools: "everything" }).success).toBe(false);
  });

  it("rejects a malformed email", () => {
    expect(memberInviteRequestSchema.safeParse({ ...valid, email: "not-an-email" }).success).toBe(false);
    expect(memberInviteRequestSchema.safeParse({ ...valid, email: "" }).success).toBe(false);
  });

  it("requires a non-empty display_name and actor_handle", () => {
    expect(memberInviteRequestSchema.safeParse({ ...valid, display_name: "" }).success).toBe(false);
    expect(memberInviteRequestSchema.safeParse({ ...valid, actor_handle: "  " }).success).toBe(false);
  });

  it("accepts each allowed role and rejects an unknown role", () => {
    for (const role of ["member", "lead", "admin"]) {
      expect(memberInviteRequestSchema.safeParse({ ...valid, role }).success, role).toBe(true);
    }
    expect(memberInviteRequestSchema.safeParse({ ...valid, role: "owner" }).success).toBe(false);
  });

  it("is strict — rejects unknown top-level keys", () => {
    expect(memberInviteRequestSchema.safeParse({ ...valid, password: "sneaky" }).success).toBe(false);
    expect(memberInviteRequestSchema.safeParse({ ...valid, tier: "external" }).success).toBe(false);
  });
});
