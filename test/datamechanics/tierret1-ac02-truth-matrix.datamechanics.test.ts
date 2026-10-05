import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { GET as itemsGET } from "@/app/api/v1/items/route";
import { GET as itemGET } from "@/app/api/v1/items/[id]/route";
import { issueApiKey } from "@/lib/admin/keys";
import { createMember } from "@/lib/admin/members";
import { createGroup, addMemberToGroup, grantProjectToGroup, revokeProjectFromGroup } from "@/lib/access/groups";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { visibleProjectCards } from "@/lib/access/enforce";
import { resolveContentView, provenanceCtxFor } from "@/lib/access/admission";
import { rowVisibleByProvenanceCtx } from "@/lib/access/provenance";
import {
  newSqlParams,
  provenanceRowSql,
  provenanceRowSqlFromIds,
  type ProvenanceIdsCtx,
  type ProvenanceSqlCtx,
} from "@/lib/access/provenance-sql";
import { runSql } from "@/lib/db/pg/pool";

/**
 * TIERRET-1 / AIO-1045 AC-02 — ONE fixture, explicit EXPECTED truth, every row-level hidden reason,
 * every compared surface (accepted spec docs/design/tierret1-membership-only.md, AC-02: "compare
 * explicit fixture truth for item list/by-id, structured TS and both SQL forms; do not test parity
 * alone").
 *
 * The gap this closes: the ENFB-2 inverse-conjunct fixture (enfb2-inquery-provenance) drives only
 * the ID-ARRAY SQL form + TS, and the project-row fixture (enfb2-project-rows) drives the SEMIJOIN
 * (`provenanceRowSql` → `itemVisibleSql`) only over granted/restricted shapes. A semijoin that lost
 * `m.decision = 'include'`, `m.valid_to is null` or `u.state = 'active'` passed both. Here every
 * hidden source sits in the SAME granted project as the positive one and differs from it by exactly
 * ONE condition, so each expectation pins one conjunct of each owner.
 *
 * Contexts are the PRODUCTION ones: `resolveContentView` (the one admission resolver) →
 * `provenanceCtxFor` for the id-array SQL + TS owners, and the semijoin ctx assembled exactly as
 * `lib/access/enforce.ts#readerRule` assembles it (granted set + the resolver's Everyone bit + the
 * member's hand-entered scope). Nothing is derived from another owner's output: every expected set
 * below is a literal.
 *
 * Out of scope here BY DESIGN (adjudication astra-release.decisions.md): principal-level refusals
 * (inactive / missing / foreign-team member / unknown kind / oracle or substrate error) are owned by
 * the admission boundary and pinned where it is — tierret1-admission.datamechanics.test.ts
 * ("inactive rows are rejected BEFORE either arm…", "an unrecognised member kind…", "missing,
 * foreign-team and unreadable members fail CLOSED…"), and over a real socket in
 * test/http/tierret1-membership-reads.http.test.ts ("invalid, cross-team and inactive credentials are
 * refused on every read surface"). The pure SQL builders are not principal authenticators and are not
 * re-asked to be one.
 */

const BODY = {
  pos: "ac02 positive granted body",
  ungranted: "ac02 ungranted body",
  excluded: "ac02 excluded body",
  expired: "ac02 expired body",
  retracted: "ac02 retracted body",
  foreign: "ac02 foreign-team body",
} as const;
type Source = keyof typeof BODY;

const now = () => new Date().toISOString();

async function mkInitiative(seed: Seed, slug: string): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `${slug}-${randomUUID().slice(0, 6)}`, name: slug, kind: "initiative" })
    .select("id")
    .single();
  expect(error).toBeNull();
  return (data as { id: string }).id;
}

async function unitOf(itemId: string): Promise<string> {
  const { data, error } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  expect(error).toBeNull();
  return (data as { id: string }).id;
}

/** Fixture-only custom placement (spec AC-01): retire the current memberships, include into `projectId`. */
async function moveMembership(seed: Seed, itemId: string, projectId: string): Promise<void> {
  const unit = await unitOf(itemId);
  await db().from("project_context_memberships").update({ valid_to: now() }).eq("context_unit_id", unit).is("valid_to", null);
  const { error } = await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: projectId, context_unit_id: unit, method: "manual" });
  expect(error).toBeNull();
}

async function activeMember(seed: Seed, tier: "team" | "external", label: string): Promise<string> {
  // PRODUCTION creation path (invite-default builtin row by tier), then activated.
  const m = await createMember(db(), seed.teamId, { email: `${randomUUID()}@test.local`, displayName: label, actorHandle: `${label}-${randomUUID().slice(0, 8)}`, role: "member", tier });
  const { error } = await db().from("members").update({ status: "active" }).eq("id", m.id).eq("team_id", seed.teamId);
  expect(error).toBeNull();
  return m.id;
}

async function grantedGroup(seed: Seed, projectId: string, memberId: string, label: string): Promise<string> {
  const g = await createGroup(db(), seed.teamId, `${label}-${randomUUID().slice(0, 6)}`, label, seed.memberId);
  expect(g.ok, g.error).toBe(true);
  expect((await addMemberToGroup(db(), seed.teamId, g.groupId!, memberId, seed.memberId)).ok).toBe(true);
  expect((await grantProjectToGroup(db(), seed.teamId, projectId, g.groupId!, seed.memberId)).ok).toBe(true);
  return g.groupId!;
}

interface Fx {
  seed: Seed;
  foreign: Seed;
  srcId: string;
  X: string;
  item: Record<Source, string>;
  external: string; // external-posture human, NOT in Everyone, granted X via its own custom group
  externalKey: string;
  externalGroup: string;
  peer: string; // team-posture human (Everyone), granted X via a SEPARATE custom group
  peerKey: string;
  foreignKey: string; // the foreign team's own Everyone member — non-vacuity control for the foreign source
}

async function buildFixture(): Promise<Fx> {
  const seed = await seedTeam();
  await backfillTeamContext(db(), seed.teamId);
  // Every source is a TEAM-labelled item: the membership-only rule must serve the positive one to an
  // external-posture member, so no label can be what hides the others.
  const ing = async (s: Exclude<Source, "foreign">) => ingest(seed, { path: `ac02/${s}.md`, body: BODY[s], access: "team", project: "src" });
  const pos = await ing("pos");
  const ungranted = await ing("ungranted");
  const excluded = await ing("excluded");
  const expired = await ing("expired");
  const retracted = await ing("retracted");
  await backfillTeamContext(db(), seed.teamId);
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);

  const X = await mkInitiative(seed, "ac02-x");
  const Y = await mkInitiative(seed, "ac02-y");
  // Y is a real granted project — to a group no viewer belongs to — so its absence is the oracle's doing.
  const insiders = await createGroup(db(), seed.teamId, `ac02-iy-${randomUUID().slice(0, 6)}`, "Insiders Y", seed.memberId);
  expect((await grantProjectToGroup(db(), seed.teamId, Y, insiders.groupId!, seed.memberId)).ok).toBe(true);

  // Placement: every source leaves General. All but `ungranted` go into the GRANTED project X; each
  // hidden one then differs from `pos` by exactly one membership/unit condition.
  await moveMembership(seed, pos.id, X);
  await moveMembership(seed, ungranted.id, Y);
  for (const hidden of [excluded, expired, retracted]) await moveMembership(seed, hidden.id, X);
  // excluded: the CURRENT X membership is decision='exclude'.            (m.decision = 'include')
  const exU = await db().from("project_context_memberships").update({ decision: "exclude" }).eq("context_unit_id", await unitOf(excluded.id)).eq("project_id", X).is("valid_to", null).select("id");
  expect(exU.error).toBeNull();
  expect((exU.data ?? []).length, "excluded fixture flipped exactly one current membership").toBe(1);
  // expired: the X include membership is closed (valid_to set); no current membership remains. (m.valid_to is null)
  const xpU = await db().from("project_context_memberships").update({ valid_to: now() }).eq("context_unit_id", await unitOf(expired.id)).eq("project_id", X).is("valid_to", null).select("id");
  expect(xpU.error).toBeNull();
  expect((xpU.data ?? []).length, "expired fixture closed exactly one current membership").toBe(1);
  // retracted: the CURRENT include into X stays; the unit itself is retracted.  (u.state = 'active')
  const rtU = await db().from("project_context_units").update({ state: "retracted" }).eq("source_item_id", retracted.id).select("id");
  expect(rtU.error).toBeNull();
  expect((rtU.data ?? []).length).toBe(1);

  const srcId = pos.projectId!;
  // Sourced structured rows live in the ingest container (src), like real materialization.
  const sourced: [string, string][] = [
    ["SRC-POS", pos.id],
    ["SRC-UNGRANTED", ungranted.id],
    ["SRC-EXCLUDED", excluded.id],
    ["SRC-EXPIRED", expired.id],
    ["SRC-RETRACTED", retracted.id],
  ];
  for (const [row_key, source_item_id] of sourced) {
    const { error } = await db().from("tasks").insert({ team_id: seed.teamId, project_id: srcId, row_key, title: row_key, status: "backlog", audience: "team", origin: "sync", source_item_id });
    expect(error, `fixture task ${row_key}`).toBeNull();
  }
  // Existing unsourced controls, unchanged policy: hand-typed in the granted X / the ungranted Y, and a
  // no-provenance row (null source, null creator) that serves nobody.
  for (const [row_key, project_id, created_by, origin] of [
    ["HAND-X", X, seed.memberId, "ui"],
    ["HAND-Y", Y, seed.memberId, "ui"],
    ["NO-PROV", X, null, "sync"],
  ] as const) {
    const { error } = await db().from("tasks").insert({ team_id: seed.teamId, project_id, row_key, title: row_key, status: "backlog", audience: "team", origin, source_item_id: null, created_by });
    expect(error, `fixture task ${row_key}`).toBeNull();
  }

  // The foreign team: its own source, visible inside ITS team (control below) — never referenced from
  // this team's rows (no cross-team FK corruption).
  const foreign = await seedTeam();
  await backfillTeamContext(db(), foreign.teamId);
  const fItem = await ingest(foreign, { path: "ac02/foreign.md", body: BODY.foreign, access: "team", project: "fsrc" });
  await backfillTeamContext(db(), foreign.teamId);
  expect((await ensureAccessBootstrap(db(), foreign.teamId)).ok).toBe(true);
  const fTask = await db().from("tasks").insert({ team_id: foreign.teamId, project_id: fItem.projectId!, row_key: "SRC-FOREIGN", title: "SRC-FOREIGN", status: "backlog", audience: "team", origin: "sync", source_item_id: fItem.id });
  expect(fTask.error).toBeNull();

  const external = await activeMember(seed, "external", "ac02-ext");
  const externalGroup = await grantedGroup(seed, X, external, "ac02-clients");
  const peer = await activeMember(seed, "team", "ac02-peer");
  await grantedGroup(seed, X, peer, "ac02-peers");

  return {
    seed,
    foreign,
    srcId,
    X,
    item: { pos: pos.id, ungranted: ungranted.id, excluded: excluded.id, expired: expired.id, retracted: retracted.id, foreign: fItem.id },
    external,
    externalKey: (await issueApiKey(db(), seed.teamId, external, "ac02-ext")).key,
    externalGroup,
    peer,
    peerKey: (await issueApiKey(db(), seed.teamId, peer, "ac02-peer")).key,
    foreignKey: (await issueApiKey(db(), foreign.teamId, foreign.memberId, "ac02-foreign")).key,
  };
}

const req = (path: string, key: string) => new NextRequest(`http://test.local${path}`, { headers: { authorization: `Bearer ${key}` } });

/** The ACTUAL list handler: every item id it serves (single page — the fixture is far below PAGE_SIZE). */
async function listIds(key: string): Promise<string[]> {
  const res = await itemsGET(req("/api/v1/items", key));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: { id: string }[]; next_cursor: string | null };
  expect(body.next_cursor).toBeNull();
  return body.items.map((i) => i.id).sort();
}

/** The ACTUAL by-id handler. */
async function byId(key: string, id: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await itemGET(req(`/api/v1/items/${id}`, key), { params: Promise.resolve({ id }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const norm = (b: unknown) => JSON.stringify(b, (k, v) => (k === "request_id" ? "<req>" : v));

/** Production contexts for one reader, from the one admission resolver — never hand-assembled authority. */
async function contexts(teamId: string, memberId: string) {
  const view = await resolveContentView(db(), teamId, memberId);
  expect(view.error, "item substrate must not error").toBeFalsy();
  if (view.admission.kind !== "member") throw new Error(`expected a positively admitted member, got ${view.admission.kind}`);
  const ids = provenanceCtxFor(view);
  // Exactly `enforce.ts#readerRule`: the oracle's granted set + the resolver's Everyone bit + scope.
  const semi: ProvenanceSqlCtx = {
    teamId,
    grantedProjectIds: view.admission.grantedProjectIds,
    teamPosture: ids.teamPosture,
    principal: ids.principal,
    memberProjectIds: ids.memberProjectIds,
  };
  return { admission: view.admission, ids, semi };
}

async function sqlIdArrayKeys(teamId: string, ctx: ProvenanceIdsCtx): Promise<string[]> {
  const p = newSqlParams();
  const res = await runSql<{ row_key: string }>(`select t.row_key from tasks t where t.team_id = ${p.add(teamId)} and ${provenanceRowSqlFromIds("t", p, ctx)}`, p.values);
  return res.rows.map((r) => r.row_key).sort();
}

/** The SEMIJOIN form — real SQL against project_context_units/memberships, no item-id array. */
async function sqlSemijoinKeys(teamId: string, ctx: ProvenanceSqlCtx): Promise<string[]> {
  const p = newSqlParams();
  const res = await runSql<{ row_key: string }>(`select t.row_key from tasks t where t.team_id = ${p.add(teamId)} and ${provenanceRowSql("t", p, ctx)}`, p.values);
  return res.rows.map((r) => r.row_key).sort();
}

async function tsKeys(teamId: string, ctx: ProvenanceIdsCtx): Promise<string[]> {
  const { data, error } = await db().from("tasks").select("row_key, source_item_id, created_by, project_id").eq("team_id", teamId);
  expect(error).toBeNull();
  const rows = (data ?? []) as { row_key: string; source_item_id: string | null; created_by: string | null; project_id: string }[];
  expect(rows.length, "the TS owner judged the whole planted set").toBe(8);
  return rows.filter((r) => rowVisibleByProvenanceCtx(r, ctx)).map((r) => r.row_key).sort();
}

interface Expect {
  items: Source[]; // exactly the items the reader is served (list) / gets 200 for (by-id)
  rows: string[]; // exactly the task row keys every structured owner returns
  srcCard: { visibleItems: number; visibleTasks: number } | null; // the production semijoin project reader
}

/** Assert ONE reader against its literal expectation on every surface. Each surface independently. */
async function assertReader(F: Fx, who: string, memberId: string, key: string, want: Expect): Promise<void> {
  const { ids, semi } = await contexts(F.seed.teamId, memberId);
  const wantRows = [...want.rows].sort();

  // Item LIST handler — exact served set.
  expect(await listIds(key), `${who}: item list`).toEqual(want.items.map((s) => F.item[s]).sort());

  // Item BY-ID handler — 200 + body for served items; 404 indistinguishable from absent otherwise.
  const absent = await byId(key, randomUUID());
  expect(absent.status).toBe(404);
  for (const s of Object.keys(BODY) as Source[]) {
    const r = await byId(key, F.item[s]);
    if (want.items.includes(s)) {
      expect(r.status, `${who}: by-id ${s}`).toBe(200);
      expect(r.body.body, `${who}: by-id ${s} body`).toBe(BODY[s]);
    } else {
      expect(r.status, `${who}: by-id ${s} must 404`).toBe(404);
      expect(norm(r.body), `${who}: by-id ${s} indistinguishable from absent`).toBe(norm(absent.body));
    }
  }

  // Structured: TS owner, id-array SQL, semijoin SQL — each against the SAME literal set.
  expect(await tsKeys(F.seed.teamId, ids), `${who}: TS provenance`).toEqual(wantRows);
  expect(await sqlIdArrayKeys(F.seed.teamId, ids), `${who}: provenanceRowSqlFromIds`).toEqual(wantRows);
  expect(await sqlSemijoinKeys(F.seed.teamId, semi), `${who}: provenanceRowSql (semijoin)`).toEqual(wantRows);

  // The production semijoin project reader over the ingest container that holds every planted
  // source: its counts (itemVisibleSql + provenanceRowSql) must count the positive only.
  const cards = await visibleProjectCards(db(), { teamId: F.seed.teamId, memberId });
  expect(cards.error, `${who}: cards must not error`).toBeFalsy();
  const src = cards.rows.find((r) => r.id === F.srcId);
  if (want.srcCard === null) expect(src, `${who}: src container must not be readable`).toBeUndefined();
  else expect(src && { visibleItems: src.visibleItems, visibleTasks: src.visibleTasks }, `${who}: src card counts`).toEqual(want.srcCard);
}

describe("TIERRET-1 AC-02 — explicit truth matrix: item list/by-id, structured TS, BOTH SQL forms", () => {
  it("positive / ungranted / excluded / expired / retracted / foreign across every surface, then a grant revocation re-resolved fresh", async () => {
    const F = await buildFixture();

    // Admission facts the matrix rests on (from the production resolver, asserted, not assumed).
    const ext = await contexts(F.seed.teamId, F.external);
    expect(ext.admission.everyone, "the external collaborator is NOT an Everyone member").toBe(false);
    expect(ext.admission.posture).toBe("external");
    expect(ext.admission.grantedProjectIds).toContain(F.X);
    const peer = await contexts(F.seed.teamId, F.peer);
    expect(peer.admission.everyone, "the peer is an oracle-accepted Everyone human").toBe(true);
    expect(peer.admission.grantedProjectIds).toContain(F.X);

    // EXTERNAL-posture member with a custom grant: the positive source only (membership, not label),
    // and hand-entered rows only in its granted project.
    await assertReader(F, "external", F.external, F.externalKey, {
      items: ["pos"],
      rows: ["SRC-POS", "HAND-X"],
      srcCard: { visibleItems: 1, visibleTasks: 1 },
    });
    // TEAM-posture member with the same grant: the same sourced truth; Everyone keeps every hand-typed row.
    await assertReader(F, "team peer", F.peer, F.peerKey, {
      items: ["pos"],
      rows: ["SRC-POS", "HAND-X", "HAND-Y"],
      srcCard: { visibleItems: 1, visibleTasks: 1 },
    });

    // Foreign-team control: the foreign source is a REAL visible source in its own team (non-vacuity),
    // and every surface above already refused it to both of this team's readers.
    const f = await contexts(F.foreign.teamId, F.foreign.memberId);
    expect(await sqlIdArrayKeys(F.foreign.teamId, f.ids)).toEqual(["SRC-FOREIGN"]);
    expect(await sqlSemijoinKeys(F.foreign.teamId, f.semi)).toEqual(["SRC-FOREIGN"]);
    expect(await listIds(F.foreignKey)).toEqual([F.item.foreign]);
    const fById = await byId(F.foreignKey, F.item.foreign);
    expect(fById.status).toBe(200);
    expect(fById.body.body).toBe(BODY.foreign);

    // GRANT REMOVAL through the production revoke writer (an active team-posture admin).
    expect((await db().from("members").update({ role: "admin" }).eq("id", F.seed.memberId)).error).toBeNull();
    const revoke = await revokeProjectFromGroup(db(), F.seed.teamId, F.X, F.externalGroup, { kind: "member", memberId: F.seed.memberId });
    expect(revoke, revoke.error).toMatchObject({ ok: true, revoked: true });

    // Freshly resolved: the external member no longer holds X; the formerly granted source and the
    // granted hand-typed row vanish from EVERY surface, and the container is no longer readable.
    const after = await contexts(F.seed.teamId, F.external);
    expect(after.admission.grantedProjectIds).not.toContain(F.X);
    await assertReader(F, "external after revoke", F.external, F.externalKey, { items: [], rows: [], srcCard: null });
    // Targeted, not global: the peer's separate grant still serves the same positive truth.
    await assertReader(F, "team peer after revoke", F.peer, F.peerKey, {
      items: ["pos"],
      rows: ["SRC-POS", "HAND-X", "HAND-Y"],
      srcCard: { visibleItems: 1, visibleTasks: 1 },
    });
  });
});
