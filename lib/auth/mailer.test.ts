import { afterEach, describe, expect, it, vi } from "vitest";
import { sendInviteEmail, sendMagicLink } from "./mailer";

// Spec: deliver via Resend HTTP API when keyed; never throw; never treat dev-logging as
// a delivery path; never leak a secret (password or magic token) into the invite email —
// sign-in is email+password, shared out-of-band by the admin, never mailed.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockFetch(ok: boolean) {
  const fn = vi.fn(async () => ({ ok, status: ok ? 200 : 422 }) as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function sentBody(
  fn: ReturnType<typeof vi.fn>
): { to: string; subject: string; text: string; html?: string } {
  return JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string);
}

const inviteCtx = { inviteeName: "Alicia Keys", teamName: "Acme Co", inviterName: "Bob Admin" };

describe("mailer delivery", () => {
  it("sends via the Resend HTTP API when RESEND_API_KEY is set", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    const fetchFn = mockFetch(true);

    const delivered = await sendInviteEmail("new@member.test", inviteCtx);

    expect(delivered).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe("https://api.resend.com/emails");
    const body = sentBody(fetchFn);
    expect(body.to).toBe("new@member.test");
    expect(body.subject).toContain("Bob Admin");
    expect(body.subject).toContain("Acme Co");
  });

  it("personalizes the body with the invitee's first name, team, and inviter, in both text and html", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    const fetchFn = mockFetch(true);

    await sendInviteEmail("new@member.test", inviteCtx);

    const body = sentBody(fetchFn);
    expect(body.text).toContain("Alicia");
    expect(body.text).toContain("Bob Admin");
    expect(body.text).toContain("Acme Co");
    expect(body.html).toBeTruthy();
    expect(body.html).toContain("Alicia");
    expect(body.html).toContain("Bob Admin");
    expect(body.html).toContain("Acme Co");
  });

  it("escapes HTML-unsafe characters in names before rendering the html body", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    const fetchFn = mockFetch(true);

    await sendInviteEmail("new@member.test", {
      inviteeName: "<script>alert(1)</script>",
      teamName: "Acme & Co <b>",
      inviterName: "Bob \"Boss\" Admin",
    });

    const body = sentBody(fetchFn);
    expect(body.html).not.toContain("<script>");
    expect(body.html).not.toContain("Acme & Co <b>");
  });

  it("does not throw when Resend rejects the send", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    mockFetch(false);
    await expect(sendMagicLink("x@y.test", "https://brain.test/link")).resolves.toBeUndefined();
  });

  it("no provider configured: does not call fetch and does not throw", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("SMTP_URL", "");
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await expect(sendInviteEmail("a@b.test", inviteCtx)).resolves.toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("an invite email never carries a password or token", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    const fetchFn = mockFetch(true);
    await sendInviteEmail("a@b.test", inviteCtx);
    const body = sentBody(fetchFn);
    expect(body.text).not.toMatch(/token=/);
    expect(body.text).toMatch(/sign in/i);
  });

  it("never writes a magic token to logs when no provider is configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("SMTP_URL", "");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await sendMagicLink("x@y.test", "https://brain.test/auth/confirm?token=SECRET_TOKEN");

    expect(JSON.stringify(info.mock.calls)).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(info.mock.calls)).not.toContain("token=");
  });
});
