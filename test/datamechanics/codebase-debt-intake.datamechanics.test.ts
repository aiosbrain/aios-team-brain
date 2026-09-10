import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/v1/codebases/[slug]/debt-intake-events/route";
import { getPool } from "@/lib/db/pg/pool";
import { issueApiKey } from "@/lib/admin/keys";
import { db, seedTeam, type Seed } from "./helpers";

// Independent contract-derived fixtures and hash implementation: do not call the production
// canonicalizer to manufacture its own expected answers. Every test executes the real route,
// auth, transaction, constraints and audit against the isolated runner's private Postgres.
type RecordFixture = {
  event_id: string; record_type: string; candidate_id?: string; sequence?: number;
  producer: { name: string; version: string; run_id: string };
  attribution: { program_id: string; run_id: string; attempt: number; issue: unknown };
  identity?: { source_record_key: { kind: string; value: number | string }; [key: string]: unknown };
  codebases?: string[]; predecessor_event_id?: string | null; state?: string;
  disposition?: string; duplicate_target?: string | null; episode?: number;
  [key: string]: unknown;
};
const fixtureRoot = join(process.cwd(), "test/fixtures/contract/debt-intake");
function ledger(name = "complete-lifecycle"): RecordFixture[] {
  return readFileSync(join(fixtureRoot, `${name}.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function digest(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\0${canonical(value)}`).digest("hex");
}
function rehash(record: RecordFixture): RecordFixture {
  const copy = structuredClone(record);
  const { event_id: _id, ...body } = copy;
  void _id;
  copy.event_id = digest("aios.finding.event.v1", body);
  return copy;
}
const tables = ["codebase_debt_candidates", "codebase_debt_candidate_codebases", "codebase_debt_candidate_events"] as const;
type Context = Seed & { key: string; apiKeyId: string };
const originalRegistry = process.env.DEBT_INTAKE_REGISTRY_JSON;
afterEach(() => {
  if (originalRegistry === undefined) delete process.env.DEBT_INTAKE_REGISTRY_JSON;
  else process.env.DEBT_INTAKE_REGISTRY_JSON = originalRegistry;
});
async function setup(): Promise<Context> {
  const seed = await seedTeam();
  const issued = await issueApiKey(db(), seed.teamId, seed.memberId, "intake test uploader");
  const { rows: keys } = await getPool().query("select id from api_keys where key_id=$1", [issued.keyId]);
  const ctx = { ...seed, key: issued.key, apiKeyId: keys[0].id as string };
  for (const slug of ["devtools", "harness", "workspace"]) {
    await getPool().query("insert into codebases(team_id,slug,full_name) values($1,$2,$3)", [seed.teamId, slug, `fixture/${slug}`]);
  }
  const trusted = JSON.parse(readFileSync(join(fixtureRoot, "trusted-config.json"), "utf8"));
  process.env.DEBT_INTAKE_REGISTRY_JSON = JSON.stringify({
    [seed.teamId]: { ...trusted, uploaders: { [ctx.apiKeyId]: trusted.producers } },
  });
  return ctx;
}
function send(ctx: Context, records: RecordFixture[], slug = "harness") {
  return raw(ctx, JSON.stringify({ schema_version: "debt-intake-events.v1", events: records }), slug);
}
function raw(ctx: Context, body: string | Uint8Array, slug = "harness", headers: Record<string, string> = {}) {
  const request = new NextRequest(`http://test/api/v1/codebases/${slug}/debt-intake-events`, {
    method: "POST", headers: { Authorization: `Bearer ${ctx.key}`, "X-AIOS-Team": ctx.teamSlug, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : new Blob([body as Uint8Array<ArrayBuffer>]),
  });
  return POST(request, { params: Promise.resolve({ slug }) });
}
async function counts(ctx: Context) {
  return Promise.all(tables.map(async table => Number((await getPool().query(`select count(*) from ${table} where team_id=$1`, [ctx.teamId])).rows[0].count)));
}
async function denied(response: Response, status = 422, code = "invalid_events") {
  expect(response.status, await response.clone().text()).toBe(status);
  expect((await response.json()).error.code).toBe(code);
}

describe("AIO-1101 append-only intake: real route and private Postgres", () => {
  it.each(["complete-lifecycle", "escaped-reopened", "empty-success", "provider-failure", "partial-capture", "malformed-accounted", "structural-key", "five-candidate-worked-example"])("accepts the pinned %s ledger and exact replay", async name => {
    const ctx = await setup();
    const events = ledger(name);
    const first = await send(ctx, events);
    expect(first.status, await first.clone().text()).toBe(201);
    expect(await first.json()).toEqual({ status: "ok", accepted_event_ids: events.map(e => e.event_id), duplicate_event_ids: [] });
    const before = await counts(ctx);
    const replay = await send(ctx, events);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ status: "ok", accepted_event_ids: [], duplicate_event_ids: events.map(e => e.event_id) });
    expect(await counts(ctx)).toEqual(before);
  });

  it("deduplicates within a batch and partitions mixed acknowledgments in first-occurrence order", async () => {
    const ctx = await setup(); const [a, b, c] = ledger();
    expect((await send(ctx, [a, a])).status).toBe(201);
    const result = await send(ctx, [c, a, b, c, a]);
    expect(result.status).toBe(201);
    expect(await result.json()).toEqual({ status: "ok", accepted_event_ids: [c.event_id, b.event_id], duplicate_event_ids: [a.event_id] });
    expect(await counts(ctx)).toEqual([1, 1, 3]);
  });

  it("serializes concurrent exact replay into one insert and one replay", async () => {
    const ctx = await setup(); const events = ledger();
    const responses = await Promise.all([send(ctx, events), send(ctx, events)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 201]);
    const bodies = await Promise.all(responses.map(r => r.json()));
    expect(bodies.flatMap(r => r.accepted_event_ids)).toEqual(events.map(e => e.event_id));
    expect(bodies.flatMap(r => r.duplicate_event_ids)).toEqual(events.map(e => e.event_id));
    expect(await counts(ctx)).toEqual([1, 1, events.length]);
  });

  it("rejects a missing predecessor atomically, accepts reversed contiguous input, and finalizes later", async () => {
    const ctx = await setup(); const events = ledger();
    await denied(await send(ctx, [events[1]]));
    expect(await counts(ctx)).toEqual([0, 0, 0]);
    expect((await send(ctx, events.slice(0, -1).reverse())).status).toBe(201);
    expect((await getPool().query("select count(*) from codebase_debt_candidate_events where record_type='run_summary'")).rows[0].count).toBe("0");
    expect((await send(ctx, events.slice(-1))).status).toBe(201);
    expect((await send(ctx, events.slice(0, 1))).status).toBe(200);
  });

  it("reconciles delayed summaries against their own run after a later run changes global state", async () => {
    const ctx = await setup(); const events = ledger("escaped-reopened");
    const candidates = events.filter(e => e.record_type === "candidate");
    const summaries = events.filter(e => e.record_type === "run_summary");
    expect((await send(ctx, candidates)).status).toBe(201);
    // Global latest is verified in the reopened run. The original resolution summary still
    // legitimately reports terminal=1; a global-latest aggregator would reject it.
    expect((await send(ctx, [summaries[0]])).status).toBe(201);
    expect((await send(ctx, [summaries[1]])).status).toBe(201);
  });

  it("freezes a finalized run against new candidates and differing summaries, preserving replay", async () => {
    const ctx = await setup(); const events = ledger("empty-success");
    expect((await send(ctx, events)).status).toBe(201);
    await denied(await send(ctx, [ledger()[0]]));
    const changed = rehash({ ...events[0], observed_at: "2026-08-30T10:00:00Z" });
    await denied(await send(ctx, [changed]));
    expect(await counts(ctx)).toEqual([0, 0, 1]);
    expect((await send(ctx, events)).status).toBe(200);
  });

  it("rejects changed-byte IDs and sequence forks without inserting other valid records", async () => {
    const ctx = await setup(); const [a, b, c] = ledger();
    expect((await send(ctx, [a, b])).status).toBe(201);
    await denied(await send(ctx, [{ ...b, observed_at: "2026-08-30T10:00:00Z" }, c]));
    const fork = rehash({ ...b, observed_at: "2026-08-30T10:00:00Z" });
    await denied(await send(ctx, [fork, c]));
    expect(await counts(ctx)).toEqual([1, 1, 2]);
  });

  it("stores one cross-repository candidate and historical membership union, independent of anchor", async () => {
    const ctx = await setup(); const [a, b] = ledger();
    const first = rehash({ ...a, codebases: ["devtools", "harness"] });
    const second = rehash({ ...b, predecessor_event_id: first.event_id, codebases: ["harness"] });
    expect((await send(ctx, [first], "workspace")).status).toBe(201);
    expect((await send(ctx, [second], "devtools")).status).toBe(201);
    expect(await counts(ctx)).toEqual([1, 2, 2]);
    const stored = await getPool().query("select record->'codebases' as memberships from codebase_debt_candidate_events where event_id=$1", [second.event_id]);
    expect(stored.rows[0].memberships).toEqual(["harness"]);
  });

  it("does not allow an ordinary team key to impersonate a producer, including replay after grant removal", async () => {
    const ctx = await setup(); const events = ledger("empty-success");
    const registry = JSON.parse(process.env.DEBT_INTAKE_REGISTRY_JSON!);
    delete registry[ctx.teamId].uploaders[ctx.apiKeyId];
    const permitted = process.env.DEBT_INTAKE_REGISTRY_JSON!;
    process.env.DEBT_INTAKE_REGISTRY_JSON = JSON.stringify(registry);
    await denied(await send(ctx, events), 403, "forbidden_producer");
    process.env.DEBT_INTAKE_REGISTRY_JSON = permitted;
    expect((await send(ctx, events)).status).toBe(201);
    process.env.DEBT_INTAKE_REGISTRY_JSON = JSON.stringify(registry);
    await denied(await send(ctx, events), 403, "forbidden_producer");
    expect(await counts(ctx)).toEqual([0, 0, 1]);
  });

  it("denies unauthenticated, external posture, unknown anchors and cross-team memberships", async () => {
    const ctx = await setup(); const events = ledger();
    expect((await raw(ctx, "{}", "harness", { Authorization: "Bearer invalid" })).status).toBe(401);
    await denied(await send(ctx, events, "missing"), 404, "not_found");
    const other = await seedTeam();
    await getPool().query("insert into codebases(team_id,slug,full_name) values($1,'foreign','fixture/foreign')", [other.teamId]);
    const registry = JSON.parse(process.env.DEBT_INTAKE_REGISTRY_JSON!);
    registry[ctx.teamId].codebases.push("foreign");
    process.env.DEBT_INTAKE_REGISTRY_JSON = JSON.stringify(registry);
    await denied(await send(ctx, [rehash({ ...events[0], codebases: ["foreign"] })]));
    await getPool().query("delete from group_members where team_id=$1 and member_id=$2", [ctx.teamId, ctx.memberId]);
    await denied(await send(ctx, events), 403, "forbidden_tier");
    expect(await counts(ctx)).toEqual([0, 0, 0]);
  });

  it("rolls back candidates, memberships and events when the mandatory audit insert fails", async () => {
    const ctx = await setup();
    await getPool().query(`create function intake_test_fail_audit() returns trigger language plpgsql as $$ begin raise exception 'injected audit failure'; end $$;
      create trigger intake_test_fail_audit before insert on audit_log for each row execute function intake_test_fail_audit()`);
    try {
      const response = await send(ctx, ledger());
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("injected audit failure");
      expect(await counts(ctx)).toEqual([0, 0, 0]);
    } finally {
      await getPool().query("drop trigger intake_test_fail_audit on audit_log; drop function intake_test_fail_audit()");
    }
    expect((await send(ctx, ledger())).status).toBe(201);
    const { rows } = await getPool().query("select * from audit_log where team_id=$1 and api_key_id=$2", [ctx.teamId, ctx.apiKeyId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].member_id).toBe(ctx.memberId);
    const metadata = JSON.stringify(rows[0].meta);
    expect(metadata).not.toContain(ledger()[0].event_id);
    expect(metadata).not.toContain("source_artifact_sha256");
  });

  it.each(["control", "revoked", "inactive", "posture"])("revalidates %s authorization after waiting for the team ledger lock", async change => {
    const ctx = await setup(); const pool = getPool(); const holder = await pool.connect();
    let response: Promise<Response> | undefined;
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock(hashtextextended('debt-intake:' || $1,0))", [ctx.teamId]);
    try {
      response = send(ctx, ledger("empty-success"));
      // Observe the actual waiting transaction, rather than sleeping and assuming auth ran.
      const deadline = Date.now() + 1400;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const locks = await pool.query("select 1 from pg_locks where locktype='advisory' and not granted");
        waiting = locks.rowCount !== 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      if (change === "revoked") await pool.query("update api_keys set revoked_at=now() where id=$1", [ctx.apiKeyId]);
      if (change === "inactive") await pool.query("update members set status='inactive' where id=$1", [ctx.memberId]);
      if (change === "posture") await pool.query("delete from group_members where team_id=$1 and member_id=$2", [ctx.teamId, ctx.memberId]);
    } finally {
      await holder.query("rollback"); holder.release();
    }
    const result = await response!;
    if (change === "control") expect(result.status).toBe(201);
    else {
      expect(result.status, await result.clone().text()).toBe(change === "posture" ? 403 : 401);
      expect(await counts(ctx)).toEqual([0, 0, 0]);
    }
  });

  it("returns bounded retryable lock contention without partial writes", async () => {
    const ctx = await setup(); const holder = await getPool().connect();
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock(hashtextextended('debt-intake:' || $1,0))", [ctx.teamId]);
    try {
      const result = await send(ctx, ledger("empty-success"));
      expect(Number(result.headers.get("Retry-After"))).toBeGreaterThan(0);
      await denied(result, 503, "intake_busy");
      expect(await counts(ctx)).toEqual([0, 0, 0]);
    } finally { await holder.query("rollback"); holder.release(); }
  });

  it("enforces strict lexical JSON, closed schemas, the record limit and raw-byte ceiling", async () => {
    const ctx = await setup(); const envelope = JSON.stringify({ schema_version: "debt-intake-events.v1", events: ledger("empty-success") });
    const invalid = [
      envelope.replace('"events":', '"events":[],"events":'),
      envelope.replace('"events":', '"\\u0065vents":[],"events":'),
      `\ufeff${envelope}`, envelope.replace('"attempt":1', '"attempt":1.0'),
      envelope.replace('"attempt":1', '"attempt":1e0'),
      envelope.replace('"observed_at":"2026-08-29T10:00:00Z"', '"observed_at":"2026-02-30T10:00:00Z"'),
      envelope.replace('"events":', '"secret":"raw code","events":'),
      '{"schema_version":"debt-intake-events.v1","events":[]}',
    ];
    for (const body of invalid) await denied(await raw(ctx, body));
    await denied(await raw(ctx, new Uint8Array([0xc3, 0x28])));
    await denied(await send(ctx, Array.from({ length: 257 }, () => ledger()[0])));
    await denied(await raw(ctx, " ".repeat(1024 * 1024 + 1), "harness", { "Content-Length": "1" }), 413, "payload_too_large");
    expect(await counts(ctx)).toEqual([0, 0, 0]);
  });

  it("enforces direct SQL null safety, team foreign keys and summary-only retention", async () => {
    const ctx = await setup(); const summary = ledger("empty-success")[0];
    const insert = (team: string, record: unknown, bytes: string | null = canonical(record)) => getPool().query(
      "insert into codebase_debt_candidate_events(team_id,event_id,record,canonical_record) values($1,$2,$3,$4)",
      [team, summary.event_id, record === null ? null : JSON.stringify(record), bytes]);
    await expect(insert(randomUUID(), summary)).rejects.toMatchObject({ code: "23503" });
    await expect(insert(ctx.teamId, null, null)).rejects.toMatchObject({ code: "23502" });
    for (const field of ["record_type", "producer", "event_id"]) {
      const invalid = { ...summary }; delete invalid[field];
      await expect(insert(ctx.teamId, invalid)).rejects.toThrow();
    }
    await expect(insert(ctx.teamId, { ...summary, record_type: "candidate" })).rejects.toThrow();
    await insert(ctx.teamId, summary);
    expect(await counts(ctx)).toEqual([0, 0, 1]);
    await expect(getPool().query("delete from teams where id=$1", [ctx.teamId])).rejects.toMatchObject({ code: "23503" });
    const { rows } = await getPool().query("select attname,attnotnull from pg_attribute where attrelid='codebase_debt_candidate_events'::regclass and attname=any($1)", [["team_id", "record", "canonical_record", "record_type", "producer_name", "producer_run_id"]]);
    expect(rows).toHaveLength(6); expect(rows.every(row => row.attnotnull)).toBe(true);
  });

  it("protects all three tables from update/delete and forbids cross-team candidate references", async () => {
    const ctx = await setup(); expect((await send(ctx, ledger())).status).toBe(201);
    for (const table of tables) {
      await expect(getPool().query(`update ${table} set team_id=team_id where team_id=$1`, [ctx.teamId])).rejects.toThrow("append-only");
      await expect(getPool().query(`delete from ${table} where team_id=$1`, [ctx.teamId])).rejects.toThrow("append-only");
    }
    const other = await seedTeam();
    await expect(getPool().query("insert into codebase_debt_candidate_codebases(team_id,candidate_id,codebase_slug) values($1,$2,'harness')", [other.teamId, ledger()[0].candidate_id])).rejects.toMatchObject({ code: "23503" });
    expect(await counts(ctx)).toEqual([1, 1, 9]);
  });
});
