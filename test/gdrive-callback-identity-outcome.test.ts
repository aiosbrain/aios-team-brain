import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * AIO-1167 PR743 — the OAuth callback presents the publisher's typed identity outcome (combined final
 * review §2, callback Low). The credential is connected in every case; a held email attribution bridge
 * (tombstoned or ambiguous) is explained with the Admin → Members repair path and is never presented as
 * an unlinked account; a preserved same-member mapping is neither; an ordinary link adds nothing; and
 * paused-connection messaging is kept. The OAuth state, session, database and publisher are stubbed:
 * only the route's own presentation is under test.
 */

const publish = vi.fn();

vi.mock("@/lib/auth/gdrive-oauth-state", () => ({
  GDRIVE_OAUTH_BINDING_COOKIE: "gdrive_oauth_binding",
  consumeGoogleDriveOAuthState: vi.fn(async () => ({
    teamId: "team-1", teamSlug: "acme", memberId: "admin-1", integrationName: "docs", mode: "files",
  })),
}));
vi.mock("@/lib/auth/guard", () => ({
  requireTeamAdmin: vi.fn(async () => ({ teamId: "team-1", memberId: "admin-1" })),
}));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/lib/integrations/gdrive-oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/gdrive-oauth")>()),
  publishGoogleDriveOAuthCredential: (...args: unknown[]) => publish(...args),
}));

const EMAIL = "alice@example.com";

function google() {
  return vi.fn(async (url: string) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({
        access_token: "access", refresh_token: "refresh",
        scope: "openid https://www.googleapis.com/auth/drive.file",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ sub: "subject-1", email: EMAIL, email_verified: true, name: "Alice" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
}

async function callback(outcome: { status: "enabled" | "disabled"; identity: { subject: string; email: string } }) {
  publish.mockResolvedValueOnce(outcome);
  const { GET } = await import("@/app/api/auth/gdrive/callback/route");
  const res = await GET(new NextRequest("http://localhost/api/auth/gdrive/callback?state=s&code=c"));
  return { status: res.status, text: await res.text() };
}

describe("PR743 — the Google callback presents the identity outcome", () => {
  beforeEach(() => {
    process.env.GOOGLE_DRIVE_CLIENT_ID = "client";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_DRIVE_OAUTH_REDIRECT = "http://localhost/api/auth/gdrive/callback";
    vi.stubGlobal("fetch", google());
    publish.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("an ordinary link adds nothing to the connected message", async () => {
    const { status, text } = await callback({ status: "enabled", identity: { subject: "linked", email: "linked" } });
    expect(status).toBe(200);
    expect(text).toContain(`Connected ${EMAIL}. Return to Integrations to choose files or folders.`);
  });

  it("a tombstoned email: the subject is reported linked, only the email bridge is held, with the repair path", async () => {
    const { status, text } = await callback({ status: "enabled", identity: { subject: "linked", email: "tombstoned" } });
    expect(status).toBe(200);
    expect(text).toContain("Google Drive connected");
    expect(text).toContain("Google identity is linked to the member");
    expect(text).toContain("email address was deliberately unlinked earlier");
    expect(text).toContain("Admin → Members → Identities");
  });

  it("an ambiguous email is explained as several earlier histories, not as an unlink", async () => {
    const { text } = await callback({ status: "enabled", identity: { subject: "linked", email: "ambiguous" } });
    expect(text).toContain("several earlier mapping histories");
    expect(text).toContain("Admin → Members → Identities");
    expect(text).not.toContain("deliberately unlinked");
  });

  it("a preserved same-member mapping is neither held nor unlinked", async () => {
    const { status, text } = await callback({ status: "enabled", identity: { subject: "linked", email: "preserved" } });
    expect(status).toBe(200);
    expect(text).toContain("already linked to the same member under an earlier spelling");
    expect(text).not.toContain("unlinked");
    expect(text).not.toContain("not credited");
  });

  it("a held email with an unlinked subject says so accurately, and a paused connection keeps its message", async () => {
    const { text } = await callback({ status: "disabled", identity: { subject: "tombstoned", email: "tombstoned" } });
    expect(text).toContain("Google identity was deliberately unlinked earlier and stays unlinked");
    expect(text).toContain("email address was deliberately unlinked earlier");
    expect(text).toContain("This connection is paused");
  });
});
