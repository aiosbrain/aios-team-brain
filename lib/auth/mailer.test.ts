import { afterEach, describe, expect, it, vi } from "vitest";
import { sendInviteEmail, sendMagicLink } from "./mailer";

// Spec: deliver via Resend HTTP API when keyed; never throw; never treat dev-logging as
// a delivery path; never leak the one-time token into a non-link invite. We assert on
// recipient/subject/shape — NOT on token values (no secrets in assertions).

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

function sentBody(fn: ReturnType<typeof vi.fn>): { to: string; subject: string; text: string } {
  return JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string);
}

describe("mailer delivery", () => {
  it("sends via the Resend HTTP API when RESEND_API_KEY is set", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    const fetchFn = mockFetch(true);

    await sendInviteEmail("new@member.test", "https://brain.test/auth/confirm?token=REDACTED");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe("https://api.resend.com/emails");
    const body = sentBody(fetchFn);
    expect(body.to).toBe("new@member.test");
    expect(body.subject).toMatch(/added to the AIOS Team Brain/i);
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
    await expect(sendInviteEmail("a@b.test", null)).resolves.toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("an invite with no link is a non-secret nudge (no token in the body)", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    const fetchFn = mockFetch(true);
    await sendInviteEmail("a@b.test", null);
    const body = sentBody(fetchFn);
    expect(body.text).not.toMatch(/token=/);
    expect(body.text).toMatch(/sign in/i);
  });
});
