import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { BASE_URL, db, issueKeyFor, keyHeaders, seedTeam, type Seed } from "./http-helpers";
import { HTTP_TEST_PORT } from "./server-url";
import { fullMetrics } from "../fixtures/codebase-scan";

/**
 * AUDITFIX-17 / AIO-1136 — AC17-02, AC17-05, AC17-06, AC17-07 for POST /api/v1/codebases,
 * over a REAL socket against `next start` + the isolated test Postgres.
 *
 * Spec: docs/design/auditfix17-request-bounds.md. This is the only tier that can prove the two
 * things this change is actually about:
 *
 *   1. The BYTE bound is a transport property. The schema never sees the wire, and the route's
 *      current gate reads `Content-Length` — which a chunked request simply does not send. An
 *      in-process test that hands a route handler a `Request` built from a string cannot
 *      reproduce that, because it has a length. Only a real Node client that writes chunks
 *      without declaring a length does.
 *   2. "No writes on rejection" is a claim about persisted state. A spy proves the ingest
 *      function was not CALLED; only real rows prove nothing was written. Both matter, and this
 *      file owns the second.
 *
 * RED AT BASELINE (0006d51f), for the intended reasons:
 *   - a chunked 2,400,001-byte body has no `Content-Length`, so `parseInt(null || "0")` is 0,
 *     the gate does not fire, `req.json()` parses the whole thing and the scan is INGESTED;
 *   - `metrics.recent_commits` has no cardinality bound, so 101 commits are accepted and each
 *     one is projected through `ingestItem`;
 *   - the declared-length rejection answers `413 "max 2 MB"`, which names neither the real
 *     2,400,000-byte ceiling nor any recovery.
 *
 * NOT PROVEN HERE, deliberately: AC17-03 (the reader stops early, retains no crossing chunk and
 * releases the lock) and AC17-04 (multibyte round-trip, decoder semantics). Those are properties
 * of the bounded reader, observable only by driving a stream directly, and their tests land with
 * the reader. A real socket cannot see whether the application read one chunk or all of them.
 */

const CODEBASES_URL = `${BASE_URL}/api/v1/codebases`;
const MAX_BODY_BYTES = 2_400_000;

// Verbatim from the canonical supplement (aios-workspace docs/contract/, vendored at
// test/fixtures/contract/codebase-request-limits-v1.json). Spelled out here so this file states
// the wire contract it is asserting; test/guards/codebase-request-limits-contract.test.ts is
// what proves these strings still match the shared artifact.
const BYTES_MESSAGE =
  "body: at most 2400000 bytes per scan; reduce the scan payload and retry; do not split a snapshot across pushes";
const COUNT_MESSAGE =
  "metrics.recent_commits: at most 100 entries per scan; send a complete scan with a smaller recent-commit window; do not split a snapshot across pushes";

let slugCounter = 0;
const uniqueSlug = (label: string) => `af17-${label}-${Date.now().toString(36)}-${slugCounter++}`;

/** `n` distinct, schema-valid commits with unique SHAs (so none dedups away). */
function commits(n: number, saltHex = "0"): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    sha: `${saltHex}${i.toString(16)}`.padStart(40, "f"),
    author: "Jo Committer <jo@example.com>",
    author_email: "jo@example.com",
    message: `bounded scan commit ${i}`,
    committed_at: "2026-09-01T10:00:00Z",
    ai: false,
    additions: 2,
    deletions: 1,
  }));
}

function scanPayload(slug: string, headSha: string, recent_commits: unknown[]) {
  return {
    codebase: { slug, full_name: `acme/${slug}`, provider: "github" },
    metrics: fullMetrics({ head_sha: headSha, recent_commits }),
  };
}

/**
 * Serialize `payload` to EXACTLY `targetBytes` of valid JSON by padding with insignificant
 * whitespace immediately after the opening brace. ASCII-only, so byte length == string length,
 * and the padding is part of the body the transport carries — which is the thing being bounded.
 */
function jsonOfExactBytes(payload: unknown, targetBytes: number): string {
  const base = JSON.stringify(payload);
  const padding = targetBytes - Buffer.byteLength(base, "utf8");
  if (padding < 0) {
    throw new Error(`payload is already ${Buffer.byteLength(base, "utf8")} B > ${targetBytes} B`);
  }
  const body = `{${" ".repeat(padding)}${base.slice(1)}`;
  if (Buffer.byteLength(body, "utf8") !== targetBytes) {
    throw new Error(`padding failed: ${Buffer.byteLength(body, "utf8")} != ${targetBytes}`);
  }
  return body;
}

interface RawResponse {
  status: number;
  body: string;
  json: () => unknown;
}

/**
 * POST over a raw Node client so the test controls framing. `fetch` always computes and sends a
 * `Content-Length` for a string body, which is precisely the header this route currently trusts,
 * so the chunked case is unreachable through it.
 *
 * `chunked: true` omits Content-Length entirely (Node then uses `Transfer-Encoding: chunked`).
 * `declaredLength` sends a Content-Length that need not match what is written — that is how the
 * "a high declaration rejects without consuming the body" case is expressed.
 * `end: false` leaves the request unfinished, so a response can only arrive if the server
 * answered WITHOUT the full body.
 */
function postRaw(options: {
  headers: Record<string, string>;
  chunks: string[];
  declaredLength?: number;
  end?: boolean;
  timeoutMs?: number;
}): Promise<RawResponse> {
  const { headers, chunks, declaredLength, end = true, timeoutMs = 30_000 } = options;
  return new Promise<RawResponse>((resolve, reject) => {
    const outgoing: Record<string, string> = { ...headers };
    if (declaredLength !== undefined) outgoing["Content-Length"] = String(declaredLength);

    // A bounded wait that FAILS rather than passing quietly: an absent response is the exact
    // outcome these cases are trying to rule out, so it must never be mistaken for success.
    // `timer` is assigned below and read only from callbacks (response end, request error, the
    // timeout itself), every one of which runs after this synchronous body has finished — so it
    // can never be observed unset.
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(HTTP_TEST_PORT),
        path: "/api/v1/codebases",
        method: "POST",
        headers: outgoing,
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (chunk: Buffer) => parts.push(chunk));
        res.on("end", () => {
          clearTimeout(timer);
          req.destroy();
          const body = Buffer.concat(parts).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            body,
            json: () => JSON.parse(body),
          });
        });
      }
    );

    const timer = setTimeout(() => {
      req.destroy();
      reject(
        new Error(
          `no response within ${timeoutMs}ms (declaredLength=${declaredLength ?? "none"}, ` +
            `end=${end}, bytesWritten=${chunks.reduce((n, c) => n + Buffer.byteLength(c), 0)})`
        )
      );
    }, timeoutMs);

    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    for (const part of chunks) req.write(part);
    if (end) req.end();
  });
}

/** Split a body into `parts` chunks so the oversized cases genuinely stream. */
function chunk(body: string, parts: number): string[] {
  const size = Math.ceil(body.length / parts);
  const out: string[] = [];
  for (let i = 0; i < body.length; i += size) out.push(body.slice(i, i + size));
  return out;
}

/**
 * Every scan-domain table the route's ingest owner can touch, scoped to ONE seeded team, in a
 * stable order. Deliberately NOT a whole-database snapshot: authentication updates
 * `api_keys.last_used_at` and the rate limiter writes its bucket on EVERY request including a
 * rejected one, and those are explicitly allowed by the spec. What must not move is scan state.
 *
 * Every row is read WHOLE (`*`), never as a column list. "No writes on rejection" is a claim
 * about the row, and a projection can only ever prove that the columns someone thought to name
 * did not move: a rejected request that rewrote a body, a frontmatter, a score, or any of the
 * timestamps outside the list would still compare equal. The scope is one freshly seeded team,
 * so the whole row costs nothing and is the only honest subject for "nothing moved at all".
 */
async function scanInventory(teamId: string) {
  const admin = db();
  const rows = async (table: string) => {
    const { data, error } = await admin
      .from(table)
      .select("*")
      .eq("team_id", teamId)
      .order("id", { ascending: true });
    if (error) throw new Error(`inventory ${table} failed: ${error.message}`);
    return (data ?? []) as Record<string, unknown>[];
  };

  const items = await rows("items");
  const itemIds = items.map((row) => row.id as string);
  // Scoped by item rather than by team: item_versions has no team_id of its own.
  const { data: versions, error: versionError } = itemIds.length
    ? await admin
        .from("item_versions")
        .select("*")
        .in("item_id", itemIds)
        .order("id", { ascending: true })
    : { data: [], error: null };
  if (versionError) throw new Error(`inventory item_versions failed: ${versionError.message}`);

  const { data: auditRows, error: auditError } = await admin
    .from("audit_log")
    .select("*")
    .eq("team_id", teamId)
    .order("id", { ascending: true });
  if (auditError) throw new Error(`inventory audit_log failed: ${auditError.message}`);
  // Scan-domain audit only. Scoped by ACTION rather than by target id, because a rejected
  // request that wrongly ingested would create target ids that did not exist before — an
  // id-scoped comparison could not see them.
  const scanAudit = (auditRows ?? []).filter((row) => {
    const action = String((row as { action: string }).action);
    return action === "codebase.scanned" || action.startsWith("item");
  });

  return {
    codebases: await rows("codebases"),
    code_metrics: await rows("code_metrics"),
    code_contributions: await rows("code_contributions"),
    github_issues: await rows("github_issues"),
    codebase_findings: await rows("codebase_findings"),
    codebase_finding_events: await rows("codebase_finding_events"),
    items,
    item_versions: (versions ?? []) as Record<string, unknown>[],
    projects: await rows("projects"),
    project_context_units: await rows("project_context_units"),
    project_context_memberships: await rows("project_context_memberships"),
    scan_ingest_runs: (await rows("ingest_runs")).filter((row) => row.source === "scan"),
    scan_audit: scanAudit,
  };
}

async function seedTeamWithKey(): Promise<{ seed: Seed; key: string }> {
  const seed = await seedTeam();
  const { key } = await issueKeyFor(seed, "team");
  return { seed, key };
}

describe("POST /api/v1/codebases — request bounds (HTTP)", () => {
  // ——— AC17-02 / AC17-06: the byte bound is measured, not declared ———

  it("admits a chunked body of exactly 2,400,000 bytes (the inclusive ceiling)", async () => {
    const { seed, key } = await seedTeamWithKey();
    const slug = uniqueSlug("at-limit");
    const body = jsonOfExactBytes(scanPayload(slug, "a".repeat(40), commits(5)), MAX_BODY_BYTES);

    const res = await postRaw({ headers: keyHeaders(key, seed.teamSlug), chunks: chunk(body, 24) });

    expect(res.status).toBe(201);
    expect((res.json() as { status: string }).status).toBe("ok");
    // Non-vacuity: the accepted control proves the DB assertions in the rejection cases are
    // reading a table that this route really does write.
    const after = await scanInventory(seed.teamId);
    expect(after.codebases.map((row) => row.slug)).toContain(slug);
  });

  it("rejects a chunked body of 2,400,001 bytes with the named 413, writing no scan state", async () => {
    const { seed, key } = await seedTeamWithKey();
    const slug = uniqueSlug("over-limit");
    const before = await scanInventory(seed.teamId);
    const body = jsonOfExactBytes(
      scanPayload(slug, "b".repeat(40), commits(5)),
      MAX_BODY_BYTES + 1
    );

    // No Content-Length: the header the current gate reads is simply absent, which is the whole
    // point — a bound that trusts a declaration is not a bound.
    const res = await postRaw({ headers: keyHeaders(key, seed.teamSlug), chunks: chunk(body, 24) });

    expect(res.status).toBe(413);
    const error = (res.json() as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("payload_too_large");
    expect(error.message).toBe(BYTES_MESSAGE);

    expect(await scanInventory(seed.teamId)).toEqual(before);
  });

  it("rejects a Content-Length above the ceiling before consuming the body", async () => {
    const { seed, key } = await seedTeamWithKey();
    const before = await scanInventory(seed.teamId);

    // Declare more than the ceiling, write a token byte, and never finish the request. A
    // response can therefore only arrive if the route rejected on the declaration alone — the
    // "it is only an optimization" half of the spec's rule.
    const res = await postRaw({
      headers: keyHeaders(key, seed.teamSlug),
      chunks: ["{"],
      declaredLength: MAX_BODY_BYTES + 1,
      end: false,
      timeoutMs: 20_000,
    });

    expect(res.status).toBe(413);
    const error = (res.json() as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("payload_too_large");
    expect(error.message).toBe(BYTES_MESSAGE);
    expect(await scanInventory(seed.teamId)).toEqual(before);
  }, 30_000);

  it("the declared-length and measured paths return the SAME 413 contract", async () => {
    const { seed, key } = await seedTeamWithKey();
    const slug = uniqueSlug("declared-over");
    const before = await scanInventory(seed.teamId);
    const body = jsonOfExactBytes(
      scanPayload(slug, "c".repeat(40), commits(5)),
      MAX_BODY_BYTES + 1
    );

    // The same oversized body, this time WITH an accurate Content-Length, so the early
    // declaration check is what fires. Two code paths reject this request depending on how the
    // client framed it; a caller must not be able to tell them apart from the response, or the
    // "optimization" would be a second, undocumented contract.
    //
    // Deliberately NOT a spoofed low declaration: understating Content-Length changes HTTP
    // framing itself, so a real socket cannot express "the header lies" without the transport
    // truncating the body first. That case belongs to unit tests over a constructed Request.
    const res = await postRaw({
      headers: keyHeaders(key, seed.teamSlug),
      chunks: chunk(body, 24),
      declaredLength: Buffer.byteLength(body, "utf8"),
    });
    expect(res.status).toBe(413);
    expect((res.json() as { error: { message: string } }).error.message).toBe(BYTES_MESSAGE);
    expect(await scanInventory(seed.teamId)).toEqual(before);
  });

  // ——— AC17-06: the count bound over the wire ———

  it("rejects 101 valid commits with the named 422, writing no scan state", async () => {
    const { seed, key } = await seedTeamWithKey();
    const slug = uniqueSlug("over-count");
    const before = await scanInventory(seed.teamId);

    const res = await fetch(CODEBASES_URL, {
      method: "POST",
      headers: keyHeaders(key, seed.teamSlug),
      body: JSON.stringify(scanPayload(slug, "d".repeat(40), commits(101, "1"))),
    });

    expect(res.status).toBe(422);
    const error = (await res.json()).error as { code: string; message: string };
    expect(error.code).toBe("invalid_payload");
    expect(error.message).toBe(COUNT_MESSAGE);

    const after = await scanInventory(seed.teamId);
    expect(after).toEqual(before);
    // Named explicitly, because these are the two rows whose ABSENCE is the product claim:
    // the rejected scan never became a codebase, and left no run to read in the runs log.
    expect(after.codebases.map((row) => row.slug)).not.toContain(slug);
    expect(after.scan_ingest_runs).toHaveLength(0);
  });

  // ——— AC17-05: existing outcomes keep their precedence ———

  it("401 for a bad key and 403 for an external-tier key, both above the body bound", async () => {
    const { seed } = await seedTeamWithKey();
    const oversized = jsonOfExactBytes(
      scanPayload(uniqueSlug("precedence"), "e".repeat(40), commits(101, "2")),
      MAX_BODY_BYTES + 1
    );
    const before = await scanInventory(seed.teamId);

    const unauthorized = await postRaw({
      headers: {
        Authorization: "Bearer aios_not_a_real_key",
        "X-AIOS-Team": seed.teamSlug,
        "Content-Type": "application/json",
      },
      chunks: chunk(oversized, 12),
    });
    expect(unauthorized.status).toBe(401);

    const { key: externalKey } = await issueKeyFor(seed, "external");
    const forbidden = await postRaw({
      headers: keyHeaders(externalKey, seed.teamSlug),
      chunks: chunk(oversized, 12),
    });
    expect(forbidden.status).toBe(403);
    expect((forbidden.json() as { error: { code: string } }).error.code).toBe("forbidden_tier");

    // Neither auth failure is allowed to become a body-bound failure: an oversized request from
    // a principal who may not post here must still say "you may not post here".
    expect(await scanInventory(seed.teamId)).toEqual(before);
  });

  // ——— AC17-07: recovery, and what survives a rejected replacement ———

  it("a rejected replacement leaves the accepted snapshot intact, and a corrected scan persists all 100 commits", async () => {
    const { seed, key } = await seedTeamWithKey();
    const slug = uniqueSlug("recovery");
    const headSha = "1".repeat(40);
    const headShaCorrected = "2".repeat(40);
    const headers = keyHeaders(key, seed.teamSlug);

    // 1. an ordinary accepted scan establishes real state to protect.
    const seeded = await fetch(CODEBASES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(scanPayload(slug, headSha, commits(3, "3"))),
    });
    expect(seeded.status).toBe(201);
    const accepted = await scanInventory(seed.teamId);
    expect(accepted.code_metrics).toHaveLength(1);

    // 2. an over-count replacement of THE SAME (codebase, head_sha) — the case that would
    //    otherwise replace the metrics row, because the upsert key is unchanged.
    const rejected = await fetch(CODEBASES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(scanPayload(slug, headSha, commits(101, "4"))),
    });
    expect(rejected.status).toBe(422);
    expect(((await rejected.json()).error as { message: string }).message).toBe(COUNT_MESSAGE);

    // 3. exact row equality: not "still has 3 commits", but "nothing moved at all".
    expect(await scanInventory(seed.teamId)).toEqual(accepted);

    // 4. neither rejection is transient, and the recovery is ONE complete smaller scan — never
    //    two partial pushes, which the (codebase_id, head_sha) upsert would silently collapse.
    // ONE array, built once, submitted and then compared against — so the assertions below are
    // about the commits this request actually carried, not about a second call that merely
    // happens to be built the same way.
    const correctedCommits = commits(100, "5");
    const corrected = await fetch(CODEBASES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(scanPayload(slug, headShaCorrected, correctedCommits)),
    });
    expect(corrected.status).toBe(201);

    const after = await scanInventory(seed.teamId);
    const correctedPoint = after.code_metrics.find((row) => row.head_sha === headShaCorrected);
    expect(correctedPoint, "the corrected scan wrote no metrics point").toBeDefined();
    // Deep equality, not a length: a count of 100 is equally satisfied by 100 truncated,
    // reordered or substituted commits, and "one complete smaller scan" is a claim about the
    // CONTENT surviving the round-trip. The ingest owner persists the parsed array verbatim, so
    // the stored snapshot must be exactly what was sent, in order.
    expect(correctedPoint!.recent_commits).toEqual(correctedCommits);

    // Every commit reached `items` at its own path — a partial success would show here as a
    // short count, and the 100-element ceiling is worthless if it silently drops work.
    const expectedPaths = correctedCommits.map((c) => `commits/${slug}/${c.sha as string}.md`);
    const actualPaths = after.items.map((row) => row.path as string);
    for (const path of expectedPaths) expect(actualPaths).toContain(path);

    // The first scan's point survived the whole sequence: this is a new point, not a rewrite.
    expect(after.code_metrics.map((row) => row.head_sha).sort()).toEqual(
      [headSha, headShaCorrected].sort()
    );
  }, 60_000);
});
