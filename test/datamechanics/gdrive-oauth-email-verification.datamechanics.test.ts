import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/db/pg/pool";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import {
  GoogleIdentityConflictError,
  publishGoogleDriveOAuthCredential,
} from "@/lib/integrations/gdrive-oauth";
import { getIntegrationWithSecret } from "@/lib/integrations/manage";
import { db, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1167 R41 — a verified Google SUBJECT is not a verified Google EMAIL (AC-08), on real Postgres.
 *
 * Spec.
 *   · Only `emailVerified === true` plus an unambiguous confirmed roster/alias match creates the
 *     account's identity mappings — `subject:` AND `author-email:` — atomically, with their mapping
 *     revisions and repair obligations.
 *   · `false`, a missing claim, or no email at all creates NO email-derived mapping, revision or
 *     repair obligation — neither `subject:` nor `author-email:` — and never writes the unverified
 *     address into `member_identities.email`. The credential is still stored by subject, and the
 *     address is kept only as untrusted account metadata (`authenticatedAccountEmailVerified:false`).
 *   · An existing deliberate subject link survives untouched and gains no unverified email bridge.
 *   · An ambiguous or unmatched verified email maps no one; a verified email that resolves to a
 *     member other than an existing manual link is a conflict and rolls everything back.
 *   · The publisher enforces this itself: a direct caller cannot pass a truthy non-boolean.
 */

interface World {
  seed: Seed;
  /** A second member whose roster address the account email matches. */
  author: { id: string; email: string };
}

async function world(): Promise<World> {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const email = `author-${randomUUID().slice(0, 8)}@example.com`;
  const { data, error } = await db().from("members").insert({
    team_id: seed.teamId, email, display_name: "Author", actor_handle: `author-${randomUUID().slice(0, 8)}`,
    role: "member", tier: "team", status: "active",
  }).select("id").single();
  if (error || !data) throw new Error(`author fixture failed: ${error?.message}`);
  return { seed, author: { id: (data as { id: string }).id, email } };
}

function publication(w: World, over: Record<string, unknown> = {}) {
  return {
    teamId: w.seed.teamId, memberId: w.seed.memberId, integrationName: `docs-${randomUUID().slice(0, 6)}`,
    clientId: "oauth-client", clientSecret: "client-secret",
    subject: `acct-${randomUUID().slice(0, 8)}`, email: w.author.email, emailVerified: true,
    name: "Google Account", refreshToken: "fresh-refresh",
    scopes: ["https://www.googleapis.com/auth/drive.file"],
    ...over,
  } as Parameters<typeof publishGoogleDriveOAuthCredential>[0];
}

async function gdriveIdentityState(teamId: string) {
  const pool = getPool();
  const mappings = (await pool.query<{ member_id: string; external_id: string; email: string }>(
    `select member_id, external_id, email::text as email from member_identities
      where team_id=$1 and provider='gdrive' order by external_id`, [teamId])).rows;
  const revisions = (await pool.query<{ external_id: string; revision: string }>(
    `select external_id, revision::text from member_identity_mapping_state
      where team_id=$1 and provider='gdrive' order by external_id`, [teamId])).rows;
  const obligations = (await pool.query<{ external_id: string; status: string }>(
    `select external_id, status from identity_repair_obligations
      where team_id=$1 and provider='gdrive' order by external_id`, [teamId])).rows;
  return { mappings, revisions, obligations };
}

async function stored(w: World, name: string) {
  const row = await getIntegrationWithSecret(db(), w.seed.teamId, "gdrive", name);
  expect(row, "the credential publication must exist").toBeTruthy();
  // A stored credential is what makes the connection usable: subject-only storage must keep it,
  // bound to the account's subject.
  const secret = JSON.parse(row!.secret ?? "{}") as Record<string, unknown>;
  expect(secret).toMatchObject({ refresh_token: "fresh-refresh" });
  expect(String(secret.account_subject)).toMatch(/^subject:acct-/);
  return { config: row!.config as Record<string, unknown> };
}

describe("Google OAuth publication: email evidence decides identity, the subject decides the credential", () => {
  it("literal true + an unambiguous roster match creates both mappings with their obligations", async () => {
    const w = await world();
    const input = publication(w);
    await publishGoogleDriveOAuthCredential(input);

    const state = await gdriveIdentityState(w.seed.teamId);
    expect(state.mappings.map((m) => [m.external_id, m.member_id])).toEqual([
      [`author-email:${w.author.email}`, w.author.id],
      [`subject:${input.subject}`, w.author.id],
    ]);
    expect(state.revisions.map((r) => r.external_id).sort()).toEqual(
      [`author-email:${w.author.email}`, `subject:${input.subject}`],
    );
    expect(state.obligations.length).toBeGreaterThan(0);
    const { config } = await stored(w, input.integrationName);
    expect(config).toMatchObject({
      authenticatedAccount: w.author.email, authenticatedAccountEmailVerified: true,
      authenticatedAccountId: `subject:${input.subject}`,
    });
  });

  it.each([
    ["false", { emailVerified: false }],
    ["missing", { emailVerified: undefined }],
    ["a truthy non-boolean from a direct caller", { emailVerified: "true" }],
  ])("email_verified %s creates no email-derived mapping, revision or obligation", async (_label, over) => {
    const w = await world();
    const input = publication(w, over);
    await publishGoogleDriveOAuthCredential(input);

    expect(await gdriveIdentityState(w.seed.teamId)).toEqual({ mappings: [], revisions: [], obligations: [] });
    // The unverified address never reached the shared resolver's input.
    const { rows } = await getPool().query(
      `select 1 from member_identities where team_id=$1 and email=$2 and provider='gdrive'`,
      [w.seed.teamId, w.author.email],
    );
    expect(rows).toEqual([]);
    // The credential is stored by subject; the address is kept only as untrusted account metadata.
    const { config } = await stored(w, input.integrationName);
    expect(config).toMatchObject({
      authenticatedAccount: w.author.email, authenticatedAccountEmailVerified: false,
      authenticatedAccountId: `subject:${input.subject}`, authMode: "oauth",
    });
  });

  it("an account with no email at all still stores its credential by subject and maps no one", async () => {
    const w = await world();
    const input = publication(w, { email: null, emailVerified: true });
    await publishGoogleDriveOAuthCredential(input);

    expect(await gdriveIdentityState(w.seed.teamId)).toEqual({ mappings: [], revisions: [], obligations: [] });
    const { config } = await stored(w, input.integrationName);
    expect(config.authenticatedAccountId).toBe(`subject:${input.subject}`);
    expect(config).not.toHaveProperty("authenticatedAccount");
    expect(config).not.toHaveProperty("authenticatedAccountEmailVerified");
  });

  it("a reconnect without a verified email does not keep the previous account's address", async () => {
    const w = await world();
    const first = publication(w);
    await publishGoogleDriveOAuthCredential(first);
    await publishGoogleDriveOAuthCredential({
      ...first, subject: `acct-${randomUUID().slice(0, 8)}`, email: null, emailVerified: false,
    });
    const { config } = await stored(w, first.integrationName);
    expect(config).not.toHaveProperty("authenticatedAccount");
    expect(config).not.toHaveProperty("authenticatedAccountEmailVerified");
  });

  it("an existing deliberate subject link survives an unverified reconnect and gains no email bridge", async () => {
    const w = await world();
    const input = publication(w, { emailVerified: false });
    // An Admin mapped this subject to the initiating member by hand.
    await setMemberIdentity(db(), w.seed.teamId, w.seed.memberId, {
      provider: "gdrive", externalId: `subject:${input.subject}`, email: "", handle: "manual",
    }, { actor: { kind: "member", memberId: w.seed.memberId } });
    const before = await gdriveIdentityState(w.seed.teamId);

    await publishGoogleDriveOAuthCredential(input);

    const after = await gdriveIdentityState(w.seed.teamId);
    expect(after).toEqual(before);
    expect(after.mappings).toEqual([
      { member_id: w.seed.memberId, external_id: `subject:${input.subject}`, email: "" },
    ]);
  });

  it("an unmatched verified email maps no one", async () => {
    const w = await world();
    await publishGoogleDriveOAuthCredential(publication(w, { email: `nobody-${randomUUID().slice(0, 6)}@example.com` }));
    expect((await gdriveIdentityState(w.seed.teamId)).mappings).toEqual([]);
  });

  it("an ambiguous verified email maps no one", async () => {
    const w = await world();
    // Another member already claims the same address through a provider identity.
    const { data: rival } = await db().from("members").insert({
      team_id: w.seed.teamId, email: `rival-${randomUUID().slice(0, 8)}@example.com`, display_name: "Rival",
      actor_handle: `rival-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active",
    }).select("id").single();
    await setMemberIdentity(db(), w.seed.teamId, (rival as { id: string }).id, {
      provider: "slack", externalId: `U${randomUUID().slice(0, 6)}`, email: w.author.email, handle: "rival",
    }, { actor: { kind: "member", memberId: w.seed.memberId } });

    await publishGoogleDriveOAuthCredential(publication(w));
    expect((await gdriveIdentityState(w.seed.teamId)).mappings).toEqual([]);
  });

  it("a verified email that conflicts with a manual subject link rolls everything back", async () => {
    const w = await world();
    const input = publication(w);
    await setMemberIdentity(db(), w.seed.teamId, w.seed.memberId, {
      provider: "gdrive", externalId: `subject:${input.subject}`, email: "", handle: "manual",
    }, { actor: { kind: "member", memberId: w.seed.memberId } });
    const before = await gdriveIdentityState(w.seed.teamId);

    await expect(publishGoogleDriveOAuthCredential(input)).rejects.toBeInstanceOf(GoogleIdentityConflictError);

    expect(await gdriveIdentityState(w.seed.teamId)).toEqual(before);
    expect(await getIntegrationWithSecret(db(), w.seed.teamId, "gdrive", input.integrationName)).toBeFalsy();
  });
});
