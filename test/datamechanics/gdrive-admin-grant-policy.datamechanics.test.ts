import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setIntegrationSecret, setIntegrationStatus, upsertIntegration } from "@/lib/integrations/manage";
import { approvedAudienceProject, db, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1167 R47 F6 — an Admin preview never reports healthy what execution will refuse
 * (accepted-spec AC-01/156).
 *
 * The Admin connection test, Picker verification and manual-root verification refresh with the
 * stored credential. Each refresh is held to the SAME grant policy as the connector broker, before
 * any Drive read:
 *   · a grant broader than the stored ceiling is refused with sanitized reconnect guidance — the
 *     Drive read never happens and the saved selection is unchanged;
 *   · a grant inside the ceiling proceeds;
 *   · when Google omits `scope`, the grant recorded with the credential is judged (the broker's
 *     fallback) — so a recorded grant outside its own recorded mode refuses here too;
 *   · an invalid recorded mode, or a legacy credential with no recorded grant, has no ceiling and
 *     refuses before even the token exchange;
 *   · a pause during the refresh still refuses (the Admin snapshot is rechecked after the network call).
 */

const h = vi.hoisted(() => ({ admin: { teamId: "", memberId: "" } }));
vi.mock("@/lib/auth/guard", () => ({
  requireTeamAdmin: async () => h.admin.teamId ? { ...h.admin } : null,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { testGoogleDriveConnection, saveGoogleDrivePickerSelection, saveIntegration } =
  await import("@/app/t/[team]/admin/integrations/actions");

const GOOGLE = "https://www.googleapis.com/auth/";
const FILE = `${GOOGLE}drive.file`;
const READONLY = `${GOOGLE}drive.readonly`;
const FULL = `${GOOGLE}drive`;
const DOC_MIME = "application/vnd.google-apps.document";

interface Credential { grant_mode?: unknown; scopes?: unknown }

async function connection(seed: Seed, name: string, credential: Credential, fileIds = ["kept"]) {
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const audience = await approvedAudienceProject(seed);
  const auth = { teamId: seed.teamId, memberId: seed.memberId };
  const row = await upsertIntegration(db(), auth, {
    type: "gdrive", name, status: "enabled",
    config: {
      fileIds, folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
      access: "team", authMode: "oauth", authenticatedAccount: "docs@example.com",
      authenticatedAccountId: "subject:account", scopeSet: [FILE], audienceProjectIds: [audience],
    },
  });
  await setIntegrationSecret(db(), auth, row.id, JSON.stringify({
    client_id: "client", client_secret: "secret", refresh_token: "refresh",
    account_subject: "subject:account", ...credential,
  }));
  h.admin = { teamId: seed.teamId, memberId: seed.memberId };
  return { id: row.id, audience };
}

/** Provider double: the token exchange answers `token`; every Drive read answers a live Google Doc. */
function provider(token: Record<string, unknown>, onToken?: () => Promise<void>) {
  const driveReads: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      await onToken?.();
      return Response.json({ access_token: "short-lived-secret-token", ...token });
    }
    driveReads.push(url);
    const id = decodeURIComponent(url.split("/files/")[1]!.split("?")[0]!);
    return Response.json({ id, mimeType: DOC_MIME, trashed: false });
  });
  return { spy, driveReads };
}

async function fileIds(seed: Seed, name: string): Promise<string[]> {
  const { data } = await db().from("integrations").select("config").eq("team_id", seed.teamId).eq("name", name).single();
  return (data as { config: { fileIds: string[] } }).config.fileIds;
}

const FILES_MODE: Credential = { grant_mode: "files", scopes: ["openid", FILE] };

/** The three Admin paths, each run against one connection; returns the action's result. */
const PATHS = {
  "connection test": (seed: Seed, name: string) => testGoogleDriveConnection(seed.teamSlug, name),
  "Picker verification": (seed: Seed, name: string) => saveGoogleDrivePickerSelection(seed.teamSlug, name, ["picked"]),
  "manual root verification": (seed: Seed, name: string, audience: string) => saveIntegration(seed.teamSlug, {
    type: "gdrive", name, selection: `fileIds=kept|added, audienceProjectIds=${audience}, authMode=oauth`, secret: "",
  }),
} as const;

beforeEach(() => { h.admin = { teamId: "", memberId: "" }; });
afterEach(() => vi.restoreAllMocks());

describe("R47 F6 — Admin refreshes are held to the broker's grant policy", () => {
  for (const [label, run] of Object.entries(PATHS)) {
    it(`${label}: a grant broader than the stored ceiling refuses before any Drive read`, async () => {
      const seed = await seedTeam();
      const name = `broad-${label.split(" ")[0]}`;
      const conn = await connection(seed, name, FILES_MODE);
      const { spy, driveReads } = provider({ scope: `openid ${FULL}` });

      const result = await run(seed, name, conn.audience);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/reconnect/i);
      expect(JSON.stringify(result)).not.toContain("short-lived-secret-token");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(driveReads).toEqual([]);
      expect(await fileIds(seed, name)).toEqual(["kept"]);
    });

    it(`${label}: a grant inside the ceiling proceeds to the Drive read`, async () => {
      const seed = await seedTeam();
      const name = `ok-${label.split(" ")[0]}`;
      const conn = await connection(seed, name, FILES_MODE);
      const { driveReads } = provider({ scope: `openid ${FILE}` });

      const result = await run(seed, name, conn.audience);

      expect(result).toMatchObject({ ok: true });
      expect(driveReads.length).toBeGreaterThan(0);
    });
  }

  it("an omitted scope judges the recorded grant — accepted inside its mode, refused outside it", async () => {
    const seed = await seedTeam();
    await connection(seed, "omitted-ok", FILES_MODE);
    const ok = provider({});
    expect(await testGoogleDriveConnection(seed.teamSlug, "omitted-ok")).toMatchObject({ ok: true });
    expect(ok.driveReads.length).toBe(1);
    vi.restoreAllMocks();

    // Recorded mode `files` but a recorded grant of drive.readonly: the broker refuses this refresh,
    // so the preview must as well.
    await connection(seed, "omitted-broad", { grant_mode: "files", scopes: ["openid", READONLY] });
    const broad = provider({});
    const result = await testGoogleDriveConnection(seed.teamSlug, "omitted-broad");
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/reconnect/i) });
    expect(broad.driveReads).toEqual([]);
  });

  it("a legacy credential's ceiling is the narrowest mode its recorded grant fits", async () => {
    const seed = await seedTeam();
    // No recorded mode; recorded grant drive.readonly → ceiling `folders`, which permits readonly.
    await connection(seed, "legacy-folders", { scopes: ["openid", READONLY] });
    const ok = provider({ scope: `openid ${READONLY}` });
    expect(await testGoogleDriveConnection(seed.teamSlug, "legacy-folders")).toMatchObject({ ok: true });
    expect(ok.driveReads.length).toBe(1);
  });

  for (const [label, credential] of [
    ["an invalid recorded mode", { grant_mode: "everything", scopes: ["openid", FILE] }],
    ["no recorded mode and no recorded grant", {}],
    ["no recorded mode and a recorded grant outside every mode", { scopes: ["openid", FULL] }],
  ] as const) {
    it(`${label} has no ceiling: refused before the token exchange`, async () => {
      const seed = await seedTeam();
      await connection(seed, "no-ceiling", credential);
      const { spy } = provider({ scope: `openid ${FILE}` });
      const test = await testGoogleDriveConnection(seed.teamSlug, "no-ceiling");
      const picker = await saveGoogleDrivePickerSelection(seed.teamSlug, "no-ceiling", ["picked"]);
      for (const result of [test, picker]) {
        expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/reconnect/i) });
      }
      expect(spy).not.toHaveBeenCalled();
      expect(await fileIds(seed, "no-ceiling")).toEqual(["kept"]);
    });
  }

  it("a pause during the refresh refuses even a grant inside the ceiling", async () => {
    const seed = await seedTeam();
    const conn = await connection(seed, "paused-mid-refresh", FILES_MODE);
    const { driveReads } = provider({ scope: `openid ${FILE}` }, async () => {
      await setIntegrationStatus(db(), { teamId: seed.teamId, memberId: seed.memberId }, conn.id, "disabled");
    });
    const result = await saveGoogleDrivePickerSelection(seed.teamSlug, "paused-mid-refresh", ["picked"]);
    expect(result.ok).toBe(false);
    expect(driveReads).toEqual([]);
    expect(await fileIds(seed, "paused-mid-refresh")).toEqual(["kept"]);
  });
});
