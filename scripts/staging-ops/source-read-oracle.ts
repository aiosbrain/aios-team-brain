import "server-only";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { GET as itemsGET } from "@/app/api/v1/items/route";
import { adminClient } from "@/lib/db/admin";

/**
 * THE SOURCE-SIDE APPLICATION ORACLE, before anything is copied.
 *
 * Why this exists. The harness proved a lot about the RESTORED pair and nothing about the source:
 * restore and ready receipts, a graph census, sanitation counts. Then the app read failed — and the
 * fixture seed created items and project grants but **zero context units or memberships**, while
 * `GET /api/v1/items` intersects every result with the caller's current include memberships whose
 * units are active and item-grain. So the seed predicted `internal=0, external=0` BEFORE the copy:
 * a successful authentication returning an empty page, indistinguishable from a broken restore.
 *
 * A SQL count could not have caught that, because the whole question is what the *handler's*
 * visibility predicate does. So this invokes the REAL `GET` handler, with REAL API-key
 * authentication, against the REAL source database — the same code path staging is later asked
 * about, run against the data before it travels.
 *
 * Run under tsx with `--conditions react-server`, with `DATABASE_URL` pointed at the SOURCE
 * database (the same way `reapply-testers.ts` is invoked).
 *
 * Output is one JSON line of ALLOWLISTED synthetic identities only: the fixture's own item IDs, the
 * granted project IDs, counts and states. Anything unrecognised is reported as a COUNT and never as
 * an ID — no bodies, no credentials, no paths.
 */

const TEAM = "11111111-1111-4111-8111-111111111111";
const TEAM_SLUG = "paired-test";
const INTERNAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const EXTERNAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const ITEMS = {
  external: "33333333-3333-4333-8333-333333333330",
  team: "33333333-3333-4333-8333-333333333331",
  private: "33333333-3333-4333-8333-333333333332",
  deferred: "33333333-3333-4333-8333-333333333333",
} as const;
const PROJECTS = {
  external: "22222222-2222-4222-8222-222222222220",
  team: "22222222-2222-4222-8222-222222222221",
  private: "22222222-2222-4222-8222-222222222222",
  deferred: "22222222-2222-4222-8222-222222222223",
} as const;

/** Every identity this fixture is allowed to NAME in a diagnostic. Anything else is a count. */
const ALLOWLIST = new Set<string>([...Object.values(ITEMS), ...Object.values(PROJECTS)]);
const nameable = (ids: Iterable<string>) => {
  const named: string[] = [];
  let unknown = 0;
  for (const id of ids) { if (ALLOWLIST.has(id)) named.push(id); else unknown += 1; }
  return { named: named.sort(), unknown };
};

const ACCESS: Record<string, string> = { external: "external", team: "team", private: "team", deferred: "team" };

type ApiKey = { wire: string; hash: string };
const apiKey = (keyId: string, secret: string): ApiKey => ({ wire: `aios_${keyId}_${secret}`, hash: createHash("sha256").update(secret).digest("hex") });

async function readAs(key: string): Promise<{ status: number; ids: string[]; access: Record<string, string>; nextCursor: unknown }> {
  const request = new NextRequest("http://source.local/api/v1/items", {
    headers: { authorization: `Bearer ${key}`, "x-aios-team": TEAM_SLUG },
  });
  const response = await itemsGET(request);
  const body = (await response.json()) as { items?: { id: string; access: string }[]; next_cursor?: unknown };
  const items = body.items ?? [];
  return {
    status: response.status,
    ids: items.map((item) => item.id),
    access: Object.fromEntries(items.map((item) => [item.id, item.access])),
    nextCursor: body.next_cursor ?? null,
  };
}

/** Fixture-owned keys, written and removed by this process. Never printed. */
async function withHarnessKeys<T>(run: (keys: { internal: ApiKey; external: ApiKey }) => Promise<T>): Promise<T> {
  const db = adminClient();
  const internal = apiKey("internal01", "internal-secret-012345678901234567890123");
  const external = apiKey("external01", "external-secret-012345678901234567890123");
  // Delete-then-insert rather than an upsert: `key_id` is uniquely indexed and this process owns
  // both of these ids for the length of the call.
  await db.from("api_keys").delete().eq("team_id", TEAM).in("key_id", ["internal01", "external01"]);
  const { error } = await db.from("api_keys").insert([
    { team_id: TEAM, member_id: INTERNAL, key_id: "internal01", key_hash: internal.hash, name: "source-oracle" },
    { team_id: TEAM, member_id: EXTERNAL, key_id: "external01", key_hash: external.hash, name: "source-oracle" },
  ]);
  if (error) throw new Error(`source oracle could not provision its own harness keys: ${error.message}`);
  try { return await run({ internal, external }); }
  finally { await db.from("api_keys").delete().eq("team_id", TEAM).eq("name", "source-oracle"); }
}

/**
 * The substrate this handler's predicate reads is deliberately NOT queried here.
 *
 * Those two tables have single-writer owner modules and a build-failing guard that flags any file
 * NAMING them while containing a write verb — and this file writes `api_keys` to authenticate.
 * The guard is right to be coarse: the variable-table idiom is live in this repo, so "it is only a
 * read" is not something a scanner can establish. The substrate counts and identities are collected
 * by the fixture (`compare-substrate`), which is read-only against both databases, and are reported
 * alongside this oracle's own failures there.
 */

/**
 * EXACT SETS, not counts. Exported so its discriminating power is provable without a database:
 *
 *  - a NARROWED set (a membership removed or closed) must fail, which is the whole point;
 *  - a set of the RIGHT SIZE containing a wrong id must also fail — counting is what let an
 *    empty-but-successful read look like a passing one for so long;
 *  - a duplicate id must fail, because `[a, a]` and `[a, b]` have the same length.
 *
 * Diagnostics name only allowlisted synthetic identities; anything else is a count.
 */
export function compareIdSets(actual: string[], expected: string[]) {
  const seen = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    ok: seen.size === actual.length && seen.size === expectedSet.size && [...expectedSet].every((id) => seen.has(id)),
    duplicates: actual.length - seen.size,
    missing: nameable([...expectedSet].filter((id) => !seen.has(id))),
    extra: nameable([...seen].filter((id) => !expectedSet.has(id))),
  };
}

function assertExactly(label: string, actual: string[], expected: string[], context: Record<string, unknown>) {
  const verdict = compareIdSets(actual, expected);
  if (verdict.ok) return;
  throw new Error(`${label}: expected ${expected.length} item(s), got ${actual.length}; ${JSON.stringify({ ...verdict, ...context })}`);
}

export async function assertSourceVisibility(): Promise<Record<string, unknown>> {
  const result = await withHarnessKeys(async (keys) => {
    const internal = await readAs(keys.internal.wire);
    const external = await readAs(keys.external.wire);
    for (const [label, read] of [["internal", internal], ["external", external]] as const) {
      if (read.status !== 200) {
        throw new Error(`source read as ${label} answered ${read.status}, not 200 (stage: source-read)`);
      }
      // A page boundary would make an "exact set" assertion a statement about page one only.
      if (read.nextCursor !== null) throw new Error(`source read as ${label} reported a further page (${String(read.nextCursor)}); the exact-set assertion would be about page one only`);
    }

    const context = { stage: "source-read", internal: internal.ids.length, external: external.ids.length };
    assertExactly("source read as the internal tester", internal.ids, Object.values(ITEMS), context);
    assertExactly("source read as the external tester", external.ids, [ITEMS.external], context);

    // The ACCESS values, not just the ids: an external principal seeing an `access='team'` row would
    // be the same count with a different meaning.
    for (const [kind, id] of Object.entries(ITEMS)) {
      if (internal.access[id] !== ACCESS[kind]) throw new Error(`source read: item ${id} reported access ${internal.access[id]}, expected ${ACCESS[kind]}`);
    }
    if (external.access[ITEMS.external] !== "external") throw new Error(`source read: the external tester's one item reported access ${external.access[ITEMS.external]}`);

    return { internalItems: internal.ids.length, externalItems: external.ids.length };
  });
  return { status: "source-visibility-asserted", ...result };
}

if (process.argv.includes("--run")) {
  assertSourceVisibility()
    .then((out) => { console.log(JSON.stringify(out)); })
    .catch((error: unknown) => {
      console.error(`source read oracle refused: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
