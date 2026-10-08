import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * AIO-1167 — the provider identity object of `GET /api/v1/members` and
 * `GET /api/v1/identities/resolve`.
 *
 * Spec.
 *   · Each provider identity in either response has EXACTLY the keys `provider`, `externalId` and
 *     `handle` — the shape external callers (the `slack` CLI, comms agents) have always read.
 *   · The identity's `email` and its mapping `revision` are the Admin row's observation of the link.
 *     They are read (the Admin view needs them to change or unlink an identity) and are in neither
 *     response, for any provider, with or without the `?provider=` filter.
 *   · Everything else about the two responses is unchanged: the filter still narrows, and
 *     `slack_id` is still the linked Slack id.
 *
 * The identity reader and the resolver are the real ones; only the database, the key check and the
 * rate limit are fakes. The same shape against real Postgres is `members-resolve.datamechanics`.
 */
const h = vi.hoisted(() => ({
  TEAM: "team-1",
  ADA: "member-ada",
  BOB: "member-bob",
  tables: {} as Record<string, Record<string, unknown>[]>,
  identityRows: [] as Record<string, unknown>[],
  runSql: vi.fn(),
}));

/** The slice of the query builder these two routes use: every filter is already applied by the
 * fixture, so a chain resolves to its table's rows and `maybeSingle` to the first of them. */
function table(name: string) {
  const result = () => ({ data: h.tables[name] ?? [], error: null });
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "neq", "order"]) chain[method] = () => chain;
  chain.maybeSingle = async () => ({ data: (h.tables[name] ?? [])[0] ?? null, error: null });
  chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result()).then(resolve, reject);
  return chain;
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({ from: table }) }));
vi.mock("@/lib/db/pg/pool", () => ({ runSql: h.runSql }));
vi.mock("@/lib/api/auth", () => ({
  authenticateApiKey: async () => ({ teamId: h.TEAM, memberId: h.ADA, apiKeyId: "key-1" }),
}));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: async () => true }));

const { GET: membersGET } = await import("@/app/api/v1/members/route");
const { GET: resolveGET } = await import("@/app/api/v1/identities/resolve/route");
const { listMemberIdentities } = await import("@/lib/identity/list");

const { TEAM, ADA, BOB } = h;
const LEGACY_KEYS = ["externalId", "handle", "provider"];

const get = (route: (request: NextRequest) => Promise<Response>, path: string): Promise<Response> =>
  route(new Request(`https://brain.example.com${path}`, {
    headers: { Authorization: "Bearer aios_key-1_secret" },
  }) as unknown as NextRequest);

beforeEach(() => {
  const member = (id: string, name: string) => ({
    id, email: `${name}@team.test`, display_name: name, actor_handle: name, github_login: null,
    avatar_url: null, role: "member", tier: "team", status: "active",
  });
  h.tables = {
    members: [member(ADA, "ada"), member(BOB, "bob")],
    member_emails: [{ member_id: ADA, email: "ada@alias.test" }],
    member_identities: [
      { provider: "slack", external_id: "UADA0001", email: "ada.slack@private.test", member_id: ADA },
    ],
    member_identity_mapping_state: [],
  };
  // What the one-statement identity read returns: every row carries the email and the revision.
  h.identityRows = [
    { member_id: ADA, provider: "slack", external_id: "UADA0001", handle: "ada", email: "ada.slack@private.test", revision: "7" },
    { member_id: ADA, provider: "gdrive", external_id: "permission:Ada-1", handle: null, email: "ada.drive@private.test", revision: 3 },
    { member_id: BOB, provider: "linear", external_id: "lin-bob", handle: "bob", email: null, revision: null },
  ];
  h.runSql.mockReset().mockImplementation(async () => ({ rows: h.identityRows }));
});

describe("GET /api/v1/members — provider identity shape", () => {
  it("returns each identity with exactly provider, externalId and handle; email and revision are read and not returned", async () => {
    const response = await get(membersGET, "/api/v1/members");
    expect(response.status).toBe(200);
    const text = await response.text();
    const { members } = JSON.parse(text) as { members: { id: string; identities: Record<string, unknown>[] }[] };
    const identitiesOf = (id: string) => members.find((member) => member.id === id)?.identities;

    expect(identitiesOf(ADA)).toEqual([
      { provider: "gdrive", externalId: "permission:Ada-1", handle: "" },
      { provider: "slack", externalId: "UADA0001", handle: "ada" },
    ]);
    expect(identitiesOf(BOB)).toEqual([{ provider: "linear", externalId: "lin-bob", handle: "bob" }]);
    for (const member of members) {
      for (const identity of member.identities) expect(Object.keys(identity).sort()).toEqual(LEGACY_KEYS);
    }
    // Not under another name, and not anywhere else in the body.
    expect(text).not.toContain("private.test");
    expect(text).not.toContain("revision");
  });

  it("the Admin view's read of the same identities still carries each link's email and revision", async () => {
    const listing = await listMemberIdentities({ from: table } as never, TEAM);

    expect(listing.get(ADA)?.providers).toEqual([
      { provider: "gdrive", externalId: "permission:Ada-1", handle: "", email: "ada.drive@private.test", revision: 3 },
      { provider: "slack", externalId: "UADA0001", handle: "ada", email: "ada.slack@private.test", revision: 7 },
    ]);
    expect(listing.get(BOB)?.providers).toEqual([
      { provider: "linear", externalId: "lin-bob", handle: "bob", email: "", revision: 0 },
    ]);
  });

  it("keeps the same three keys under the ?provider= filter, which still narrows members and identities", async () => {
    const response = await get(membersGET, "/api/v1/members?provider=slack");
    const { members } = (await response.json()) as { members: { id: string; identities: Record<string, unknown>[] }[] };

    expect(members.map((member) => member.id)).toEqual([ADA]);
    expect(members[0].identities).toEqual([{ provider: "slack", externalId: "UADA0001", handle: "ada" }]);
    expect(Object.keys(members[0].identities[0]).sort()).toEqual(LEGACY_KEYS);
  });
});

describe("GET /api/v1/identities/resolve — provider identity shape", () => {
  it("returns each identity with exactly provider, externalId and handle, and slack_id from the same link", async () => {
    const response = await get(resolveGET, "/api/v1/identities/resolve?provider=slack&external_id=UADA0001");
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as {
      member: { id: string }; identities: Record<string, unknown>[]; email_aliases: string[]; slack_id: string | null;
    };

    expect(Object.keys(body).sort()).toEqual(["email_aliases", "identities", "member", "slack_id"]);
    expect(body.member.id).toBe(ADA);
    expect(body.identities).toEqual([
      { provider: "gdrive", externalId: "permission:Ada-1", handle: "" },
      { provider: "slack", externalId: "UADA0001", handle: "ada" },
    ]);
    for (const identity of body.identities) expect(Object.keys(identity).sort()).toEqual(LEGACY_KEYS);
    expect(body.email_aliases).toEqual(["ada@alias.test"]);
    expect(body.slack_id).toBe("UADA0001");
    expect(text).not.toContain("private.test");
    expect(text).not.toContain("revision");
  });
});
