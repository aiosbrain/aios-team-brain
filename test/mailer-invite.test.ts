import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildManualInviteMessage, sendInviteEmail } from "@/lib/auth/mailer";

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
      password: "example-invite-password",
    });

    expect(msg).toContain("Hi Ada,");
    expect(msg).toContain("Grace Hopper added you to Acme's AIOS Team Brain");
    expect(msg).toContain("Sign in at: https://brain.acme.test");
    expect(msg).toContain("Email: ada@acme.test");
    expect(msg).toContain("Password: example-invite-password");
  });
});

// Spec: the magic-link invite email renders a "Your team tools" section from the provisioning
// cascade — a Slack join link (as an anchor), and a note that Linear/GitHub invites arrive
// separately when those tools sent one. Everything interpolated is HTML-escaped (the Slack link is
// admin-controlled config). We capture the payload by stubbing the Resend HTTP call.
describe("sendInviteEmail — Your team tools", () => {
  const base = {
    inviteeName: "Ada Lovelace",
    teamName: "Acme",
    inviterName: "Grace Hopper",
    loginUrl: "https://brain.acme.test/auth/confirm?token=abc",
  };

  let captured: { text: string; html: string } | null;

  beforeEach(() => {
    captured = null;
    process.env.RESEND_API_KEY = "test-key";
    process.env.RESEND_FROM = "AIOS <noreply@acme.test>";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        captured = { text: body.text ?? "", html: body.html ?? "" };
        return new Response(JSON.stringify({ id: "x" }), { status: 200 });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
  });

  it("renders the Slack join link (escaped) + Linear/GitHub notes when provided", async () => {
    const delivered = await sendInviteEmail("ada@acme.test", {
      ...base,
      tools: {
        slackInviteLink: "https://join.slack.com/t/x?a=1&b=2",
        linearInvited: true,
        githubInvited: true,
      },
    });
    expect(delivered).toBe(true);
    expect(captured).not.toBeNull();

    // Text version: plain link + separate-invite notes.
    expect(captured!.text).toContain("Your team tools:");
    expect(captured!.text).toContain("https://join.slack.com/t/x?a=1&b=2");
    expect(captured!.text).toContain("Linear");
    expect(captured!.text).toContain("GitHub");

    // HTML version: the ampersand in the link is escaped inside the anchor href.
    expect(captured!.html).toContain("Your team tools");
    expect(captured!.html).toContain('href="https://join.slack.com/t/x?a=1&amp;b=2"');
    expect(captured!.html).not.toContain("?a=1&b=2"); // raw, unescaped ampersand must not appear
  });

  it("omits the tools section entirely when no tools are provided", async () => {
    await sendInviteEmail("ada@acme.test", base);
    expect(captured!.text).not.toContain("Your team tools");
    expect(captured!.html).not.toContain("Your team tools");
  });

  it("shows only the tools that have an outcome (Slack link absent → no Slack line)", async () => {
    await sendInviteEmail("ada@acme.test", { ...base, tools: { linearInvited: true } });
    expect(captured!.text).toContain("Your team tools:");
    expect(captured!.text).toContain("Linear");
    expect(captured!.text).not.toContain("join.slack.com");
    expect(captured!.html).not.toContain("<a href=\"https://join");
  });
});
