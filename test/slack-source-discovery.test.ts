import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import type { DbClient, TransactionSession } from "@/lib/db/types";
// A namespace import ON PURPOSE, beside the named one below: PA-2's validity read is reached by
// member access, so before it exists its tests fail at the call, by name, and nothing else does.
import * as slackBinding from "@/lib/ingest/slack-source-binding";
import {
  classifySlackCall,
  discoverSlackSource,
  needsSlackPublicProof,
  slackWorkspaceUrl,
  validateSlackHistoryPage,
  SLACK_METADATA_INTERVAL_MS,
  type SlackHistoryPageValidation,
} from "@/lib/ingest/slack-source-discovery";
import {
  canonicalSlackChannelIds,
  resolveEnvSlackToken,
  slackConfigRevision,
} from "@/lib/ingest/slack-source-binding";
import type { SlackPage } from "@/lib/ingest/sources/slack-page-request";

/**
 * AIO-1170 — the PURE halves of source discovery: what a history page is allowed to certify, how a
 * transport outcome maps to a source disposition, and how a selection's cache-validity stamps are
 * computed. No database, no provider.
 */

function page(over: Partial<SlackPage> = {}): SlackPage {
  return { messages: [], hasMore: false, nextCursor: null, ...over };
}

function ok(result: SlackHistoryPageValidation): Extract<SlackHistoryPageValidation, { ok: true }> {
  if (!result.ok) throw new Error(`expected a valid page, got ${result.category}`);
  return result;
}

describe("validateSlackHistoryPage", () => {
  it("takes every top-level root in page order, whatever it contains", () => {
    const result = ok(
      validateSlackHistoryPage(
        page({
          messages: [
            { ts: "1718900000.000400", subtype: "tombstone", text: "This message was deleted." },
            { ts: "1718900000.000300" },
            { ts: "1718900000.000200", thread_ts: "1718900000.000200", reply_count: 2 },
            { ts: "1718900000.000150", thread_ts: "1718900000.000100" },
            { ts: "1718900000.000100", text: "hello" },
          ],
        }),
        { sentCursor: null }
      )
    );

    // Structural only: no author, text, subtype or reply-count filter can discard discovery work.
    expect(result.roots).toEqual([
      "1718900000.000400",
      "1718900000.000300",
      "1718900000.000200",
      "1718900000.000100",
    ]);
    // …and the oldest instant on the page, which is what a completed interval is measured to.
    expect(result.oldestTs).toBe("1718900000.000100");
  });

  it("keeps a `ts` byte-exact, never re-rendered from a parsed number", () => {
    const padded = "0001718900000.000100";
    const result = ok(validateSlackHistoryPage(page({ messages: [{ ts: padded }] }), { sentCursor: null }));
    // Zero-padding is the provider's spelling of a thread identity: normalizing it here would mint a
    // path and a queue key for a thread that does not exist.
    expect(result.roots).toEqual([padded]);
  });

  it("accepts a consistent EMPTY page — an empty range is provider data", () => {
    const result = ok(validateSlackHistoryPage(page({ messages: [] }), { sentCursor: null }));
    expect(result.roots).toEqual([]);
    expect(result.oldestTs).toBeNull();
    expect(result.hasMore).toBe(false);
  });

  it("refuses the WHOLE page when any message cannot be placed", () => {
    for (const messages of [
      [{ ts: "1718900000.000100" }, { ts: "not-a-timestamp" }],
      [{ ts: "1718900000.000100" }, { ts: "" }],
      [{ ts: "1718900000.000100" }, {} as { ts: string }],
      [{ ts: "1718900000.000100", thread_ts: "nonsense" }],
    ]) {
      const result = validateSlackHistoryPage(page({ messages }), { sentCursor: null });
      // NOT "the readable half": dropping a message while certifying its interval is how a real
      // root disappears inside a range we later claim to have read completely.
      expect(result).toMatchObject({ ok: false, category: "malformed_timestamp" });
    }
  });

  it("refuses a page whose paging cannot be continued or is looping", () => {
    expect(validateSlackHistoryPage(page({ hasMore: true, nextCursor: null }), { sentCursor: null })).toMatchObject(
      { ok: false, category: "pagination_incomplete" }
    );
    expect(
      validateSlackHistoryPage(page({ hasMore: true, nextCursor: "same" }), { sentCursor: "same" })
    ).toMatchObject({ ok: false, category: "cursor_repeated" });
  });

  it("refuses a page that offers a continuation cursor while saying, or omitting, that there is no more", () => {
    // AIO-1170 review P4-03. The transport reads an absent `has_more` as false, so an absent flag and an explicit
    // `false` both arrive here as `hasMore: false`. Taken as the TERMINAL page, that contradiction certifies the
    // interval and closes the historical lane for good with the rest of the history never read: silent loss.
    // Fail closed instead; the sibling contradiction (`has_more` true with no cursor) is already refused above.
    expect(validateSlackHistoryPage(page({ hasMore: false, nextCursor: "page-2" }), { sentCursor: null })).toMatchObject(
      { ok: false, category: "pagination_incomplete" }
    );
    // The ordinary terminal page (no cursor) is still accepted, so the refusal is not blanket.
    expect(ok(validateSlackHistoryPage(page({ hasMore: false, nextCursor: null }), { sentCursor: "page-2" })).hasMore).toBe(false);
  });

  it("refuses a response that carried no `messages` field at all", () => {
    // `conversations.history` always answers with a messages array. ABSENT is not `[]`: the
    // transport preserves that difference precisely so this reading — "no messages, therefore an
    // empty range I may certify" — is impossible here.
    expect(validateSlackHistoryPage({ hasMore: false, nextCursor: null }, { sentCursor: null })).toMatchObject({
      ok: false,
      category: "malformed_page",
    });
  });
});

describe("classifySlackCall", () => {
  it("maps every transport outcome to a disposition, and invents no retry time", () => {
    expect(classifySlackCall({ outcome: "ok", method: "auth.test", body: { ok: true }, page: page() })).toMatchObject({
      kind: "ok",
    });
    expect(
      classifySlackCall({
        outcome: "deferred",
        method: "auth.test",
        nextPermittedAt: "2026-01-01T00:00:00.000Z",
        retryAfterMs: 1000,
      })
    ).toMatchObject({ kind: "deferred", nextPermittedAt: "2026-01-01T00:00:00.000Z" });
    expect(
      classifySlackCall({
        outcome: "rate_limited",
        method: "auth.test",
        category: "rate_limited",
        nextPermittedAt: "2026-01-01T00:00:00.000Z",
        retryAfterMs: 1000,
      })
    ).toMatchObject({ kind: "transient", category: "rate_limited", nextPermittedAt: "2026-01-01T00:00:00.000Z" });

    // ⚠️ A DURABLE BLOCK IS NOT A LONG COOLDOWN. The bucket's marker is owned by the request layer,
    // is never cleared by a token or config change, and carries no deadline — so this disposition
    // must not acquire one on the way out.
    const blocked = classifySlackCall({
      outcome: "blocked",
      method: "auth.test",
      category: "retry_after_unrepresentable",
    });
    expect(blocked).toEqual({ kind: "blocked", category: "retry_after_unrepresentable" });

    expect(
      classifySlackCall({ outcome: "auth_error", method: "auth.test", category: "missing_scope" })
    ).toMatchObject({ kind: "blocked", category: "missing_scope" });
    expect(
      classifySlackCall({ outcome: "transport_error", method: "auth.test", category: "timeout" })
    ).toMatchObject({ kind: "transient", category: "timeout" });
  });

  it("splits provider errors by what a caller can do about them", () => {
    // Retryable provider faults are transient…
    for (const category of ["ratelimited", "internal_error", "service_unavailable", "request_timeout", "fatal_error"]) {
      expect(classifySlackCall({ outcome: "provider_error", method: "conversations.history", category })).toMatchObject(
        { kind: "transient", category }
      );
    }
    // …everything else is a stated refusal, which a timer cannot fix.
    for (const category of ["channel_not_found", "not_in_channel", "invalid_cursor", "provider_error"]) {
      expect(classifySlackCall({ outcome: "provider_error", method: "conversations.history", category })).toMatchObject(
        { kind: "refused", category }
      );
    }
  });
});

describe("the effective selection", () => {
  it("resolves both env aliases, the canonical spelling first", () => {
    expect(resolveEnvSlackToken({ SLACK_BOT_TOKEN: "a", slack_bot_token: "b" })).toBe("a");
    expect(resolveEnvSlackToken({ slack_bot_token: "b" })).toBe("b");
    expect(resolveEnvSlackToken({})).toBeNull();
    // A blank env var is not a token; treating it as one produces an unauthenticated request.
    expect(resolveEnvSlackToken({ SLACK_BOT_TOKEN: "   " })).toBeNull();
  });

  it("canonicalizes the channel selection and REPORTS what it refuses", () => {
    const { selected, rejected } = canonicalSlackChannelIds({ channelIds: ["C2", "C1", "C2", "bad id", ""] });
    expect(selected).toEqual(["C1", "C2"]);
    // Silently dropping a malformed id would make a channel simply never sync, with nothing to see.
    expect(rejected).toEqual(["bad id", ""]);
  });

  it("changes the revision when the selection or the row changes, and not otherwise", () => {
    const base = {
      updatedAt: "2026-09-09T00:00:00.000Z",
      status: "enabled",
      type: "slack",
      channelIds: ["C1", "C2"],
    };
    const revision = slackConfigRevision(base);
    // Re-ordering is the SAME selection: an invalidation there would re-bootstrap for nothing.
    expect(slackConfigRevision({ ...base, channelIds: ["C2", "C1"] })).toBe(revision);
    expect(slackConfigRevision({ ...base, channelIds: ["C1"] })).not.toBe(revision);
    expect(slackConfigRevision({ ...base, updatedAt: "2026-09-09T00:00:01.000Z" })).not.toBe(revision);
    expect(slackConfigRevision({ ...base, status: "disabled" })).not.toBe(revision);
    expect(revision).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("slackWorkspaceUrl", () => {
  // This is URL INTEGRITY for a stored permalink base — not an SSRF control. Nothing in this slice
  // fetches the stored value; what it must not do is record a link that points somewhere else.
  it("canonicalizes a workspace ROOT under .slack.com", () => {
    // The shape Slack's own auth.test reference documents.
    expect(slackWorkspaceUrl("https://acme.slack.com/")).toBe("https://acme.slack.com/");
    // A missing trailing slash is the same root; an explicit default port is the same origin.
    expect(slackWorkspaceUrl("https://acme.slack.com")).toBe("https://acme.slack.com/");
    expect(slackWorkspaceUrl("https://acme.slack.com:443/")).toBe("https://acme.slack.com/");
    // Host case is not identity; the stored value is the normalized one, never the original bytes.
    expect(slackWorkspaceUrl("https://ACME.slack.com/")).toBe("https://acme.slack.com/");
    expect(slackWorkspaceUrl("https://work-space-1.slack.com/")).toBe("https://work-space-1.slack.com/");
  });

  it("refuses every host that is not exactly one label under .slack.com", () => {
    for (const value of [
      "https://example.invalid/",
      // The suffix trick: `.slack.com` appears, and the registrable domain is somebody else's.
      "https://acme.slack.com.evil.invalid/",
      // A nested label is a deep host, not a workspace root — one label, no more.
      "https://nested.foo.slack.com/",
      "https://slack.com/",
      "https://-acme.slack.com/",
      "https://127.0.0.1/",
      "https://localhost/",
    ]) {
      expect(slackWorkspaceUrl(value)).toBeNull();
    }
  });

  it("refuses credentials, a non-default port, a non-root path, a query or a fragment", () => {
    for (const value of [
      // Credentials in a stored link would be a credential in every log that renders it.
      "https://user:secret@acme.slack.com/",
      "https://user@acme.slack.com/",
      "https://acme.slack.com:8443/",
      "https://acme.slack.com/archives/C0SOURCE1",
      "https://acme.slack.com/?redirect=https://evil.invalid",
      "https://acme.slack.com/?",
      "https://acme.slack.com/#/somewhere",
      "https://acme.slack.com/#",
      "https://acme.slack.com\\",
      " https://acme.slack.com/",
      "http://acme.slack.com/",
      "ftp://acme.slack.com/",
      "acme.slack.com",
      "",
      "   ",
    ]) {
      expect(slackWorkspaceUrl(value)).toBeNull();
    }
    for (const value of [null, undefined, 42, {}, ["https://acme.slack.com/"]]) {
      expect(slackWorkspaceUrl(value)).toBeNull();
    }
  });
});

describe("needsSlackPublicProof", () => {
  const REF = { integrationId: "i-1", configRevision: "r-1" };
  const NOW = Date.parse("2026-09-09T12:00:00.000Z");
  const proof = (over: Partial<Parameters<typeof needsSlackPublicProof>[0]> = {}) => ({
    publicState: "public" as const,
    publicCheckedAt: "2026-09-09T11:59:00.000Z",
    bindingIntegrationId: "i-1",
    bindingConfigRevision: "r-1",
    ...over,
  });

  it("reuses a proof made under this binding, inside the cadence", () => {
    expect(needsSlackPublicProof(proof(), REF, NOW, SLACK_METADATA_INTERVAL_MS)).toBe(false);
  });

  it("re-observes when there is no proof, or none this binding made", () => {
    expect(
      needsSlackPublicProof(
        proof({ publicState: "unknown", publicCheckedAt: null }),
        REF,
        NOW,
        SLACK_METADATA_INTERVAL_MS
      )
    ).toBe(true);
    expect(needsSlackPublicProof(proof({ publicCheckedAt: null }), REF, NOW, SLACK_METADATA_INTERVAL_MS)).toBe(true);
    expect(
      needsSlackPublicProof(proof({ bindingIntegrationId: "i-2" }), REF, NOW, SLACK_METADATA_INTERVAL_MS)
    ).toBe(true);
    expect(
      needsSlackPublicProof(proof({ bindingConfigRevision: "r-2" }), REF, NOW, SLACK_METADATA_INTERVAL_MS)
    ).toBe(true);
    // A definitive refusal is re-observed on the same cadence: a channel can become public again.
    expect(
      needsSlackPublicProof(
        proof({ publicState: "private", publicCheckedAt: "2026-09-09T10:00:00.000Z" }),
        REF,
        NOW,
        SLACK_METADATA_INTERVAL_MS
      )
    ).toBe(true);
  });

  it("takes the cadence from its ARGUMENT — no interval is baked into the decision", () => {
    const aged = proof({ publicCheckedAt: "2026-09-09T11:15:00.000Z" }); // 45 minutes old
    // The default cadence is the existing scheduled observation interval, not an invented TTL…
    expect(SLACK_METADATA_INTERVAL_MS).toBe(30 * 60 * 1000);
    expect(needsSlackPublicProof(aged, REF, NOW, SLACK_METADATA_INTERVAL_MS)).toBe(true);
    // …and a caller that configures a longer one gets a longer one. A constant read straight from
    // the module would make this pair impossible to write, which is the point of the parameter.
    expect(needsSlackPublicProof(aged, REF, NOW, 6 * 60 * 60 * 1000)).toBe(false);
    // The boundary is inclusive: exactly one cadence old is due.
    expect(
      needsSlackPublicProof(
        proof({ publicCheckedAt: new Date(NOW - SLACK_METADATA_INTERVAL_MS).toISOString() }),
        REF,
        NOW,
        SLACK_METADATA_INTERVAL_MS
      )
    ).toBe(true);
  });
});

/**
 * AIO-1170 pre-activation correction PA-3 — the skew allowance is refused BEFORE anything is touched.
 *
 * The allowance is how far below its stored bound a newest catch-up asks. Zero puts the scan back
 * exactly on the bound, and a negative value starts it ABOVE the bound and leaves a gap inside an
 * interval that is later certified — so a bad value must stop the pass, not narrow the seam quietly.
 *
 * Still no database and no provider: the client below is one that cannot be used at all, which is
 * what turns "rejected first" into an observation rather than a reading of the source.
 */
describe("discoverSlackSource — the skew allowance guard", () => {
  const TEAM = "3f1a0b2c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
  const INTEGRATION = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

  class DatabaseReached extends Error {}

  /** A client whose every member — read or merely probed for — is recorded and then throws. */
  function untouchable(): { db: DbClient; touched: string[] } {
    const touched: string[] = [];
    const reach = (property: string | symbol): never => {
      touched.push(String(property));
      throw new DatabaseReached(`the pass reached the database (${String(property)})`);
    };
    const db = new Proxy(
      {},
      { get: (_target, property) => reach(property), has: (_target, property) => reach(property) }
    ) as unknown as DbClient;
    return { db, touched };
  }

  function attempt(skewAllowanceMs: number | undefined) {
    const { db, touched } = untouchable();
    const fetchImpl = vi.fn(async () => {
      throw new Error("no provider request may be made in this test");
    });
    const envToken = vi.fn(() => null);
    const outcome = discoverSlackSource(
      { db, teamId: TEAM, integrationId: INTEGRATION },
      { fetchImpl: fetchImpl as unknown as typeof fetch, envToken, skewAllowanceMs }
    ).then(
      () => ({ rejected: false as const, error: undefined }),
      (error: unknown) => ({ rejected: true as const, error })
    );
    return { outcome, touched, fetchImpl, envToken };
  }

  it.each([0, -1, -60_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses an allowance of %s with a TypeError, before any database or provider activity",
    async (skewAllowanceMs) => {
      const { outcome, touched, fetchImpl, envToken } = attempt(skewAllowanceMs);
      const { rejected, error } = await outcome;

      expect(rejected).toBe(true);
      expect(error).toBeInstanceOf(TypeError);
      // THIS guard, not some other TypeError the unusable client might have provoked.
      expect((error as Error).message).toBe(
        "slack source discovery: skewAllowanceMs must be a positive whole number"
      );
      // Nothing was read off the client, no token was resolved, and nothing left the process.
      expect(touched).toEqual([]);
      expect(envToken).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  /**
   * THE POSITIVE CONTROL. A usable allowance gets PAST the guard and into the pass's first
   * transaction, where this client stops it — so the guard is not refusing everything, and the
   * client really does notice when it is touched. Without this, "touched nothing" above would be
   * satisfied by a harness that cannot see a touch at all.
   */
  it.each([
    { name: "the default, when none is given", skewAllowanceMs: undefined },
    { name: "the smallest whole allowance", skewAllowanceMs: 1 },
    { name: "sixty seconds, stated", skewAllowanceMs: 60_000 },
  ])("lets $name through to the database", async ({ skewAllowanceMs }) => {
    const { outcome, touched, fetchImpl } = attempt(skewAllowanceMs);
    const { rejected, error } = await outcome;

    expect(rejected).toBe(true);
    expect(error).toBeInstanceOf(DatabaseReached);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(touched.length).toBeGreaterThan(0);
    // The provider is reached only through the database, and this pass never got that far.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/**
 * AIO-1170 pre-activation correction PA-2 (AC-PA-06b) — the foreign-binder validity read, on its own.
 *
 * Before a channel bound to ANOTHER integration is chosen for a metadata proof, one question is asked
 * about that integration: is it still a valid binder for this row? It is asked about somebody else's
 * integration, so it must not do what a pass does for its OWN — no row lock (it would serialize the
 * two integrations), no secret and no token fingerprint (it is not this pass's credential), no
 * environment token, no decryption, no revision. A recording session isolates that read from a pass's
 * legitimate reads of its own selection, which is why it is called directly here.
 *
 * What only real rows can show — that each of the four stored facts decides the answer, and that
 * another team's otherwise-valid integration is refused — is in the real-Postgres bootstrap suite.
 */
describe("isSlackBinderValid — the foreign-binder validity read (AC-PA-06b)", () => {
  const SCOPE = {
    teamId: "3f1a0b2c-4d5e-4f60-8a7b-9c0d1e2f3a4b",
    integrationId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    workspaceId: "T0UNIT001",
    channelId: "C0UNIT001",
  };
  type Validity = (session: TransactionSession, scope: typeof SCOPE) => Promise<boolean>;
  const validity = (): Validity => (slackBinding as unknown as { isSlackBinderValid: Validity }).isSlackBinderValid;

  /** A session that records every statement and answers each with the same result (or failure). */
  function recordingSession(answer: () => { rows: unknown[]; rowCount: number }): {
    session: TransactionSession;
    statements: { sql: string; params: unknown[] }[];
  } {
    const statements: { sql: string; params: unknown[] }[] = [];
    const session = {
      db: new Proxy(
        {},
        {
          get() {
            throw new Error("the validity read is one raw statement; it must not reach for the query builder");
          },
        }
      ),
      executeSql: async (sql: string, params?: unknown[]) => {
        statements.push({ sql, params: params ?? [] });
        return answer();
      },
      optionalAudit: async <T>(operation: () => Promise<T>) => operation(),
    } as unknown as TransactionSession;
    return { session, statements };
  }
  const noRow = () => ({ rows: [], rowCount: 0 });

  it("is exported by the binding module", () => {
    expect(typeof validity()).toBe("function");
  });

  it("is scoped to the team and the recorded binder, Slack-typed, joined on both key columns, with no lock and no secret", async () => {
    const { session, statements } = recordingSession(noRow);

    await validity()(session, SCOPE);

    expect(statements.length).toBeGreaterThan(0);
    for (const { sql } of statements) {
      expect(sql).not.toMatch(/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i);
      expect(sql).not.toMatch(/secret_ciphertext|token_fingerprint/i);
    }
    const read = statements.find(({ sql }) => /slack_integration_bindings/i.test(sql));
    expect(read, "the read joins the binder's binding").toBeDefined();
    // Never an unscoped lookup by id: a cross-team binder id must simply match nothing.
    expect(read?.params).toEqual(expect.arrayContaining([SCOPE.teamId, SCOPE.integrationId]));
    // The type is part of the question, so a non-Slack integration id matches nothing either.
    expect(read?.sql).toMatch(/type\s*=\s*'slack'/i);
    const on = /join\s+slack_integration_bindings[\s\S]*?\bon\b([\s\S]*?)\bwhere\b/i.exec(read?.sql ?? "")?.[1] ?? "";
    expect(on).toMatch(/team_id/i);
    expect(on).toMatch(/integration_id/i);
  });

  it("treats a scoped lookup that matches NO row as invalid — a missing binding is never a valid binder", async () => {
    // One answer for four different absences: no integration, no binding row, another team's
    // integration, an integration that is not Slack. None of them is told apart by a second lookup.
    const { session, statements } = recordingSession(noRow);
    expect(await validity()(session, SCOPE)).toBe(false);
    expect(statements).toHaveLength(1);
  });

  it("propagates a SQL failure instead of answering: an unreadable binder is not an invalid one", async () => {
    const failure = new Error("connection terminated unexpectedly");
    const { session } = recordingSession(() => {
      throw failure;
    });
    // `false` here would hand the channel to whoever asked while the database was down.
    await expect(validity()(session, SCOPE)).rejects.toBe(failure);
  });

  /**
   * The text of one EXPORTED top-level function of a module, found by PARSING it — so the answer does
   * not depend on how the declaration happens to be spelled or laid out. A function declaration, an
   * arrow or function expression bound to a `const`, an inline `export` or a later `export { name }`
   * all count; a function that is not exported at all does not.
   */
  function exportedFunctionText(sourceFile: ts.SourceFile, name: string): string | undefined {
    const hasExport = (node: ts.Node): boolean =>
      ts.canHaveModifiers(node) &&
      (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    let declaration: ts.Node | undefined;
    let exported = false;
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body) {
        declaration = statement;
        exported ||= hasExport(statement);
      } else if (ts.isVariableStatement(statement)) {
        for (const variable of statement.declarationList.declarations) {
          const bound = variable.initializer;
          if (ts.isIdentifier(variable.name) && variable.name.text === name && bound &&
              (ts.isArrowFunction(bound) || ts.isFunctionExpression(bound))) {
            declaration = statement;
            exported ||= hasExport(statement);
          }
        }
      } else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier &&
                 statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        exported ||= statement.exportClause.elements.some((element) => (element.propertyName ?? element.name).text === name);
      }
    }
    return declaration && exported ? declaration.getText(sourceFile) : undefined;
  }

  it("resolves no token, decrypts nothing and computes no revision (read from its parsed source)", () => {
    const path = join(import.meta.dirname, "..", "lib", "ingest", "slack-source-binding.ts");
    const sourceFile = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const forbidden = [
      "decryptSecret",
      "resolveEnvSlackToken",
      "slackTokenFingerprint",
      "slackConfigRevision",
      "lockSlackSelection",
      "process.env",
      "envToken",
    ];

    const helper = exportedFunctionText(sourceFile, "isSlackBinderValid");
    expect(helper, "isSlackBinderValid is an exported function of slack-source-binding.ts").toBeDefined();
    for (const term of forbidden) expect(helper, `the validity read must not use ${term}`).not.toContain(term);

    // THE CONTROL: the same extraction, pointed at the pass's read of its OWN row, finds exactly the
    // things that must be absent above — so "absent" is not the extractor failing to see a body.
    const own = exportedFunctionText(sourceFile, "lockSlackSelection") ?? "";
    expect(own).toContain("decryptSecret");
    expect(own).toContain("slackConfigRevision");
    expect(own).toContain("slackTokenFingerprint");
    expect(own).toMatch(/for\s+update/i);
    // …and it finds NOTHING for a name the module does not export, rather than guessing a span.
    expect(exportedFunctionText(sourceFile, "assertUuid")).toBeUndefined();
    expect(exportedFunctionText(sourceFile, "noSuchFunction")).toBeUndefined();
  });

  it("finds the helper however its export is spelled (the extractor's own control)", () => {
    const text = (source: string) =>
      exportedFunctionText(ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true), "isSlackBinderValid");
    for (const source of [
      "export async function isSlackBinderValid(session, scope) {\n  return probe(session, scope);\n}\n",
      "export   async  function isSlackBinderValid(\n  session,\n  scope\n)\n{ return probe(session, scope); }",
      "export const isSlackBinderValid = async (session, scope) => {\n  return probe(session, scope);\n};\n",
      "async function isSlackBinderValid(session, scope) { return probe(session, scope); }\nexport { isSlackBinderValid };\n",
    ]) {
      expect(text(source), source).toContain("probe(session, scope)");
    }
    // Declared but NOT exported is not the helper the pass can call.
    expect(text("async function isSlackBinderValid(session, scope) { return probe(session, scope); }\n")).toBeUndefined();
  });
});
