import { describe, expect, it } from "vitest";
import { buildManualInviteMessage } from "@/lib/auth/mailer";

// Spec: the manual (no-mail-provider) invite path must hand the admin everything needed to
// share access another way — the team brain URL, the sign-in email, and the password — not just
// a bare password. This is the one artifact the admin UI copies verbatim into Slack/DM/etc.

describe("buildManualInviteMessage", () => {
  it("includes the greeting, explainer, url, email, and password", () => {
    const msg = buildManualInviteMessage({
      inviteeName: "Ada Lovelace",
      teamName: "Acme",
      inviterName: "Grace Hopper",
      teamUrl: "https://brain.acme.test",
      email: "ada@acme.test",
      password: "s3cret-generated-pw",
    });

    expect(msg).toContain("Hi Ada,");
    expect(msg).toContain("Grace Hopper added you to Acme's AIOS Team Brain");
    expect(msg).toContain("Sign in at: https://brain.acme.test");
    expect(msg).toContain("Email: ada@acme.test");
    expect(msg).toContain("Password: s3cret-generated-pw");
  });
});
