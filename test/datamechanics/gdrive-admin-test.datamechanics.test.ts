import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setIntegrationSecret, setIntegrationStatus, upsertIntegration } from "@/lib/integrations/manage";
import { approvedAudienceProject, db, seedTeam, type Seed } from "./helpers";

const adminContext = vi.hoisted(() => ({ teamId: "", memberId: "" }));

vi.mock("@/lib/auth/guard", () => ({
  requireTeamAdmin: async () => adminContext.teamId
    ? { teamId: adminContext.teamId, memberId: adminContext.memberId }
    : null,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const {
  testGoogleDriveConnection, saveGoogleDrivePickerSelection, saveIntegration,
  provisionGoogleDriveConnector, runGoogleDriveNow,
} = await import("@/app/t/[team]/admin/integrations/actions");

const SECRET = JSON.stringify({
  client_id: "client", client_secret: "secret", refresh_token: "refresh",
  account_subject: "subject:account", scopes: ["drive"],
});

async function configured(seed: Seed, name: string, files = ["one", "two"]): Promise<string> {
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name, status: "enabled",
    config: {
      fileIds: files, folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", access: "team", authMode: "oauth",
      authenticatedAccount: "docs@example.com", authenticatedAccountId: "subject:account",
      scopeSet: ["drive"],
    },
  });
  await setIntegrationSecret(db(), { teamId: seed.teamId, memberId: seed.memberId }, row.id, SECRET);
  return row.id;
}

describe("AIO-1167 Admin Google Drive test authority", () => {
  beforeEach(() => {
    adminContext.teamId = "";
    adminContext.memberId = "";
  });
  afterEach(() => vi.restoreAllMocks());

  it("stops after refresh when the connection is paused during the token exchange", async () => {
    const seed = await seedTeam();
    const integrationId = await configured(seed, "admin-refresh-pause", ["one"]);
    adminContext.teamId = seed.teamId;
    adminContext.memberId = seed.memberId;
    const provider = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      await setIntegrationStatus(
        db(), { teamId: seed.teamId, memberId: seed.memberId }, integrationId, "disabled",
      );
      return Response.json({ access_token: "must-not-be-used", scope: "drive" });
    });

    const result = await testGoogleDriveConnection(seed.teamSlug, "admin-refresh-pause");

    expect(result.ok).toBe(false);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("rechecks before the next selected root and before reporting success", async () => {
    const seed = await seedTeam();
    await configured(seed, "admin-between-roots");
    adminContext.teamId = seed.teamId;
    adminContext.memberId = seed.memberId;
    const provider = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ access_token: "short-lived", scope: "drive" }))
      .mockImplementationOnce(async () => {
        await db().from("members").update({ role: "member" })
          .eq("id", seed.memberId).eq("team_id", seed.teamId);
        return Response.json({ id: "one", name: "One" });
      });

    const result = await testGoogleDriveConnection(seed.teamSlug, "admin-between-roots");

    expect(result.ok).toBe(false);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("stops if the credential revision changes before a selected-root request", async () => {
    const seed = await seedTeam();
    const integrationId = await configured(seed, "admin-credential-change", ["one"]);
    adminContext.teamId = seed.teamId;
    adminContext.memberId = seed.memberId;
    const provider = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      await setIntegrationSecret(
        db(), { teamId: seed.teamId, memberId: seed.memberId }, integrationId,
        JSON.stringify({ ...JSON.parse(SECRET), refresh_token: "replacement" }),
      );
      return Response.json({ access_token: "old-pair", scope: "drive" });
    });

    const result = await testGoogleDriveConnection(seed.teamSlug, "admin-credential-change");

    expect(result.ok).toBe(false);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("reports explicit preview continuation instead of silently accepting roots after 100", async () => {
    const seed = await seedTeam();
    await configured(seed, "admin-preview-pages", Array.from({ length: 101 }, (_, i) => `doc-${i}`));
    adminContext.teamId = seed.teamId;
    adminContext.memberId = seed.memberId;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ access_token: "short-lived", scope: "drive" }))
      .mockImplementation(async (input) => {
        const id = decodeURIComponent(String(input).split("/files/")[1]!.split("?")[0]!);
        return Response.json({ id, mimeType: "application/vnd.google-apps.document" });
      });

    const first = await testGoogleDriveConnection(seed.teamSlug, "admin-preview-pages");
    expect(first).toMatchObject({ ok: true, checked: 100, total: 101, continuation: 100 });
    expect(first.message).toContain("checked 100/101");
  });

  it("reports checked progress and a continuation when preview is interrupted", async () => {
    const seed = await seedTeam();
    await configured(seed, "admin-preview-interrupted", ["one", "two"]);
    adminContext.teamId = seed.teamId;
    adminContext.memberId = seed.memberId;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ access_token: "short-lived", scope: "drive" }))
      .mockResolvedValueOnce(Response.json({ id: "one", mimeType: "application/vnd.google-apps.document" }))
      .mockRejectedValueOnce(new Error("provider interrupted"));
    expect(await testGoogleDriveConnection(seed.teamSlug, "admin-preview-interrupted"))
      .toMatchObject({ ok: false, checked: 1, total: 2, continuation: 1 });
  });

  it("publishes Picker IDs only after server credential verification and leaves denial unchanged", async () => {
    const seed = await seedTeam();
    await configured(seed, "picker-verify", ["old"]);
    adminContext.teamId = seed.teamId;
    adminContext.memberId = seed.memberId;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ access_token: "short-lived" }))
      .mockResolvedValueOnce(Response.json({ id: "picked", mimeType: "application/vnd.google-apps.document", trashed: false }));
    expect(await saveGoogleDrivePickerSelection(seed.teamSlug, "picker-verify", ["picked"]))
      .toMatchObject({ ok: true });
    const { data: saved } = await db().from("integrations").select("config")
      .eq("team_id", seed.teamId).eq("name", "picker-verify").single();
    expect((saved as { config: { fileIds: string[] } }).config.fileIds).toEqual(["picked"]);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ access_token: "short-lived" }))
      .mockResolvedValueOnce(new Response("denied", { status: 404 }));
    expect(await saveGoogleDrivePickerSelection(seed.teamSlug, "picker-verify", ["inaccessible"]))
      .toMatchObject({ ok: false, error: expect.stringContaining("unchanged") });
    const { data: unchanged } = await db().from("integrations").select("config")
      .eq("team_id", seed.teamId).eq("name", "picker-verify").single();
    expect((unchanged as { config: { fileIds: string[] } }).config.fileIds).toEqual(["picked"]);
  });

  it("configures service-account roots without OAuth or secret upload and queues local verification", async () => {
    const seed = await seedTeam();
    await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
    const projectId = await approvedAudienceProject(seed);
    adminContext.teamId = seed.teamId;
    adminContext.memberId = seed.memberId;
    const provider = vi.spyOn(globalThis, "fetch");

    const saved = await saveIntegration(seed.teamSlug, {
      type: "gdrive", name: "local-service",
      selection: `fileIds=doc-a, audienceProjectIds=${projectId}, authMode=service_account`,
      secret: "",
    });
    expect(saved).toEqual({ ok: true });
    expect(provider).not.toHaveBeenCalled();
    const { data: integration } = await db().from("integrations")
      .select("id,config,secret_ciphertext").eq("team_id", seed.teamId).eq("name", "local-service").single();
    expect(integration).toMatchObject({
      secret_ciphertext: null,
      config: expect.objectContaining({
        authMode: "service_account", serviceAccountStatus: "pending", fileIds: ["doc-a"],
      }),
    });
    const principal = await provisionGoogleDriveConnector(seed.teamSlug, (integration as { id: string }).id);
    expect(principal).toMatchObject({ ok: true, key: expect.stringMatching(/^aios_/) });
    expect(await runGoogleDriveNow(seed.teamSlug, (integration as { id: string }).id))
      .toMatchObject({ ok: true });
    expect(await testGoogleDriveConnection(seed.teamSlug, "local-service"))
      .toMatchObject({ ok: false, error: expect.stringContaining("not completed") });
  });
});
