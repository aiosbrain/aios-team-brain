import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canSeeItem } from "@/lib/access/enforce";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { addMemberToGroup, createGroup, grantProjectToGroup } from "@/lib/access/groups";
import { getPool, runSql, withTransaction } from "@/lib/db/pg/pool";
import { recordGdriveItemClaim } from "@/lib/projects/context/gdrive-claims";
import { publishGoogleDriveOAuthCredential } from "@/lib/integrations/gdrive-oauth";
import { saveGdriveConnectionConfig } from "@/lib/integrations/gdrive-authority";
import { setIntegrationSecret, upsertIntegration } from "@/lib/integrations/manage";
import { decryptSecret } from "@/lib/secrets/crypto";
import { approvedAudienceProject, db, driveFixture, externalMember, seedTeam, type Seed } from "./helpers";

/** An initiative granted to a fresh custom group; returns the project and a member of that group. */
async function grantedInitiative(seed: Seed): Promise<{ projectId: string; memberId: string }> {
  const { data: project, error } = await db().from("projects")
    .insert({ team_id: seed.teamId, slug: `drive-${randomUUID().slice(0, 8)}`, name: "Drive audience", kind: "initiative" })
    .select("id").single();
  if (error || !project) throw new Error(`initiative seed failed: ${error?.message}`);
  const projectId = (project as { id: string }).id;
  const group = await createGroup(db(), seed.teamId, `aud-${randomUUID().slice(0, 8)}`, "Audience", seed.memberId);
  const memberId = await externalMember(seed);
  await addMemberToGroup(db(), seed.teamId, group.groupId!, memberId, seed.memberId);
  await grantProjectToGroup(db(), seed.teamId, projectId, group.groupId!, seed.memberId);
  return { projectId, memberId };
}

/**
 * AIO-1167 R42 F6 — an Admin save built from an earlier read never overwrites what the credential
 * owns, and never re-adds an unverified root; Picker never truncates.
 *
 * Spec.
 *   · The OAuth publication owns a connection's account fields (subject, email, verified flag,
 *     scopes). An Admin selection save — plain or provider-verified — that read the connection BEFORE
 *     a reconnect committed must leave the reconnect's account in place: afterwards the config's
 *     `authenticatedAccountId` equals the encrypted credential's `account_subject`, always.
 *   · A verified publication racing a reconnect AFTER its proof is refused, with nothing written.
 *   · A root removed after the Admin read is not silently restored: the plain save refuses as stale;
 *     the verified path proves it again before publishing it.
 *   · A service-account connection's verification result is the verifier's: a stale save cannot
 *     resurrect an earlier `verified`.
 *   · A Picker submission above 100 unique Docs is refused whole, with the saved selection unchanged
 *     and no provider call; exactly 100 unique Docs (duplicates and blanks ignored) are saved.
 *
 * The interleavings are deterministic: the reconnect / concurrent writer runs inside a hook fired
 * right after the Admin action's own unlocked read, or inside the provider call.
 */

const h = vi.hoisted(() => ({
  admin: { teamId: "", memberId: "" },
  afterAdminRead: null as null | (() => Promise<void>),
}));

vi.mock("@/lib/auth/guard", () => ({
  requireTeamAdmin: async () => h.admin.teamId ? { ...h.admin } : null,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/integrations/manage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/manage")>();
  return {
    ...actual,
    getIntegrationWithSecret: async (...args: Parameters<typeof actual.getIntegrationWithSecret>) => {
      const read = await actual.getIntegrationWithSecret(...args);
      const hook = h.afterAdminRead;
      h.afterAdminRead = null; // fires once, for the Admin action's read only
      if (hook) await hook();
      return read;
    },
  };
});

const { saveIntegration, saveGoogleDrivePickerSelection } = await import("@/app/t/[team]/admin/integrations/actions");

const OLD = { subject: "subject:acct-old", email: "old@example.com", scopes: ["openid", "https://www.googleapis.com/auth/drive.readonly"] };
const NEW = { subject: "subject:acct-new", email: "new@example.com", scopes: ["openid", "https://www.googleapis.com/auth/drive.file"] };
const DOC_MIME = "application/vnd.google-apps.document";

async function oauthConnection(seed: Seed, name: string, fileIds: string[]) {
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const audience = await approvedAudienceProject(seed);
  const auth = { teamId: seed.teamId, memberId: seed.memberId };
  const row = await upsertIntegration(db(), auth, {
    type: "gdrive", name, status: "enabled",
    config: {
      fileIds, folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
      access: "team", authMode: "oauth", authenticatedAccount: OLD.email,
      authenticatedAccountEmailVerified: true, authenticatedAccountId: OLD.subject, scopeSet: OLD.scopes,
      audienceProjectIds: [audience],
    },
  });
  await setIntegrationSecret(db(), auth, row.id, JSON.stringify({
    client_id: "client", client_secret: "secret", refresh_token: "old-refresh",
    token_uri: "https://oauth2.googleapis.com/token", scopes: OLD.scopes, account_subject: OLD.subject,
  }));
  h.admin = { teamId: seed.teamId, memberId: seed.memberId };
  return { id: row.id, audience };
}

/** The real OAuth publication, reconnecting the named connection to a different Google account. */
function reconnect(seed: Seed, name: string): Promise<void> {
  return publishGoogleDriveOAuthCredential({
    teamId: seed.teamId, memberId: seed.memberId, integrationName: name,
    clientId: "client", clientSecret: "secret", subject: NEW.subject, email: NEW.email,
    emailVerified: false, refreshToken: "new-refresh", scopes: NEW.scopes, grantMode: "files",
  });
}

async function stored(seed: Seed, name: string) {
  const { rows } = await getPool().query<{ config: Record<string, unknown>; secret_ciphertext: string | null }>(
    `select config, secret_ciphertext from integrations where team_id=$1 and type='gdrive' and name=$2`,
    [seed.teamId, name],
  );
  const secret = rows[0].secret_ciphertext
    ? JSON.parse(decryptSecret(rows[0].secret_ciphertext)) as { account_subject?: string }
    : {};
  return { config: rows[0].config, secretSubject: secret.account_subject };
}

/** Provider double: one token exchange, then a live Google Doc for every requested file id. */
function provider(onFile?: (id: string) => Promise<void>) {
  const requested: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "short-lived" });
    const id = decodeURIComponent(url.split("/files/")[1]!.split("?")[0]!);
    requested.push(id);
    await onFile?.(id);
    return Response.json({ id, mimeType: DOC_MIME, trashed: false });
  });
  return { requested, spy };
}

const selection = (fileIds: string[], audience: string) =>
  `fileIds=${fileIds.join("|")}, audienceProjectIds=${audience}, authMode=oauth`;

beforeEach(() => {
  h.admin = { teamId: "", memberId: "" };
  h.afterAdminRead = null;
});
afterEach(() => {
  vi.restoreAllMocks();
  h.afterAdminRead = null;
});

describe("Admin save vs OAuth reconnect (R42 F6, real Postgres)", () => {
  it("a plain (narrowing) save read before a reconnect keeps the NEW account, matching the credential", async () => {
    const seed = await seedTeam();
    const conn = await oauthConnection(seed, "narrow-race", ["keep", "drop"]);
    h.afterAdminRead = () => reconnect(seed, "narrow-race");

    expect(await saveIntegration(seed.teamSlug, {
      type: "gdrive", name: "narrow-race", selection: selection(["keep"], conn.audience), secret: "",
    })).toEqual({ ok: true });

    const after = await stored(seed, "narrow-race");
    expect(after.secretSubject).toBe(NEW.subject);
    expect(after.config.authenticatedAccountId).toBe(after.secretSubject);
    expect(after.config).toMatchObject({
      authenticatedAccount: NEW.email, authenticatedAccountEmailVerified: false, scopeSet: NEW.scopes,
      fileIds: ["keep"],
    });
  });

  it("a manual verified save read before a reconnect publishes under the NEW account, matching the credential", async () => {
    const seed = await seedTeam();
    const conn = await oauthConnection(seed, "verified-race", ["keep"]);
    h.afterAdminRead = () => reconnect(seed, "verified-race");
    const google = provider();

    expect(await saveIntegration(seed.teamSlug, {
      type: "gdrive", name: "verified-race", selection: selection(["keep", "added"], conn.audience), secret: "",
    })).toEqual({ ok: true });

    expect(google.requested).toEqual(["added"]);
    const after = await stored(seed, "verified-race");
    expect(after.secretSubject).toBe(NEW.subject);
    expect(after.config.authenticatedAccountId).toBe(after.secretSubject);
    expect(after.config).toMatchObject({ authenticatedAccount: NEW.email, scopeSet: NEW.scopes, fileIds: ["keep", "added"] });
  });

  it("a reconnect AFTER the provider proof refuses the verified publication, with nothing written", async () => {
    const seed = await seedTeam();
    const conn = await oauthConnection(seed, "late-reconnect", ["keep"]);
    provider(async () => { await reconnect(seed, "late-reconnect"); });

    const result = await saveIntegration(seed.teamSlug, {
      type: "gdrive", name: "late-reconnect", selection: selection(["keep", "added"], conn.audience), secret: "",
    });

    expect(result.ok).toBe(false);
    const after = await stored(seed, "late-reconnect");
    expect(after.config.authenticatedAccountId).toBe(after.secretSubject);
    expect(after.config.fileIds, "the unproven-under-this-credential root was not published").toEqual(["keep"]);
  });

  it("without any race the save keeps the existing account exactly (behaviour preserved)", async () => {
    const seed = await seedTeam();
    const conn = await oauthConnection(seed, "no-race", ["keep", "drop"]);
    expect(await saveIntegration(seed.teamSlug, {
      type: "gdrive", name: "no-race", selection: selection(["keep"], conn.audience), secret: "",
    })).toEqual({ ok: true });
    const after = await stored(seed, "no-race");
    expect(after.config).toMatchObject({
      authenticatedAccount: OLD.email, authenticatedAccountEmailVerified: true,
      authenticatedAccountId: OLD.subject, scopeSet: OLD.scopes, fileIds: ["keep"],
    });
    expect(after.secretSubject).toBe(OLD.subject);
  });
});

describe("a root removed after the Admin read is not silently restored (R42 F6)", () => {
  it("the plain save refuses as stale and leaves the newer selection untouched", async () => {
    const seed = await seedTeam();
    const conn = await oauthConnection(seed, "stale-plain", ["keep", "removed"]);
    // A second Admin removes "removed" after this Admin's form was loaded.
    h.afterAdminRead = async () => {
      await saveGdriveConnectionConfig(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
        name: "stale-plain",
        config: {
          fileIds: ["keep"], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
          access: "team", authMode: "oauth", audienceProjectIds: [conn.audience],
        },
      });
    };
    const google = provider();

    const result = await saveIntegration(seed.teamSlug, {
      type: "gdrive", name: "stale-plain", selection: selection(["keep", "removed"], conn.audience), secret: "",
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/changed since this form was loaded/) });
    expect(google.spy).not.toHaveBeenCalled();
    const after = await stored(seed, "stale-plain");
    expect(after.config.fileIds).toEqual(["keep"]);
    expect(after.config.authenticatedAccountId, "the concurrent save kept the credential's account").toBe(after.secretSubject);
  });

  it("the verified path proves the concurrently removed root again before publishing it", async () => {
    const seed = await seedTeam();
    const conn = await oauthConnection(seed, "stale-verified", ["keep", "removed"]);
    h.afterAdminRead = async () => {
      await saveGdriveConnectionConfig(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
        name: "stale-verified",
        config: {
          fileIds: ["keep"], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
          access: "team", authMode: "oauth", audienceProjectIds: [conn.audience],
        },
      });
    };
    const google = provider();

    expect(await saveIntegration(seed.teamSlug, {
      type: "gdrive", name: "stale-verified",
      selection: selection(["keep", "removed", "added"], conn.audience), secret: "",
    })).toEqual({ ok: true });

    expect(google.requested, "every root the locked snapshot lacks is proven").toEqual(["removed", "added"]);
    expect((await stored(seed, "stale-verified")).config.fileIds).toEqual(["keep", "removed", "added"]);
  });
});

describe("service-account verification belongs to the verifier (R42 F6)", () => {
  it("a stale save over the same roots cannot resurrect an earlier `verified`", async () => {
    const seed = await seedTeam();
    await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
    const audience = await approvedAudienceProject(seed);
    const auth = { teamId: seed.teamId, memberId: seed.memberId };
    const base = {
      fileIds: ["sa-doc"], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
      access: "team", authMode: "service_account", audienceProjectIds: [audience],
    };
    await upsertIntegration(db(), auth, {
      type: "gdrive", name: "sa-race", status: "enabled",
      config: { ...base, serviceAccountStatus: "verified", serviceAccountIdentity: "bot@p.iam.gserviceaccount.com" },
    });
    h.admin = { ...auth };
    // The verifier records a failure after the Admin read the old `verified`.
    h.afterAdminRead = async () => {
      await upsertIntegration(db(), auth, {
        type: "gdrive", name: "sa-race", status: "enabled", config: { ...base, serviceAccountStatus: "failed" },
      });
    };

    expect(await saveIntegration(seed.teamSlug, {
      type: "gdrive", name: "sa-race",
      selection: `fileIds=sa-doc, audienceProjectIds=${audience}, authMode=service_account`, secret: "",
    })).toEqual({ ok: true });

    const after = await stored(seed, "sa-race");
    expect(after.config.serviceAccountStatus).toBe("failed");
    expect(after.config).not.toHaveProperty("serviceAccountIdentity");
  });
});

describe("Picker selections are refused above 100 unique Docs, never truncated (R42 F6)", () => {
  it("101 unique IDs: refused whole, no provider call, the saved selection unchanged", async () => {
    const seed = await seedTeam();
    await oauthConnection(seed, "picker-101", ["old"]);
    const google = provider();
    const ids = Array.from({ length: 101 }, (_, i) => `doc-${i}`);

    const result = await saveGoogleDrivePickerSelection(seed.teamSlug, "picker-101", ids);

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/101 .*at most 100.*unchanged/) });
    expect(google.spy).not.toHaveBeenCalled();
    expect((await stored(seed, "picker-101")).config.fileIds).toEqual(["old"]);
  });

  it("exactly 100 unique IDs (duplicates and blanks ignored) are verified and all saved", async () => {
    const seed = await seedTeam();
    await oauthConnection(seed, "picker-100", ["old"]);
    const google = provider();
    const unique = Array.from({ length: 100 }, (_, i) => `doc-${i}`);

    const result = await saveGoogleDrivePickerSelection(seed.teamSlug, "picker-100", [...unique, " doc-0 ", "", "doc-99"]);

    expect(result).toMatchObject({ ok: true });
    expect(google.requested).toEqual(unique);
    expect((await stored(seed, "picker-100")).config.fileIds).toEqual(unique);
  });
});

/**
 * AIO-1167 R56 — the ABSENT-row variant of the stale-config protection (Astra adjudication).
 *
 * Spec. A config save for a named connection that does not exist yet makes its create decision
 * under the same authority an OAuth publication uses — identity authority, then the name's lock,
 * then create-or-read-winner, then the winner's connection rows. So when another writer creates the
 * connection first, the save derives from the LOCKED winner, never from its own provisional fields:
 *   · the credential-owned account fields stay aligned with the winner's encrypted credential;
 *   · a winner paused before the save acquires authority stays paused (no implicit resume);
 *   · the winner's existing claims are narrowed to the save's audience in the same transaction;
 *   · a winner that rolls back leaves nothing behind — the save then creates the connection itself;
 *   · a loser refused as stale writes nothing.
 * Every interleaving is deterministic: the first writer's transaction is held open (an outer
 * transaction, or the OAuth publication's own `afterLocks` hook), the second is started OUTSIDE that
 * transaction's context — its own connection — and released only once Postgres reports it parked on
 * a lock.
 */
describe("absent-row config save races (R56, real Postgres)", () => {
  const ACCOUNT = { subject: "subject:acct-winner", email: "winner@example.com", scopes: ["openid", "https://www.googleapis.com/auth/drive.file"] };

  function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  /** Wait until another session of this database is parked on a lock (the second writer). */
  async function parked(): Promise<void> {
    for (let tries = 0; tries < 400; tries++) {
      const { rows } = await getPool().query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'");
      if (rows[0].n > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the second writer never parked on a lock");
  }

  /** Run `body` inside a transaction held open until the competitor (started meanwhile) parks. */
  async function holding<T>(body: () => Promise<void>, competitor: () => Promise<T>, fail = false) {
    const entered = deferred();
    const release = deferred();
    const first = withTransaction(async () => {
      await body();
      entered.resolve();
      await release.promise;
      if (fail) throw new Error("the first writer rolled back");
    });
    const firstSettled = first.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
    await entered.promise;
    const second = competitor().then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    await parked();
    release.resolve();
    return { first: await firstSettled, second: await second };
  }

  async function adminTeam() {
    const seed = await seedTeam();
    await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
    const audience = await approvedAudienceProject(seed);
    return { seed, audience, auth: { teamId: seed.teamId, memberId: seed.memberId } };
  }

  const oauthConfig = (audience: string, extra: Record<string, unknown> = {}) => ({
    fileIds: [], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "absent",
    access: "team", authMode: "oauth", audienceProjectIds: [audience],
    // Provisional fields a caller might carry: never credential authority.
    authenticatedAccountId: "subject:forged", authenticatedAccount: "forged@example.com", scopeSet: ["forged"],
    ...extra,
  });

  function publish(seed: Seed, name: string, hooks?: { afterLocks?: () => Promise<void> }) {
    return publishGoogleDriveOAuthCredential({
      teamId: seed.teamId, memberId: seed.memberId, integrationName: name,
      clientId: "client", clientSecret: "secret", subject: ACCOUNT.subject, email: ACCOUNT.email,
      emailVerified: false, refreshToken: "winner-refresh", scopes: ACCOUNT.scopes, grantMode: "files",
    }, hooks);
  }

  async function rows(seed: Seed, name: string) {
    const { rows: found } = await getPool().query<{ id: string; status: string; config: Record<string, unknown> }>(
      "select id,status,config from integrations where team_id=$1 and type='gdrive' and name=$2", [seed.teamId, name]);
    return found;
  }

  it("OAuth creates first, the save waits: the save keeps the winner's account, aligned with its credential", async () => {
    const { seed, audience, auth } = await adminTeam();
    const locked = deferred();
    const release = deferred();
    const oauth = publish(seed, "oauth-first", {
      afterLocks: async () => { locked.resolve(); await release.promise; },
    });
    await locked.promise;
    const save = saveGdriveConnectionConfig(db(), auth, { name: "oauth-first", config: oauthConfig(audience) });
    await parked();
    release.resolve();
    await oauth;
    await save;

    expect(await rows(seed, "oauth-first")).toHaveLength(1);
    const after = await stored(seed, "oauth-first");
    expect(after.secretSubject).toBe(ACCOUNT.subject);
    expect(after.config.authenticatedAccountId).toBe(after.secretSubject);
    expect(after.config).toMatchObject({ authenticatedAccount: ACCOUNT.email, scopeSet: ACCOUNT.scopes, audienceProjectIds: [audience] });
    expect(JSON.stringify(after.config)).not.toContain("forged");
  });

  it("the save creates first, OAuth waits: OAuth publishes onto the saved row, one aligned connection", async () => {
    const { seed, audience, auth } = await adminTeam();
    const { first, second } = await holding(
      async () => { await saveGdriveConnectionConfig(db(), auth, { name: "save-first", config: oauthConfig(audience) }); },
      () => publish(seed, "save-first"),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(await rows(seed, "save-first")).toHaveLength(1);
    const after = await stored(seed, "save-first");
    expect(after.config.authenticatedAccountId).toBe(after.secretSubject);
    expect(after.config).toMatchObject({ authenticatedAccountId: ACCOUNT.subject, audienceProjectIds: [audience] });
    expect(JSON.stringify(after.config)).not.toContain("forged");
  });

  it.each(["A then B", "B then A"] as const)("two saves of an absent connection (%s): the second derives from the first's locked row", async (order) => {
    const { seed, auth } = await adminTeam();
    const a = await approvedAudienceProject(seed);
    const b = await approvedAudienceProject(seed);
    const config = (audience: string) => ({
      fileIds: ["doc"], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
      access: "team", authMode: "service_account", audienceProjectIds: [audience],
    });
    const [firstAudience, secondAudience] = order === "A then B" ? [a, b] : [b, a];
    const { first, second } = await holding(
      async () => { await saveGdriveConnectionConfig(db(), auth, { name: "two-saves", config: config(firstAudience) }); },
      () => saveGdriveConnectionConfig(db(), auth, { name: "two-saves", config: config(secondAudience) }),
    );
    expect(first.ok && second.ok).toBe(true);
    const found = await rows(seed, "two-saves");
    expect(found).toHaveLength(1);
    expect(found[0].config.audienceProjectIds).toEqual([secondAudience]);
    expect(found[0].status).toBe("enabled");
  });

  it("a winner paused before the save acquires authority stays paused", async () => {
    const { seed, audience, auth } = await adminTeam();
    const { first, second } = await holding(
      async () => {
        await saveGdriveConnectionConfig(db(), auth, { name: "paused-winner", config: oauthConfig(audience) });
        await runSql("update integrations set status='disabled' where team_id=$1 and type='gdrive' and name=$2",
          [seed.teamId, "paused-winner"]);
      },
      () => saveGdriveConnectionConfig(db(), auth, { name: "paused-winner", config: oauthConfig(audience) }),
    );
    expect(first.ok && second.ok).toBe(true);
    const found = await rows(seed, "paused-winner");
    expect(found).toHaveLength(1);
    expect(found[0].status, "a config save is not a resume").toBe("disabled");
  });

  it("the winner's existing claims are narrowed to the save's audience at once", async () => {
    const { seed, auth } = await adminTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const kept = await grantedInitiative(seed);
    const dropped = await grantedInitiative(seed);
    const item = await driveFixture(seed, {
      project: "drive-storage", path: "gdrive/doc-race.md", body: "Drive body doc-race",
      frontmatter: { source: "gdrive", source_id: "doc-race" },
    }, { unclaimed: true });
    const config = (audience: string[]) => ({
      fileIds: ["doc-race"], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
      access: "team", authMode: "service_account", audienceProjectIds: audience,
    });
    const { first, second } = await holding(
      async () => {
        const { id } = await saveGdriveConnectionConfig(db(), auth, { name: "narrow-race", config: config([kept.projectId, dropped.projectId]) });
        const { rows: authority } = await runSql<{ generation: string | number }>(
          "select generation from gdrive_connection_authority where integration_id=$1", [id]);
        await recordGdriveItemClaim(db(), {
          teamId: seed.teamId, integrationId: id, providerId: "doc-race", itemId: item.id,
          generation: Number(authority[0].generation), audienceProjectIds: [kept.projectId, dropped.projectId],
        });
      },
      () => saveGdriveConnectionConfig(db(), auth, { name: "narrow-race", config: config([kept.projectId]) }),
    );
    expect(first.ok && second.ok).toBe(true);
    const [connection] = await rows(seed, "narrow-race");
    const { rows: claimed } = await runSql<{ project_id: string }>(
      "select project_id from gdrive_item_claim_projects where integration_id=$1 and provider_id='doc-race'", [connection.id]);
    expect(claimed.map((row) => row.project_id)).toEqual([kept.projectId]);
    expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: dropped.memberId }, item.id), "removed audience reads nothing").toBe(false);
    expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: kept.memberId }, item.id)).toBe(true);
  });

  it("a winner that rolls back leaves nothing: the waiting save then creates the connection itself", async () => {
    const { seed, auth } = await adminTeam();
    const a = await approvedAudienceProject(seed);
    const b = await approvedAudienceProject(seed);
    const config = (audience: string) => ({
      fileIds: ["doc"], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
      access: "team", authMode: "service_account", audienceProjectIds: [audience],
    });
    const { first, second } = await holding(
      async () => { await saveGdriveConnectionConfig(db(), auth, { name: "rolled-back", config: config(a) }); },
      () => saveGdriveConnectionConfig(db(), auth, { name: "rolled-back", config: config(b) }),
      true,
    );
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(true);
    const found = await rows(seed, "rolled-back");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ status: "enabled", config: { audienceProjectIds: [b] } });
  });

  it("a loser refused as stale writes nothing over the winner", async () => {
    const { seed, audience, auth } = await adminTeam();
    const locked = deferred();
    const release = deferred();
    const oauth = publish(seed, "stale-loser", {
      afterLocks: async () => { locked.resolve(); await release.promise; },
    });
    await locked.promise;
    // The loser's form adds a root the OAuth winner never proved: refused, nothing written.
    const save = saveGdriveConnectionConfig(db(), auth, {
      name: "stale-loser", config: oauthConfig(audience, { fileIds: ["unproven"], selectionState: "selected" }),
    }).then(() => null, (error: unknown) => error);
    await parked();
    release.resolve();
    await oauth;
    expect(await save).toBeInstanceOf(Error);
    const found = await rows(seed, "stale-loser");
    expect(found).toHaveLength(1);
    const after = await stored(seed, "stale-loser");
    expect(after.config.fileIds).toEqual([]);
    expect(after.config.authenticatedAccountId).toBe(after.secretSubject);
  });
});
