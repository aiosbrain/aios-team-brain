import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * AIO-1170 Slack repair census — the PURE half (`lib/ingest/slack-repair-census.ts`).
 *
 * The census is a bounded, inactive, dry-run diagnostic: it classifies STORED Slack facts for one
 * explicit `{teamId, integrationId, channelId}` and its strongest conclusion is "observed at this
 * database snapshot". These tests pin the classifier's decision table and every place where a
 * plausible shortcut would turn an observation into a claim: a current binding standing in for
 * legacy provenance, a path being "repaired", a participant list filling in for a ledger, a pair of
 * endpoints becoming a range of days, a null lock owner becoming a story about who cleared it.
 *
 * The module is loaded per test through a non-literal specifier, deliberately. A static import of a
 * file that does not exist yet fails the whole file at link time, which would hide whether these
 * fixtures are themselves well-formed; this way every case fails on its own, by name.
 */

const REPO = join(import.meta.dirname, "..");
const PURE_FILE = "lib/ingest/slack-repair-census.ts";
const READER_FILE = "lib/ingest/slack-repair-census-read.ts";

type Json = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the module under test does not exist yet
type CensusModule = Record<string, any>;

async function census(): Promise<CensusModule> {
  const file = join(REPO, PURE_FILE);
  return (await import(/* @vite-ignore */ file)) as CensusModule;
}

const TEAM = "11111111-1111-4111-8111-111111111111";
const OTHER_TEAM = "99999999-9999-4999-8999-999999999999";
const INTEGRATION = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const OTHER_PROJECT = "44444444-4444-4444-8444-444444444444";
const ITEM = "55555555-5555-4555-8555-555555555555";
const MEMBER = "66666666-6666-4666-8666-666666666666";
const CHANNEL = "C0ABC";
const WORKSPACE = "T1";
const ROOT = "1718900000.000100";
const REVISION = "c".repeat(64);
const FINGERPRINT = "f".repeat(64);
const SCOPE = { teamId: TEAM, integrationId: INTEGRATION, channelId: CHANNEL };

const RELATIONSHIPS = ["channel_candidate", "scoped_channel_match", "unresolved_channel", "conflicting_evidence"];
const PENDING = [
  "source_refetch_required",
  "provenance_review_required",
  "mapping_review_required",
  "pending_queue_work",
  "lock_exception",
];
const AUTHOR_STATUSES = [
  "resolved", "invalid_input", "no_mapping", "conflicting_mapping", "incomplete_provenance",
  "conflicting_provenance", "ambiguous_workspaces", "unknown_account", "unmapped_account",
  "mismatched_member", "unresolved_legacy_evidence", "nonhuman_member", "mapping_candidates_overflow",
];

function itemId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function base64url(value: unknown): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64url");
}

/** The cursor's wire form, pinned here so the strict-schema negatives below are real encodings. */
function cursorWire(over: Json = {}): Json {
  return {
    v: 1,
    teamId: TEAM,
    integrationId: INTEGRATION,
    channelId: CHANNEL,
    scopeFingerprint: FINGERPRINT,
    lastItemId: ITEM,
    ...over,
  };
}

async function rejection(run: () => unknown): Promise<Json> {
  try {
    await run();
  } catch (error) {
    return error as Json;
  }
  throw new Error("expected a rejection, but the call returned");
}

function scopeRow(over: Json = {}): Json {
  return {
    integrationType: "slack",
    integrationStatus: "enabled",
    updatedAtUtcMicroseconds: "2026-10-05T12:34:56.123456Z",
    configChannelIds: [CHANNEL, "C0ZED"],
    bindingState: "verified",
    bindingWorkspaceId: WORKSPACE,
    bindingConfigRevision: REVISION,
    ...over,
  };
}

function tupleFingerprint(row: Json, selected: string[], scope = SCOPE): string {
  const tuple = [
    "v1", scope.teamId, scope.integrationId, scope.channelId, row.integrationStatus,
    row.updatedAtUtcMicroseconds, selected, row.bindingState, row.bindingWorkspaceId,
    row.bindingConfigRevision,
  ];
  return createHash("sha256").update(JSON.stringify(tuple), "utf8").digest("hex");
}

/** Stored facts for ONE scanned item. Defaults describe a bare legacy channel-id path, nothing else known. */
function facts(over: Json & { item?: Json } = {}): Json {
  const { item, ...rest } = over;
  return {
    scope: SCOPE,
    bindingWorkspaceId: WORKSPACE,
    item: {
      id: ITEM,
      projectId: PROJECT,
      path: `slack/c0abc/${ROOT}.md`,
      frontmatter: { source: "slack" },
      memberId: null,
      memberIdLocked: false,
      ...item,
    },
    ledgerSources: [],
    authorStatuses: [],
    targetPathItems: [],
    otherProjectSameThreadItemIds: [],
    sameProjectConvergingItemIds: [],
    queue: null,
    ...rest,
  };
}

function ledgerSource(over: Json = {}): Json {
  return {
    workspaceId: WORKSPACE,
    channelId: CHANNEL,
    totalMessages: "1",
    eligibleNondeletedMessages: "1",
    excludedMessages: "0",
    deletedMessages: "0",
    eligibleNondeletedUtcDays: "1",
    ...over,
  };
}

async function classify(over: Json & { item?: Json } = {}): Promise<Json> {
  const { classifySlackRepairItem } = await census();
  return classifySlackRepairItem(facts(over)) as Json;
}

async function entryOf(over: Json & { item?: Json } = {}): Promise<Json> {
  const result = await classify(over);
  expect(result.bucket).toBe("entry");
  return result.entry as Json;
}

describe("slack repair census: request, mode and page size", () => {
  it("treats an omitted mode as dry_run, defaults the page to 25 and canonicalizes the scope", async () => {
    const { validateSlackRepairCensusRequest, SLACK_REPAIR_CENSUS_LIMITS } = await census();
    expect(SLACK_REPAIR_CENSUS_LIMITS).toMatchObject({
      defaultPageSize: 25, maxPageSize: 50, peerIdCap: 50, observationCap: 50,
      mappingCandidateCap: 50, statementTimeoutMs: 5000,
    });
    expect(validateSlackRepairCensusRequest({ scope: SCOPE })).toEqual({
      scope: SCOPE, mode: "dry_run", pageSize: 25, cursor: null,
    });
    expect(validateSlackRepairCensusRequest({ scope: SCOPE, mode: "dry_run", pageSize: 50 })).toMatchObject({
      mode: "dry_run", pageSize: 50,
    });
    // UUIDs are canonical lower case; a provider id keeps its bytes — `c0abc` is a different scope.
    expect(
      validateSlackRepairCensusRequest({
        scope: { teamId: TEAM.toUpperCase().replace(/1/g, "A"), integrationId: INTEGRATION, channelId: "c0AbC" },
      }).scope
    ).toEqual({ teamId: TEAM.replace(/1/g, "a"), integrationId: INTEGRATION, channelId: "c0AbC" });
  });

  it.each([["apply"], ["DRY_RUN"], ["dry-run"], [""], [null], [true], [1]])(
    "rejects mode %j — there is no apply, and an unknown mode is not dry_run",
    async (mode) => {
      const { validateSlackRepairCensusRequest } = await census();
      const error = await rejection(() => validateSlackRepairCensusRequest({ scope: SCOPE, mode }));
      expect(error).toMatchObject({ name: "SlackRepairCensusInputError", category: "invalid_mode" });
    }
  );

  it.each([[0], [51], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], ["10"], [null]])(
    "rejects pageSize %j",
    async (pageSize) => {
      const { validateSlackRepairCensusRequest } = await census();
      const error = await rejection(() => validateSlackRepairCensusRequest({ scope: SCOPE, pageSize }));
      expect(error).toMatchObject({ category: "invalid_page_size" });
    }
  );

  it("rejects malformed scopes and caller-asserted facts, without echoing what it refused", async () => {
    const { validateSlackRepairCensusRequest, SlackRepairCensusInputError } = await census();
    const hostile = "xoxb-SECRET-LOOKING'); drop table items;--";
    const scopes: Json[] = [
      { ...SCOPE, teamId: hostile },
      { ...SCOPE, teamId: "not-a-uuid" },
      { ...SCOPE, integrationId: `${INTEGRATION}0` },
      { ...SCOPE, channelId: hostile },
      { ...SCOPE, channelId: "C0 ABC" },
      { ...SCOPE, channelId: "c0-abc" },
      { ...SCOPE, channelId: "" },
      { ...SCOPE, channelId: 7 },
      // The census takes no provenance from its caller: a workspace or a verdict is not an input.
      { ...SCOPE, workspaceId: WORKSPACE },
      { ...SCOPE, verified: true },
    ];
    for (const scope of scopes) {
      const error = await rejection(() => validateSlackRepairCensusRequest({ scope }));
      expect(error).toBeInstanceOf(SlackRepairCensusInputError);
      expect(error).toMatchObject({ category: "invalid_scope" });
      expect(String(error.message)).not.toContain(hostile);
      expect(String(error.message)).not.toContain("drop table");
    }
    for (const request of [null, undefined, "scope", [], {}, { scope: null }]) {
      expect((await rejection(() => validateSlackRepairCensusRequest(request))).category).toMatch(
        /^invalid_(request|scope)$/
      );
    }
    for (const extra of [{ verified: true }, { totals: { scannedItems: 0 } }, { workspaceId: WORKSPACE }, { apply: true }]) {
      const error = await rejection(() => validateSlackRepairCensusRequest({ scope: SCOPE, ...extra }));
      expect(error).toMatchObject({ category: "invalid_request" });
    }
  });
});

describe("slack repair census: cursor v1", () => {
  it("round-trips the exact scope, fingerprint and last scanned item", async () => {
    const { validateSlackRepairCensusRequest, encodeSlackRepairCursor } = await census();
    const cursor = encodeSlackRepairCursor({ scope: SCOPE, scopeFingerprint: FINGERPRINT, lastItemId: ITEM });
    expect(cursor).toBe(base64url(cursorWire()));
    expect(cursor.length).toBeLessThanOrEqual(512);
    expect(validateSlackRepairCensusRequest({ scope: SCOPE, cursor }).cursor).toEqual({
      scopeFingerprint: FINGERPRINT,
      lastItemId: ITEM,
    });
  });

  it("rejects every cursor that is not exactly the v1 schema", async () => {
    const { validateSlackRepairCensusRequest } = await census();
    const without = (key: string): Json =>
      Object.fromEntries(Object.entries(cursorWire()).filter(([name]) => name !== key));
    const invalid: unknown[] = [
      "",
      " ",
      "not base64url !!",
      7,
      null,
      base64url("null"),
      base64url("[]"),
      base64url("{not json"),
      base64url(without("v")),
      base64url(without("lastItemId")),
      base64url(cursorWire({ v: 2 })),
      base64url(cursorWire({ v: "1" })),
      base64url(cursorWire({ lastItemId: "not-a-uuid" })),
      base64url(cursorWire({ lastItemId: ITEM.toUpperCase().replace(/5/g, "A") })),
      base64url(cursorWire({ scopeFingerprint: "F".repeat(64) })),
      base64url(cursorWire({ scopeFingerprint: "f".repeat(63) })),
      // A cursor is a locator. It cannot carry a verdict, a workspace or a capability.
      base64url(cursorWire({ verified: true })),
      base64url(cursorWire({ workspaceId: WORKSPACE })),
      // Non-canonical spellings of an otherwise valid cursor: padding, whitespace, key order.
      `${base64url(cursorWire())}=`,
      ` ${base64url(cursorWire())}`,
      base64url(JSON.stringify(cursorWire(), null, 1)),
      base64url(Object.fromEntries(Object.entries(cursorWire()).reverse())),
      base64url(cursorWire({ pad: "x".repeat(2048) })),
      "A".repeat(4096),
    ];
    for (const cursor of invalid) {
      const error = await rejection(() => validateSlackRepairCensusRequest({ scope: SCOPE, cursor }));
      expect(error, `cursor ${JSON.stringify(cursor).slice(0, 60)}`).toMatchObject({ category: "invalid_cursor" });
      if (typeof cursor === "string" && cursor.length > 8) expect(String(error.message)).not.toContain(cursor);
    }
  });

  it.each([
    ["another team", { teamId: OTHER_TEAM }],
    ["another integration", { integrationId: OTHER_PROJECT }],
    ["another channel", { channelId: "C0OTHER" }],
    ["a case variant of the channel", { channelId: "c0abc" }],
  ])("rejects a cursor minted for %s", async (_label, over) => {
    const { validateSlackRepairCensusRequest, encodeSlackRepairCursor } = await census();
    const cursor = encodeSlackRepairCursor({
      scope: { ...SCOPE, ...over }, scopeFingerprint: FINGERPRINT, lastItemId: ITEM,
    });
    const error = await rejection(() => validateSlackRepairCensusRequest({ scope: SCOPE, cursor }));
    expect(error).toMatchObject({ category: "invalid_cursor" });
  });
});

describe("slack repair census: scope fingerprint and availability", () => {
  it("fingerprints the ordered v1 tuple, over the CURRENT config selection", async () => {
    const { slackRepairScopeFingerprint, decideSlackRepairScope } = await census();
    const row = scopeRow();
    const expected = tupleFingerprint(row, [CHANNEL, "C0ZED"]);
    expect(
      slackRepairScopeFingerprint({
        scope: SCOPE,
        integrationStatus: row.integrationStatus,
        updatedAtUtcMicroseconds: row.updatedAtUtcMicroseconds,
        selectedChannelIds: [CHANNEL, "C0ZED"],
        bindingState: row.bindingState,
        bindingWorkspaceId: row.bindingWorkspaceId,
        bindingConfigRevision: row.bindingConfigRevision,
      })
    ).toBe(expected);
    expect(decideSlackRepairScope({ scope: SCOPE, row, cursor: null })).toEqual({
      outcome: "available",
      scopeFingerprint: expected,
      bindingWorkspaceId: WORKSPACE,
      integrationStatus: "enabled",
    });
    // Re-ordering or repeating the same selection is not a configuration change; refused ids drop out.
    const reordered = scopeRow({ configChannelIds: ["C0ZED", CHANNEL, CHANNEL, "bad id", 7, null] });
    expect(decideSlackRepairScope({ scope: SCOPE, row: reordered, cursor: null })).toMatchObject({
      outcome: "available", scopeFingerprint: expected,
    });
  });

  it.each([
    ["status", { integrationStatus: "disabled" }],
    ["a microsecond of updated_at", { updatedAtUtcMicroseconds: "2026-10-05T12:34:56.123457Z" }],
    ["the selection", { configChannelIds: [CHANNEL, "C0ZED", "C0NEW"] }],
    ["the workspace", { bindingWorkspaceId: "T2" }],
    ["the config revision", { bindingConfigRevision: "d".repeat(64) }],
  ])("a cursor minted before a change to %s is refused as scope_changed", async (_label, over) => {
    const { decideSlackRepairScope } = await census();
    const before = decideSlackRepairScope({ scope: SCOPE, row: scopeRow(), cursor: null }) as Json;
    const cursor = { scopeFingerprint: before.scopeFingerprint, lastItemId: ITEM };
    expect(decideSlackRepairScope({ scope: SCOPE, row: scopeRow(), cursor })).toMatchObject({ outcome: "available" });
    const fresh = decideSlackRepairScope({ scope: SCOPE, row: scopeRow(over), cursor: null }) as Json;
    expect(fresh).toMatchObject({ outcome: "available" });
    expect(fresh.scopeFingerprint).not.toBe(before.scopeFingerprint);
    expect(decideSlackRepairScope({ scope: SCOPE, row: scopeRow(over), cursor })).toEqual({
      outcome: "refused", reason: "scope_changed",
    });
  });

  it("reads a disabled integration, visibly disabled", async () => {
    const { decideSlackRepairScope } = await census();
    expect(
      decideSlackRepairScope({ scope: SCOPE, row: scopeRow({ integrationStatus: "disabled" }), cursor: null })
    ).toMatchObject({ outcome: "available", integrationStatus: "disabled" });
  });

  it.each([
    ["no joined row", null],
    ["an unverified binding", scopeRow({ bindingState: "blocked" })],
    ["a pending binding with no workspace", scopeRow({ bindingState: "pending_auth", bindingWorkspaceId: null })],
    ["a verified binding with no workspace", scopeRow({ bindingWorkspaceId: null })],
    ["a workspace that is not a provider id", scopeRow({ bindingWorkspaceId: "T 1" })],
    ["a channel the current config does not select", scopeRow({ configChannelIds: ["C0ZED"] })],
    ["a case variant of the selected channel", scopeRow({ configChannelIds: ["c0abc"] })],
    ["a config with no selection at all", scopeRow({ configChannelIds: null })],
  ])("refuses %s as scope_unavailable on a fresh request", async (_label, row) => {
    const { decideSlackRepairScope } = await census();
    expect(decideSlackRepairScope({ scope: SCOPE, row, cursor: null })).toEqual({
      outcome: "refused", reason: "scope_unavailable",
    });
  });

  it("keeps availability on every invocation: an unchanged fingerprint cannot resume an unavailable scope", async () => {
    const { decideSlackRepairScope } = await census();
    const row = scopeRow({ configChannelIds: ["C0ZED"] });
    const unchanged = { scopeFingerprint: tupleFingerprint(row, ["C0ZED"]), lastItemId: ITEM };
    expect(decideSlackRepairScope({ scope: SCOPE, row, cursor: unchanged })).toEqual({
      outcome: "refused", reason: "scope_unavailable",
    });
    // …while a joined row whose facts MOVED says so, even when the move is what made it unavailable.
    expect(
      decideSlackRepairScope({ scope: SCOPE, row, cursor: { scopeFingerprint: FINGERPRINT, lastItemId: ITEM } })
    ).toEqual({ outcome: "refused", reason: "scope_changed" });
    expect(
      decideSlackRepairScope({ scope: SCOPE, row: null, cursor: { scopeFingerprint: FINGERPRINT, lastItemId: ITEM } })
    ).toEqual({ outcome: "refused", reason: "scope_unavailable" });
  });

  it("a non-Slack integration is scope_unavailable, with or without a cursor", async () => {
    const { decideSlackRepairScope } = await census();
    const row = scopeRow({ integrationType: "github" });
    const unchanged = { scopeFingerprint: tupleFingerprint(row, [CHANNEL, "C0ZED"]), lastItemId: ITEM };
    const moved = { scopeFingerprint: FINGERPRINT, lastItemId: ITEM };
    for (const cursor of [null, unchanged, moved]) {
      expect(decideSlackRepairScope({ scope: SCOPE, row, cursor })).toEqual({
        outcome: "refused", reason: "scope_unavailable",
      });
    }
  });
});

describe("slack repair census: the relationship decision table", () => {
  it("a legacy channel-id path is a candidate — unproven, with a HYPOTHETICAL target", async () => {
    const entry = await entryOf();
    expect(entry).toMatchObject({
      itemId: ITEM,
      projectId: PROJECT,
      path: { kind: "legacy", channelSegment: "c0abc", rootTs: ROOT },
      relationship: "channel_candidate",
      evidence: ["legacy_path_segment"],
      provenance: "unproven",
      retainedChannelMetadata: "absent",
      hypotheticalTarget: {
        hypothetical: true,
        workspace: "stored_binding_workspace",
        path: `slack/t1/c0abc/${ROOT}.md`,
      },
      exactTargetItemId: null,
    });
    expect((await classify()).gateNoncanonical).toBe(true);
  });

  it("matching retained metadata adds a label, and can carry a slug path — still unproven", async () => {
    expect(await entryOf({ item: { frontmatter: { source: "slack", channel_id: CHANNEL } } })).toMatchObject({
      relationship: "channel_candidate",
      evidence: ["legacy_path_segment", "retained_channel_metadata"],
      provenance: "unproven",
      retainedChannelMetadata: "valid",
    });
    expect(
      await entryOf({
        item: { path: `slack/general/${ROOT}.md`, frontmatter: { source: "slack", channel_id: CHANNEL } },
      })
    ).toMatchObject({
      path: { kind: "legacy", channelSegment: "general", rootTs: ROOT },
      relationship: "channel_candidate",
      evidence: ["retained_channel_metadata"],
      provenance: "unproven",
      hypotheticalTarget: { hypothetical: true, path: `slack/t1/c0abc/${ROOT}.md` },
    });
  });

  it("nothing about TODAY qualifies a legacy item: not the binding, not a frontmatter workspace, not one observation", async () => {
    const entry = await entryOf({
      item: {
        frontmatter: {
          source: "slack", channel_id: CHANNEL, workspace_id: WORKSPACE, team_id: WORKSPACE,
          workspace: WORKSPACE, verified: true, provenance: "scoped_ledger_observed",
        },
      },
    });
    expect(entry).toMatchObject({ relationship: "channel_candidate", provenance: "unproven" });
    expect(entry.evidence).not.toContain("source_ledger");
    expect(entry.evidence).not.toContain("channel_state");
    expect(entry.pending).toEqual(expect.arrayContaining(["source_refetch_required", "provenance_review_required"]));
    expect(JSON.stringify(entry)).not.toMatch(/"(verified|safe_to_migrate|migration_ready)"/);
  });

  it("a mismatching slug with no metadata is unresolved; so is a slug carrying ANOTHER channel's metadata", async () => {
    expect(await entryOf({ item: { path: `slack/general/${ROOT}.md` } })).toMatchObject({
      relationship: "unresolved_channel",
      path: { kind: "legacy", channelSegment: "general", rootTs: ROOT },
      evidence: [],
      provenance: "unproven",
    });
    expect(
      await entryOf({
        item: { path: `slack/general/${ROOT}.md`, frontmatter: { source: "slack", channel_id: "C0OTHER" } },
      })
    ).toMatchObject({ relationship: "unresolved_channel", retainedChannelMetadata: "valid", provenance: "unproven" });
    expect(
      await entryOf({
        item: { path: `slack/general/${ROOT}.md`, frontmatter: { source: "slack", channel_id: "C0 OTHER" } },
      })
    ).toMatchObject({ relationship: "unresolved_channel", retainedChannelMetadata: "malformed" });
  });

  it("a segment that IS a different metadata-backed channel id is unrelated — a count, not an entry", async () => {
    const result = await classify({
      item: { path: `slack/c0other/${ROOT}.md`, frontmatter: { source: "slack", channel_id: "C0OTHER" } },
    });
    expect(result).toMatchObject({ bucket: "unrelated", gateNoncanonical: true });
    expect(result.entry).toBeUndefined();
    // …unless this item's own ledger says the requested source wrote it.
    expect(
      await entryOf({
        item: { path: `slack/c0other/${ROOT}.md`, frontmatter: { source: "slack", channel_id: "C0OTHER" } },
        ledgerSources: [ledgerSource()],
      })
    ).toMatchObject({ relationship: "conflicting_evidence", provenance: "conflicting" });
  });

  it("contradictory path / frontmatter / ledger facts are a conflict, never a quiet match", async () => {
    // Path says the requested channel; valid retained metadata names another (byte-exact: case counts).
    for (const channel_id of ["C0OTHER", "c0abc"]) {
      expect(await entryOf({ item: { frontmatter: { source: "slack", channel_id } } })).toMatchObject({
        relationship: "conflicting_evidence", provenance: "conflicting",
      });
    }
    // Invalid PRESENT metadata is flagged, not trusted and not treated as a contradiction.
    expect(await entryOf({ item: { frontmatter: { source: "slack", channel_id: "C0 ABC!" } } })).toMatchObject({
      relationship: "channel_candidate", retainedChannelMetadata: "malformed", evidence: ["legacy_path_segment"],
    });
    // A scoped match whose ledger names another source, including a case-only variant of this one.
    const scoped = { path: `slack/t1/c0abc/${ROOT}.md` };
    for (const source of [
      { workspaceId: "T2", channelId: CHANNEL },
      { workspaceId: WORKSPACE, channelId: "C0OTHER" },
      { workspaceId: "t1", channelId: CHANNEL },
      { workspaceId: WORKSPACE, channelId: "c0abc" },
    ]) {
      const entry = await entryOf({ item: scoped, ledgerSources: [ledgerSource(), ledgerSource(source)] });
      expect(entry, JSON.stringify(source)).toMatchObject({
        relationship: "conflicting_evidence",
        provenance: "conflicting",
        ledger: { totalMessages: "1", conflictingSourceMessages: "1" },
      });
    }
    // A scoped path for ANOTHER channel that this source's ledger or metadata claims.
    const elsewhere = { path: `slack/t1/c0other/${ROOT}.md` };
    expect(await classify({ item: elsewhere })).toMatchObject({ bucket: "unrelated", gateNoncanonical: false });
    expect(await entryOf({ item: elsewhere, ledgerSources: [ledgerSource()] })).toMatchObject({
      relationship: "conflicting_evidence",
    });
    expect(
      await entryOf({ item: { ...elsewhere, frontmatter: { source: "slack", channel_id: CHANNEL } } })
    ).toMatchObject({ relationship: "conflicting_evidence" });
  });

  it("compares path segments ASCII-lowercased against upper-case provider ids", async () => {
    for (const path of [`slack/t1/c0abc/${ROOT}.md`, `slack/T1/C0ABC/${ROOT}.md`]) {
      const result = await classify({ item: { path } });
      expect(result).toMatchObject({ bucket: "entry", gateNoncanonical: false });
      expect(result.entry).toMatchObject({
        relationship: "scoped_channel_match",
        evidence: ["scoped_path_segments"],
        provenance: "unproven",
        hypotheticalTarget: null,
        exactTargetItemId: null,
      });
    }
    expect(
      await entryOf({ item: { path: `slack/t1/c0abc/${ROOT}.md` }, ledgerSources: [ledgerSource()] })
    ).toMatchObject({
      relationship: "scoped_channel_match",
      evidence: ["scoped_path_segments", "source_ledger"],
      provenance: "scoped_ledger_observed",
    });
  });

  it("a scoped path in another workspace is an observation only — no entry, no requested-workspace counts", async () => {
    const result = await classify({ item: { path: `slack/t0other/c0abc/${ROOT}.md` } });
    expect(result).toMatchObject({
      bucket: "other_workspace",
      gateNoncanonical: false,
      observation: { kind: "scanned_scoped_path", workspaceId: "t0other", sourceId: ITEM },
    });
    expect(result.entry).toBeUndefined();
    // Contradiction wins, and the row then occupies the entries bucket ONLY.
    const conflicted = await classify({
      item: { path: `slack/t0other/c0abc/${ROOT}.md` },
      ledgerSources: [ledgerSource()],
    });
    expect(conflicted).toMatchObject({ bucket: "entry", entry: { relationship: "conflicting_evidence" } });
    expect(conflicted.observation).toBeUndefined();
  });

  it("keeps the exact timestamp spelling, and never repairs a malformed path", async () => {
    for (const root of ["0001718900000.000100", "1718900000.1", "1718900000.00010"]) {
      const legacy = await entryOf({ item: { path: `slack/c0abc/${root}.md` } });
      expect(legacy).toMatchObject({
        path: { kind: "legacy", rootTs: root },
        hypotheticalTarget: { path: `slack/t1/c0abc/${root}.md` },
      });
    }
    // Parser-valid, five fractional digits: a scoped match that the gate producer would still block on.
    const short = await classify({ item: { path: "slack/t1/c0abc/1718900000.00010.md" } });
    expect(short).toMatchObject({
      bucket: "entry",
      gateNoncanonical: true,
      entry: { relationship: "scoped_channel_match", path: { kind: "scoped", rootTs: "1718900000.00010" } },
    });

    const malformed = [
      `slack//c0abc/${ROOT}.md`,
      `slack/c0abc//${ROOT}.md`,
      `slack/C0ABC/${ROOT}.md`,
      `slack/c0abc/${ROOT}.MD`,
      "slack/c0abc/1718900000.md",
      "slack/c0abc/1718900000.0001000.md",
      "slack/c0abc/0.000100.md",
      `slack/t1/c0abc/extra/${ROOT}.md`,
      `slack/t 1/c0abc/${ROOT}.md`,
      `notes/slack-export-${ROOT}.md`,
      "slack/c0abc/<script>alert(1)</script>.md",
    ];
    for (const path of malformed) {
      const result = await classify({ item: { path } });
      expect(result, path).toMatchObject({
        bucket: "entry",
        gateNoncanonical: true,
        entry: {
          relationship: "unresolved_channel",
          path: { kind: "malformed", category: "unparseable_slack_path" },
          hypotheticalTarget: null,
          exactTargetItemId: null,
        },
      });
      expect(Object.keys((result.entry as Json).path as Json).sort()).toEqual(["category", "kind"]);
    }
  });

  it("never lets stored free text reach a diagnostic string", async () => {
    const hostile = "C0ABC'); drop table items;--<script>alert('x')</script>";
    const entry = await entryOf({
      item: {
        path: `slack/c0abc/${hostile}.md`,
        frontmatter: {
          source: "slack",
          channel_id: hostile,
          channel: hostile,
          participants: [{ author_id: hostile, first_ts: hostile, last_ts: hostile }, hostile],
        },
      },
      authorStatuses: ["invalid_input"],
    });
    const text = JSON.stringify(entry);
    for (const fragment of ["drop table", "<script>", "alert(", "');"]) expect(text).not.toContain(fragment);
    expect(entry).toMatchObject({
      relationship: "unresolved_channel",
      path: { kind: "malformed", category: "unparseable_slack_path" },
      retainedChannelMetadata: "malformed",
    });
  });
});

describe("slack repair census: collisions, peers and their bounds", () => {
  const target = `slack/t1/c0abc/${ROOT}.md`;

  it("an exact target is a collision only inside the SAME project", async () => {
    const same = await entryOf({ targetPathItems: [{ itemId: itemId(7), projectId: PROJECT }] });
    expect(same).toMatchObject({
      hypotheticalTarget: { path: target },
      exactTargetItemId: itemId(7),
      sameThreadOtherProjectItemIds: [],
      sameThreadOtherProjectItemIdsTruncated: false,
    });
    const other = await entryOf({ targetPathItems: [{ itemId: itemId(7), projectId: OTHER_PROJECT }] });
    expect(other).toMatchObject({
      exactTargetItemId: null,
      sameThreadOtherProjectItemIds: [itemId(7)],
      sameThreadOtherProjectItemIdsTruncated: false,
    });
    const both = await entryOf({
      targetPathItems: [
        { itemId: itemId(8), projectId: OTHER_PROJECT },
        { itemId: itemId(7), projectId: PROJECT },
      ],
      otherProjectSameThreadItemIds: [itemId(3)],
    });
    expect(both).toMatchObject({
      exactTargetItemId: itemId(7),
      sameThreadOtherProjectItemIds: [itemId(3), itemId(8)],
    });
    // The item itself is never its own collision.
    expect(await entryOf({ targetPathItems: [{ itemId: ITEM, projectId: PROJECT }] })).toMatchObject({
      exactTargetItemId: null,
    });
  });

  it("caps peer arrays at 50, sorted ascending, and uses the 51st only to say so", async () => {
    const ids = (count: number): string[] => Array.from({ length: count }, (_, i) => itemId(1000 - i));
    const full = await entryOf({ sameProjectConvergingItemIds: ids(50), otherProjectSameThreadItemIds: ids(50) });
    expect(full.sameProjectConvergingItemIds).toEqual(ids(50).sort());
    expect(full).toMatchObject({
      sameProjectConvergingItemIdsTruncated: false,
      sameThreadOtherProjectItemIdsTruncated: false,
    });
    const over = await entryOf({ sameProjectConvergingItemIds: ids(51), otherProjectSameThreadItemIds: ids(51) });
    expect(over.sameProjectConvergingItemIds).toEqual(ids(51).sort().slice(0, 50));
    expect(over.sameThreadOtherProjectItemIds).toEqual(ids(51).sort().slice(0, 50));
    expect(over).toMatchObject({
      sameProjectConvergingItemIdsTruncated: true,
      sameThreadOtherProjectItemIdsTruncated: true,
    });
  });

  it("any converging peer — or an overflow of them — requires provenance review, and proves nothing", async () => {
    const scopedMatch = { path: `slack/t1/c0abc/${ROOT}.md` };
    const alone = await entryOf({ item: scopedMatch, ledgerSources: [ledgerSource()], authorStatuses: ["resolved"] });
    expect(alone.pending).not.toContain("provenance_review_required");
    const converging = await entryOf({ sameProjectConvergingItemIds: [itemId(9)] });
    expect(converging).toMatchObject({
      sameProjectConvergingItemIds: [itemId(9)],
      exactTargetItemId: null,
      provenance: "unproven",
    });
    expect(converging.pending).toContain("provenance_review_required");
    // The two diagnoses coexist: an occupied target does not hide a second legacy item bound for it.
    expect(
      await entryOf({
        sameProjectConvergingItemIds: [itemId(9)],
        targetPathItems: [{ itemId: itemId(7), projectId: PROJECT }],
      })
    ).toMatchObject({ exactTargetItemId: itemId(7), sameProjectConvergingItemIds: [itemId(9)] });
  });

  it("orders other-workspace observations by kind, workspace, then source row, capped at 50", async () => {
    const { orderSlackRepairObservations } = await census();
    const mixed = [
      { kind: "scanned_scoped_path", workspaceId: "t0aaa", sourceId: itemId(2) },
      { kind: "channel_state", workspaceId: "T2", sourceId: itemId(9) },
      { kind: "scanned_scoped_path", workspaceId: "t0aaa", sourceId: itemId(1) },
      { kind: "channel_state", workspaceId: "T10", sourceId: itemId(8) },
      { kind: "channel_state", workspaceId: "T10", sourceId: itemId(3) },
    ];
    expect(orderSlackRepairObservations(mixed)).toEqual({
      observations: [mixed[4], mixed[3], mixed[1], mixed[2], mixed[0]],
      truncated: false,
    });
    const many = Array.from({ length: 51 }, (_, i) => ({
      kind: "channel_state", workspaceId: `T0WS${String(50 - i).padStart(3, "0")}`, sourceId: itemId(i),
    }));
    const capped = orderSlackRepairObservations([...many, mixed[0]]) as { observations: Json[]; truncated: boolean };
    expect(capped.truncated).toBe(true);
    expect(capped.observations).toHaveLength(50);
    expect(capped.observations.map((o) => o.workspaceId)).toEqual(
      many.map((o) => o.workspaceId).sort().slice(0, 50)
    );
    expect(orderSlackRepairObservations(many.slice(0, 50))).toMatchObject({ truncated: false });
    expect(orderSlackRepairObservations([])).toEqual({ observations: [], truncated: false });
  });
});

describe("slack repair census: metadata, ledger, lock and queue facts", () => {
  it("keeps absent, empty, valid and malformed participants distinct", async () => {
    const withParticipants = (participants: unknown): Promise<Json> =>
      entryOf({ item: { frontmatter: { source: "slack", participants } } });
    expect((await entryOf()).participants).toEqual({
      status: "absent", validCount: 0, earliestAttestedTs: null, latestAttestedTs: null,
    });
    expect((await withParticipants([])).participants).toEqual({
      status: "present_empty", validCount: 0, earliestAttestedTs: null, latestAttestedTs: null,
    });
    const valid = [
      { author_id: "U1", display_name: "One", message_count: 3, first_ts: "2024-06-01T09:00:00.000100Z", last_ts: "2024-06-20T17:00:00.000200Z" },
      { author_id: "U2", display_name: "Two", message_count: 1, first_ts: "2024-06-05T09:00:00.000000Z", last_ts: "2024-06-05T09:00:00.000000Z" },
    ];
    expect((await withParticipants(valid)).participants).toEqual({
      status: "present_valid",
      validCount: 2,
      earliestAttestedTs: "2024-06-01T09:00:00.000100Z",
      latestAttestedTs: "2024-06-20T17:00:00.000200Z",
    });
    for (const malformed of ["U1,U2", { author_id: "U1" }, null, 7, [...valid, "U3"], [...valid, { last_ts: "2024-06-21T00:00:00.000000Z" }], [null]]) {
      const participants = (await withParticipants(malformed)).participants as Json;
      expect(participants.status, JSON.stringify(malformed)).toBe("present_malformed");
    }
    expect((await withParticipants([...valid, { last_ts: "2024-06-30T00:00:00.000000Z" }])).participants).toMatchObject({
      status: "present_malformed", validCount: 2, latestAttestedTs: "2024-06-20T17:00:00.000200Z",
    });
  });

  it("reports two attested endpoints as two endpoints — never the days between them", async () => {
    const entry = await entryOf({
      item: {
        frontmatter: {
          source: "slack",
          participants: [{ author_id: "U1", first_ts: "2024-06-01T09:00:00.000000Z", last_ts: "2024-06-20T17:00:00.000000Z" }],
        },
      },
    });
    expect(Object.keys(entry.participants as Json).sort()).toEqual([
      "earliestAttestedTs", "latestAttestedTs", "status", "validCount",
    ]);
    const text = JSON.stringify(entry);
    for (let day = 2; day <= 19; day++) expect(text).not.toContain(`2024-06-${String(day).padStart(2, "0")}`);
    // No ledger was read, so there is no day count to report — endpoints do not become one.
    expect(entry.ledger).toMatchObject({ present: false, eligibleNondeletedUtcDays: "0", eligibleNondeletedMessages: "0" });
  });

  it("a deleted-only or excluded-only ledger is still a ledger, and participants do not stand in for it", async () => {
    const participants = [{ author_id: "U1", first_ts: "2024-06-01T09:00:00.000000Z", last_ts: "2024-06-20T17:00:00.000000Z" }];
    const item = { path: `slack/t1/c0abc/${ROOT}.md`, frontmatter: { source: "slack", participants } };
    const deletedOnly = await entryOf({
      item,
      ledgerSources: [ledgerSource({ totalMessages: "2", eligibleNondeletedMessages: "0", deletedMessages: "2", eligibleNondeletedUtcDays: "0" })],
    });
    expect(deletedOnly.ledger).toEqual({
      present: true, totalMessages: "2", eligibleNondeletedMessages: "0", excludedMessages: "0",
      deletedMessages: "2", eligibleNondeletedUtcDays: "0", conflictingSourceMessages: "0",
    });
    expect((deletedOnly.authorMapping as Json).resolved).toBe(0);
    const excludedOnly = await entryOf({
      item,
      ledgerSources: [ledgerSource({ totalMessages: "1", eligibleNondeletedMessages: "0", excludedMessages: "1", eligibleNondeletedUtcDays: "0" })],
    });
    expect(excludedOnly.ledger).toMatchObject({ present: true, eligibleNondeletedMessages: "0", excludedMessages: "1" });
    // Counts are decimal strings and pass through untouched past 2^53; excluded and deleted may overlap.
    const huge = await entryOf({
      item,
      ledgerSources: [ledgerSource({
        totalMessages: "9007199254740993", eligibleNondeletedMessages: "9007199254740990",
        excludedMessages: "3", deletedMessages: "2", eligibleNondeletedUtcDays: "400",
      })],
    });
    expect(huge.ledger).toMatchObject({
      totalMessages: "9007199254740993", eligibleNondeletedMessages: "9007199254740990",
      excludedMessages: "3", deletedMessages: "2", eligibleNondeletedUtcDays: "400",
    });
  });

  it("reports the lock as stored: a null owner is a lock exception with no claimed cause", async () => {
    expect(await entryOf()).toMatchObject({ correctionLock: "unlocked" });
    expect((await entryOf()).pending).not.toContain("lock_exception");
    expect(await entryOf({ item: { memberId: MEMBER, memberIdLocked: false } })).toMatchObject({ correctionLock: "unlocked" });
    expect(await entryOf({ item: { memberId: MEMBER, memberIdLocked: true } })).toMatchObject({
      correctionLock: "locked_with_owner",
    });
    const orphan = await entryOf({ item: { memberId: null, memberIdLocked: true } });
    expect(orphan.correctionLock).toBe("locked_no_owner");
    expect(orphan.pending).toContain("lock_exception");
    // ON DELETE SET NULL and an explicit clear are the same stored row; the report must not pick one.
    expect(JSON.stringify(orphan)).not.toMatch(/owner_deleted|owner_cleared|manually_cleared|inferred_owner/);
    expect(Object.keys(orphan)).not.toContain("lockOwnerId");
  });

  it("associates queue work only with a scoped match, and reads absence as not_observed", async () => {
    const scoped = { path: `slack/t1/c0abc/${ROOT}.md` };
    const absent = await entryOf({ item: scoped });
    expect(absent).toMatchObject({ queueStatus: "not_observed", queueErrorObserved: false });
    expect(absent.pending).not.toContain("pending_queue_work");
    for (const status of ["queued", "running"]) {
      const entry = await entryOf({ item: scoped, queue: { status, errorObserved: status === "running" } });
      expect(entry).toMatchObject({ queueStatus: status, queueErrorObserved: status === "running" });
      expect(entry.pending).toContain("pending_queue_work");
    }
    // A legacy item whose root happens to equal a queued requested-workspace root gets no association.
    const legacy = await entryOf({ queue: { status: "queued", errorObserved: true } });
    expect(legacy).toMatchObject({ queueStatus: "not_applicable", queueErrorObserved: false });
    expect(legacy.pending).not.toContain("pending_queue_work");
  });

  it("tallies author statuses into one fixed count per category and flags unresolved ones", async () => {
    const entry = await entryOf({
      item: { path: `slack/t1/c0abc/${ROOT}.md` },
      ledgerSources: [ledgerSource()],
      authorStatuses: ["resolved", "resolved", "no_mapping", "mapping_candidates_overflow", "nonhuman_member"],
    });
    expect(Object.keys(entry.authorMapping as Json).sort()).toEqual([...AUTHOR_STATUSES].sort());
    expect(entry.authorMapping).toMatchObject({
      resolved: 2, no_mapping: 1, mapping_candidates_overflow: 1, nonhuman_member: 1,
      invalid_input: 0, conflicting_mapping: 0, incomplete_provenance: 0,
    });
    expect(entry.pending).toContain("mapping_review_required");
    const clean = await entryOf({
      item: { path: `slack/t1/c0abc/${ROOT}.md` }, ledgerSources: [ledgerSource()], authorStatuses: ["resolved"],
    });
    expect(clean.pending).not.toContain("mapping_review_required");
    // The taxonomy is closed: a status the census does not define is an error, not a new bucket.
    const { classifySlackRepairItem } = await census();
    expect(await rejection(() => classifySlackRepairItem(facts({ authorStatuses: ["verified_by_caller"] })))).toBeInstanceOf(Error);
  });

  it("lists pending categories in their fixed order", async () => {
    const entry = await entryOf({
      item: { memberId: null, memberIdLocked: true },
      authorStatuses: ["incomplete_provenance"],
      sameProjectConvergingItemIds: [itemId(9)],
    });
    expect(entry.pending).toEqual([
      "source_refetch_required", "provenance_review_required", "mapping_review_required", "lock_exception",
    ]);
    for (const category of entry.pending as string[]) expect(PENDING).toContain(category);
  });
});

describe("slack repair census: author mapping diagnostics", () => {
  const mapping = (externalId: string, over: Json = {}): Json => ({
    teamId: TEAM, provider: "slack", externalId, memberId: MEMBER, state: "live", ...over,
  });
  const author = (over: Json = {}): Json => ({
    teamId: TEAM,
    externalId: "U1",
    origin: "source_ledger",
    verifiedItemWorkspaceId: WORKSPACE,
    mappings: [mapping("T1:U1")],
    mappingCandidatesOverflow: false,
    humanMemberIds: new Set([MEMBER]),
    ...over,
  });

  it("resolves a ledger author only through the exact qualified mapping to a current human", async () => {
    const { classifySlackRepairAuthor } = await census();
    expect(classifySlackRepairAuthor(author())).toBe("resolved");
    expect(classifySlackRepairAuthor(author({ mappings: [] }))).toBe("no_mapping");
    expect(classifySlackRepairAuthor(author({ mappings: [mapping("U1")] }))).toBe("no_mapping");
    expect(classifySlackRepairAuthor(author({ mappings: [mapping("T2:U1")] }))).toBe("no_mapping");
    expect(classifySlackRepairAuthor(author({ humanMemberIds: new Set() }))).toBe("nonhuman_member");
    expect(classifySlackRepairAuthor(author({ mappings: [mapping("T1:U1", { teamId: OTHER_TEAM })] }))).toBe("no_mapping");
  });

  it("treats spelling variants as conflicts under JS trim/case semantics, never as aliases", async () => {
    const { classifySlackRepairAuthor } = await census();
    const variants = [
      mapping("t1:u1"),
      mapping("T1:U1 "),
      mapping("﻿T1:U1"),
      mapping("T1:U1", { provider: "Slack" }),
      mapping("T1:U1", { provider: "slack " }),
    ];
    for (const variant of variants) {
      expect(classifySlackRepairAuthor(author({ mappings: [variant] })), JSON.stringify(variant)).toBe("conflicting_mapping");
      expect(classifySlackRepairAuthor(author({ mappings: [mapping("T1:U1"), variant] }))).toBe("conflicting_mapping");
    }
  });

  it("never resolves from truncated candidates", async () => {
    const { classifySlackRepairAuthor } = await census();
    expect(classifySlackRepairAuthor(author({ mappingCandidatesOverflow: true }))).toBe("mapping_candidates_overflow");
    expect(classifySlackRepairAuthor(author({ mappings: [], mappingCandidatesOverflow: true }))).toBe(
      "mapping_candidates_overflow"
    );
  });

  it("legacy participant ids are incomplete_provenance however qualified they look; malformed ones are invalid_input", async () => {
    const { classifySlackRepairAuthor } = await census();
    const participant = (externalId: unknown, over: Json = {}): Json =>
      author({ externalId, origin: "participant_metadata", verifiedItemWorkspaceId: undefined, ...over });
    for (const externalId of ["U1", "T1:U1"]) {
      // A live mapping, a matching current workspace and a human member change nothing.
      expect(classifySlackRepairAuthor(participant(externalId, { mappings: [mapping("T1:U1"), mapping("U1")] }))).toBe(
        "incomplete_provenance"
      );
      expect(classifySlackRepairAuthor(participant(externalId, { verifiedItemWorkspaceId: WORKSPACE }))).toBe(
        "incomplete_provenance"
      );
    }
    for (const externalId of ["bad id!", "A:B:C", "", "T1:", ":U1", "u1", 7, null]) {
      expect(classifySlackRepairAuthor(participant(externalId)), JSON.stringify(externalId)).toBe("invalid_input");
    }
    expect(classifySlackRepairAuthor(author({ externalId: "bad id!" }))).toBe("invalid_input");
  });
});

describe("slack repair census: page counts", () => {
  it("counts entries only, with every category present and overlapping pending counts", async () => {
    const { countSlackRepairEntries } = await census();
    const zero = countSlackRepairEntries([]) as Json;
    expect(zero).toEqual({
      byRelationship: Object.fromEntries(RELATIONSHIPS.map((r) => [r, 0])),
      byPendingCategory: Object.fromEntries(PENDING.map((p) => [p, 0])),
      lockedItems: 0,
    });
    const entries = [
      await entryOf({ item: { memberId: null, memberIdLocked: true } }),
      await entryOf({ item: { memberId: MEMBER, memberIdLocked: true }, authorStatuses: ["incomplete_provenance"] }),
      await entryOf({ item: { path: `slack/general/${ROOT}.md` } }),
      await entryOf({ item: { path: `slack/t1/c0abc/${ROOT}.md` }, queue: { status: "queued", errorObserved: false } }),
      await entryOf({ item: { frontmatter: { source: "slack", channel_id: "C0OTHER" } } }),
    ];
    const counts = countSlackRepairEntries(entries) as {
      byRelationship: Record<string, number>; byPendingCategory: Record<string, number>; lockedItems: number;
    };
    expect(counts.byRelationship).toEqual({
      channel_candidate: 2, scoped_channel_match: 1, unresolved_channel: 1, conflicting_evidence: 1,
    });
    expect(Object.values(counts.byRelationship).reduce((a, b) => a + b, 0)).toBe(entries.length);
    expect(counts.lockedItems).toBe(2);
    expect(counts.byPendingCategory).toMatchObject({ pending_queue_work: 1, mapping_review_required: 1 });
    expect(counts.byPendingCategory.lock_exception).toBeGreaterThanOrEqual(1);
    for (const category of PENDING) {
      expect(counts.byPendingCategory[category]).toBe(
        entries.filter((entry) => (entry.pending as string[]).includes(category)).length
      );
    }
  });
});

describe("slack repair census: namespace gate observation", () => {
  const REPAIR = "77777777-7777-4777-8777-777777777777";
  const gateRow = (over: Json = {}): Json => ({
    state: "blocked", revision: "3", ready_revision: null, resolved_workspace_ids: [],
    completed_repair_id: null, blocked_reason: "legacy_rows_present", ...over,
  });
  const ready = (over: Json = {}): Json =>
    gateRow({
      state: "ready", revision: "4", ready_revision: "4", resolved_workspace_ids: [WORKSPACE],
      completed_repair_id: REPAIR, blocked_reason: null, ...over,
    });

  it("reports absence as absence, and mirrors the ready/blocked codec", async () => {
    const { decodeSlackRepairGate } = await census();
    expect(decodeSlackRepairGate(null)).toEqual({ status: "absent" });
    expect(decodeSlackRepairGate(gateRow())).toEqual({
      status: "blocked", revision: 3, blockedReason: "legacy_rows_present",
    });
    expect(decodeSlackRepairGate(gateRow({ blocked_reason: null }))).toEqual({
      status: "blocked", revision: 3, blockedReason: null,
    });
    expect(decodeSlackRepairGate(ready())).toEqual({
      status: "ready", revision: 4, readyRevision: 4, resolvedWorkspaceIds: [WORKSPACE], completedRepairId: REPAIR,
    });
  });

  it.each([
    ["an unknown state", gateRow({ state: "open" })],
    ["ready without a repair id", ready({ completed_repair_id: null })],
    ["ready at a stale revision", ready({ ready_revision: "3" })],
    ["ready with no ready revision", ready({ ready_revision: null })],
    ["ready with no workspace", ready({ resolved_workspace_ids: [] })],
    ["ready that still carries a blocking reason", ready({ blocked_reason: "legacy_rows_present" })],
    ["ready naming a workspace that is not a provider id", ready({ resolved_workspace_ids: ["not a workspace!"] })],
    ["ready whose workspaces are not an array", ready({ resolved_workspace_ids: "{T1}" })],
    ["ready with a non-string workspace", ready({ resolved_workspace_ids: [7] })],
    ["a revision past the safe-integer range", ready({ revision: "9007199254740993", ready_revision: "9007199254740993" })],
    ["a negative revision", gateRow({ revision: "-1" })],
    ["blocked carrying a ready revision", gateRow({ ready_revision: "3" })],
    ["blocked carrying workspaces", gateRow({ resolved_workspace_ids: [WORKSPACE] })],
    ["blocked carrying a repair id", gateRow({ completed_repair_id: REPAIR })],
  ])("rejects %s instead of reporting it", async (_label, row) => {
    const { decodeSlackRepairGate } = await census();
    const error = await rejection(() => decodeSlackRepairGate(row));
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).not.toContain("not a workspace!");
  });
});

/**
 * STATIC IMPORT GUARD. `slack-source-binding.ts` also defines writers and imports decryption, so the
 * census may take exactly one thing from it — the pure canonicalizer — and only as a plain named
 * import. Everything that writes, reserves, claims, decrypts or calls the provider is banned outright.
 */
const BINDING = /slack-source-binding(?:\.ts)?$/;
/**
 * The message ledger is the second module with exactly ONE permitted name. The spec allows optional
 * team-generation diagnostics, and `readSlackTeamGenerations` is a team-scoped SELECT that runs on
 * whatever session it is handed — the census reader's own read-only transaction. Everything else the
 * module exports bumps a generation or reconciles evidence, so the module is not banned outright and
 * not opened either: the same exact-named-import rule as the binding module applies.
 */
const LEDGER = /slack-message-ledger(?:\.ts)?$/;
const LEDGER_READER = "readSlackTeamGenerations";
const BANNED_MODULES = [
  /(^|\/)secrets(\/|$)/,
  /slack-namespace-gate$/,
  /slack-channel-state$/,
  /slack-method-budget$/,
  /slack-thread-hydrator$/,
  /slack-source-discovery$/,
  /slack-page-request$/,
  /slack-publication$/,
  /integrations\/manage$/,
  /dashboard\/timeline-cache$/,
  // The hydration queue and its snapshots, and thread cleanup. (The message ledger is NOT here: it has
  // one permitted reader, so it is held to the named-import allowlist above instead.)
  /slack-thread-state$/,
  /slack-cleanup$/,
  // Durable caches. A stale-mark or purge that happens to match no row is still a write the census made.
  /graph\/arc-cache$/,
  // Identity writers, and the shared ingest writer in each spelling the census could reach it by.
  /identity\/member-identities$/,
  /^@\/lib\/ingest(\/index)?$/,
  /^\.(\/index)?$/,
  /(^|\/)ingest\/run$/,
  /^\.\/run$/,
  // The unbound admin adapter every one of those writers takes. The census reads on the transaction it
  // opened itself; a second, pool-level client is outside the snapshot by construction.
  /db\/admin$/,
];

/**
 * The same ban by NAME, so a prohibited export cannot arrive through a module that is not itself on the
 * list (a local helper, a barrel, a re-export). These are the modules' actual exports — a control below
 * reads each one back from its source file — and the census has no reason to mention any of them.
 */
const PROHIBITED_EXPORTS: Record<string, readonly string[]> = {
  "lib/graph/arc-cache.ts": [
    "readArcCache", "staleArcCache", "purgeArcCacheKey", "purgePartitionArcCache", "sweepStaleScopedArcCache",
    "sweepOrphanedPartitionArcCache", "writeArcCache", "purgeExternalShapedPartitionRows",
  ],
  "lib/dashboard/timeline-cache.ts": [
    "timelineViewKey", "resolveTimelineVariant", "readTimelineCache", "writeTimelineCache", "bustTeamTimeline",
    "purgeTimelineCacheTier", "purgeAdmissionTimelineNamespace", "settleTimelineRefreshes", "getCachedWorkTimeline",
  ],
  "lib/ingest/slack-thread-state.ts": [
    "enqueueSlackThread", "claimSlackThread", "claimDueSlackThread", "readSlackThreadSnapshot",
    "writeSlackThreadSnapshot", "restartSlackThreadSnapshot", "purgeExpiredSlackThreadSnapshots",
    "checkpointSlackThread", "releaseSlackThreadForRetry",
  ],
  // Every export of the ledger module EXCEPT the one permitted reader, `readSlackTeamGenerations`.
  "lib/ingest/slack-message-ledger.ts": [
    "bumpSlackIdentityGeneration", "bumpSlackIdentityGenerationIfCurrent", "bumpSlackPresentationIfChanged",
    "reconcileCompleteSlackThreadEvidence",
  ],
  "lib/ingest/slack-channel-state.ts": [
    "ensureSlackChannel", "dueSlackChannels", "beginSlackChannelMetadata", "recordSlackChannelPublicState",
    "delaySlackChannel", "claimSlackChannelPage", "lockSlackChannelForAcceptance", "acceptSlackChannelPage",
    "restartSlackChannelScan", "releaseSlackChannelForRetry",
  ],
  "lib/ingest/slack-method-budget.ts": ["reserveSlackMethodSlot", "extendSlackMethodBackoff", "markSlackMethodBlocked"],
  "lib/ingest/slack-namespace-gate.ts": [
    "ensureBlockedSlackNamespaceGate", "prepareNewSlackChannelNamespace", "invalidateSlackNamespaceGate",
    "lockReadySlackNamespaceGate",
  ],
  "lib/ingest/slack-publication.ts": ["prepareSlackPublication", "finishSlackPublication"],
  // Every export of the binding module EXCEPT the one permitted canonicalizer.
  "lib/ingest/slack-source-binding.ts": [
    "slackTokenFingerprint", "resolveEnvSlackToken", "slackConfigRevision", "lockSlackSelection", "slackBindingRef",
    "teamHasCurrentSlackSource", "isSlackBinderValid", "bindSlackSelection", "recordSlackWorkspaceIdentity",
    "recordSlackAppIdentity", "blockSlackBinding", "delaySlackBinding", "readSlackBinding",
  ],
  "lib/ingest/slack-thread-hydrator.ts": ["hydrateOneSlackThread"],
  "lib/ingest/slack-source-discovery.ts": ["discoverSlackSource"],
  "lib/ingest/sources/slack-page-request.ts": ["slackReservedRequest"],
  "lib/ingest/slack-cleanup.ts": ["purgeDeletedSlackThreads"],
  "lib/identity/member-identities.ts": [
    "setMemberIdentity", "removeMemberIdentity", "deleteMemberWithIdentityRevision", "disableMemberWithIdentityRevision",
  ],
  "lib/integrations/manage.ts": [
    "upsertIntegration", "setIntegrationStatus", "deleteIntegration", "setIntegrationSecret",
    "getEnabledIntegrationsWithSecrets", "getProviderKey",
  ],
  "lib/secrets/crypto.ts": ["encryptSecret", "decryptSecret", "decryptSecretBytes"],
  "lib/ingest/index.ts": ["ingestItem"],
  "lib/db/admin.ts": ["adminClient"],
};
const PROHIBITED_REFERENCE = new RegExp(`\\b(${Object.values(PROHIBITED_EXPORTS).flat().join("|")})\\b`, "g");
// Statement-anchored like the not-wired guard's own matcher, so one import cannot swallow the next.
const IMPORT_FORMS =
  /(?:^|\n)\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function censusImportViolations(source: string): string[] {
  const violations: string[] = [];
  for (const match of source.matchAll(IMPORT_FORMS)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    const statement = match[0].replace(/\s+/g, " ").trim();
    const bare = specifier.replace(/\.(?:ts|tsx|mjs|js)$/, "");
    if (BANNED_MODULES.some((banned) => banned.test(bare))) violations.push(statement);
    if (BINDING.test(specifier) && !/^import \{ canonicalSlackChannelIds \} from ['"][^'"]+['"]$/.test(statement)) {
      violations.push(statement);
    }
    if (LEDGER.test(specifier) && !new RegExp(`^import \\{ ${LEDGER_READER} \\} from ['"][^'"]+['"]$`).test(statement)) {
      violations.push(statement);
    }
  }
  if (/\bfetch\s*\(/.test(source)) violations.push("fetch(");
  for (const match of source.matchAll(PROHIBITED_REFERENCE)) violations.push(`prohibited export ${match[1]}`);
  return violations;
}

describe("slack repair census: import allowlist", () => {
  const from = `"./slack-source-binding"`;

  it("accepts exactly the named canonicalizer import (positive control)", () => {
    expect(censusImportViolations(`import { canonicalSlackChannelIds } from ${from};`)).toEqual([]);
    expect(
      censusImportViolations(`import pg from "pg";\nimport {\n  canonicalSlackChannelIds\n} from "@/lib/ingest/slack-source-binding";`)
    ).toEqual([]);
    expect(censusImportViolations(`import { parseSlackItemPath } from "./sources/slack-namespace";`)).toEqual([]);
  });

  it("accepts exactly the named team-generation reader from the message ledger (positive control)", () => {
    for (const specifier of ["./slack-message-ledger", "@/lib/ingest/slack-message-ledger"]) {
      const source = [
        `import { readSlackTeamGenerations } from "${specifier}";`,
        `const generations = await readSlackTeamGenerations(session, scope.teamId);`,
      ].join("\n");
      expect(censusImportViolations(source), specifier).toEqual([]);
    }
    expect(Object.values(PROHIBITED_EXPORTS).flat()).not.toContain(LEDGER_READER);
  });

  it.each([
    ["a ledger writer on its own", `import { bumpSlackIdentityGeneration } from "./slack-message-ledger";`],
    ["the reader with a writer beside it", `import { readSlackTeamGenerations, bumpSlackPresentationIfChanged } from "./slack-message-ledger";`],
    ["a writer with the reader beside it", `import { reconcileCompleteSlackThreadEvidence, readSlackTeamGenerations } from "./slack-message-ledger";`],
    ["the reader aliased", `import { readSlackTeamGenerations as generations } from "./slack-message-ledger";`],
    ["a writer aliased to the reader's name", `import { bumpSlackIdentityGeneration as readSlackTeamGenerations } from "./slack-message-ledger";`],
    ["a namespace import", `import * as ledger from "./slack-message-ledger";`],
    ["a default import", `import ledger from "@/lib/ingest/slack-message-ledger";`],
    ["a dynamic import", `const { readSlackTeamGenerations } = await import("./slack-message-ledger");`],
    ["a require", `const { readSlackTeamGenerations } = require("./slack-message-ledger");`],
    ["a re-export of the reader", `export { readSlackTeamGenerations } from "./slack-message-ledger";`],
    ["a star re-export", `export * from "@/lib/ingest/slack-message-ledger";`],
    ["a side-effect import", `import "./slack-message-ledger";`],
    ["a type import of another name", `import type { SlackTeamGenerations } from "./slack-message-ledger";`],
    ["the reader by an extension spelling, with a writer", `import { readSlackTeamGenerations, bumpSlackIdentityGenerationIfCurrent } from "./slack-message-ledger.ts";`],
  ])("the ledger exception does not admit %s (negative control)", (_label, source) => {
    expect(censusImportViolations(source)).not.toEqual([]);
  });

  it.each([
    ["a namespace import", `import * as binding from ${from};`],
    ["a default import", `import binding from ${from};`],
    ["a dynamic import", `const binding = await import(${from});`],
    ["a require", `const binding = require(${from});`],
    ["a re-export", `export { canonicalSlackChannelIds } from ${from};`],
    ["a star re-export", `export * from ${from};`],
    ["a side-effect import", `import ${from};`],
    ["a second named export", `import { canonicalSlackChannelIds, lockSlackSelection } from ${from};`],
    ["a writer on its own", `import { bindSlackSelection } from ${from};`],
    ["an aliased import", `import { canonicalSlackChannelIds as ids } from ${from};`],
    ["a type import of another name", `import type { SlackBinderScope } from ${from};`],
    ["the secret store", `import { decryptSecret } from "@/lib/secrets/crypto";`],
    ["the gate module", `import { ensureBlockedSlackNamespaceGate } from "./slack-namespace-gate";`],
    ["the channel-state writer", `import { dueSlackChannels } from "./slack-channel-state";`],
    ["the method budget", `import { reserveSlackMethod } from "@/lib/ingest/slack-method-budget";`],
    ["the provider transport", `import { requestSlackPage } from "./sources/slack-page-request";`],
    ["the timeline cache", `import { bustTimelineCache } from "@/lib/dashboard/timeline-cache";`],
    ["a provider request", `const r = await fetch("https://slack.com/api/auth.test");`],
    ["the thread queue", `import { enqueueSlackThread } from "./slack-thread-state";`],
    ["the thread queue, by alias and extension", `import * as queue from "@/lib/ingest/slack-thread-state.ts";`],
    ["a message-ledger writer", `import { reconcileCompleteSlackThreadEvidence } from "./slack-message-ledger";`],
    ["the message ledger, dynamically", `const ledger = await import("@/lib/ingest/slack-message-ledger");`],
    ["thread cleanup", `import { purgeDeletedSlackThreads } from "./slack-cleanup";`],
    ["the arc cache", `import { staleArcCache } from "@/lib/graph/arc-cache";`],
    ["the arc cache, relatively", `import { readArcCache } from "../graph/arc-cache";`],
    ["the identity writers", `import { setMemberIdentity } from "@/lib/identity/member-identities";`],
    ["the shared ingest writer", `import { ingestItem } from "@/lib/ingest";`],
    ["the shared ingest writer, relatively", `import { ingestItem } from "./index";`],
    ["the ingest runner", `import { runSlackIngestion } from "./run";`],
    ["the unbound admin adapter", `import { adminClient } from "@/lib/db/admin";`],
  ])("flags %s (negative control)", (_label, source) => {
    expect(censusImportViolations(source)).not.toEqual([]);
  });

  it("flags a prohibited export by NAME, however it was imported (negative control)", () => {
    // The reviewed counterexample: a best-effort cache stale-mark that matches no fixture row.
    const reviewed = [
      `import { adminClient } from "@/lib/db/admin";`,
      `import { staleArcCache } from "@/lib/graph/arc-cache";`,
      `await staleArcCache(adminClient(), scope.teamId);`,
    ].join("\n");
    expect(censusImportViolations(reviewed)).toEqual(
      expect.arrayContaining([
        `import { adminClient } from "@/lib/db/admin"`,
        `import { staleArcCache } from "@/lib/graph/arc-cache"`,
        "prohibited export staleArcCache",
        "prohibited export adminClient",
      ])
    );
    // Laundered through a module that is not on the list: the import passes, the name does not.
    const laundered = `import { staleArcCache as refresh } from "./census-support";\nawait refresh(client, teamId);`;
    expect(censusImportViolations(laundered)).toEqual(["prohibited export staleArcCache"]);
    for (const name of Object.values(PROHIBITED_EXPORTS).flat()) {
      expect(censusImportViolations(`const result = await ${name}(session, scope);`), name).toEqual([
        `prohibited export ${name}`,
      ]);
      expect(censusImportViolations(`const call = support.${name};`), name).toEqual([`prohibited export ${name}`]);
    }
    // The one permitted name stays permitted, and a longer identifier that merely contains one is not a hit.
    expect(censusImportViolations(`const ids = canonicalSlackChannelIds({ channelIds }).selected;`)).toEqual([]);
    expect(censusImportViolations(`const bindingConfigRevisionText = row.config_revision;`)).toEqual([]);
  });

  it("bans only names that are real exports of the modules it bans (control)", () => {
    for (const [file, names] of Object.entries(PROHIBITED_EXPORTS)) {
      const source = readFileSync(join(REPO, file), "utf8");
      for (const name of names) {
        expect(source, `${file} exports ${name}`).toMatch(new RegExp(`^export (?:async )?function ${name}\\b`, "m"));
      }
    }
    // The reviewer-named modules are covered export for export, so a writer added to one of them
    // later fails here instead of slipping past the name list.
    const everyFunction = (file: string): string[] =>
      [...readFileSync(join(REPO, file), "utf8").matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
    for (const file of ["lib/ingest/slack-thread-state.ts"]) {
      expect([...PROHIBITED_EXPORTS[file]].sort(), file).toEqual(everyFunction(file).sort());
    }
    // The ledger: every function export is banned by name except the single permitted reader — so a
    // writer added to that module later is neither banned nor permitted, and fails here.
    const LEDGER_FILE = "lib/ingest/slack-message-ledger.ts";
    expect(everyFunction(LEDGER_FILE).filter((name) => !PROHIBITED_EXPORTS[LEDGER_FILE].includes(name))).toEqual([
      LEDGER_READER,
    ]);
    // …and the permitted name must STAY a reader: one statement, a SELECT, no write and no row lock.
    // If it ever grows an "ensure the row exists" arm, the exception is withdrawn by this assertion.
    const reader = new RegExp(`^export async function ${LEDGER_READER}\\([\\s\\S]*?\\n}\\n`, "m").exec(
      readFileSync(join(REPO, LEDGER_FILE), "utf8")
    )?.[0];
    expect(reader, `${LEDGER_READER} is declared in ${LEDGER_FILE}`).toEqual(expect.any(String));
    expect(reader?.match(/\bexecuteSql\b/g)).toHaveLength(1);
    expect(reader).toMatch(/`\s*select\b[\s\S]*\bfrom slack_team_state where team_id = \$1`/);
    expect(reader).not.toMatch(/\b(?:insert|update|delete|truncate|merge|lock)\b|\bon conflict\b|\bfor\s+(?:no\s+key\s+)?(?:update|share)\b|\bfor\s+key\s+share\b/i);
    expect(reader).not.toMatch(new RegExp(`\\b(?:${PROHIBITED_EXPORTS[LEDGER_FILE].join("|")}|bumpGeneration)\\b`));
    expect(everyFunction("lib/graph/arc-cache.ts").filter((name) => !PROHIBITED_EXPORTS["lib/graph/arc-cache.ts"].includes(name))).toEqual([
      "arcTtlMs",
    ]);
    expect(everyFunction("lib/ingest/slack-source-binding.ts").filter((name) => !PROHIBITED_EXPORTS["lib/ingest/slack-source-binding.ts"].includes(name))).toEqual([
      "canonicalSlackChannelIds",
    ]);
  });

  it("holds for both census modules, and neither is re-exported from the ingest index", () => {
    for (const file of [PURE_FILE, READER_FILE]) {
      const source = readFileSync(join(REPO, file), "utf8");
      expect(censusImportViolations(source), file).toEqual([]);
    }
    // The pure classifier performs no I/O at all.
    const pure = readFileSync(join(REPO, PURE_FILE), "utf8");
    expect(pure).not.toMatch(/from\s+["'][^"']*\/db\//);
    expect(pure).not.toMatch(/from\s+["']pg["']/);
    const index = readFileSync(join(REPO, "lib/ingest/index.ts"), "utf8");
    expect(index).not.toMatch(/slack-repair-census/);
  });
});
