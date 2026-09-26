import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ingestItem } from "@/lib/ingest";
import { reattributeItems } from "@/lib/ingest/reattribute";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { readSlackTeamGenerations } from "@/lib/ingest/slack-message-ledger";
import { transactionCapability } from "@/lib/projects/context/transaction";
import { addAuthorAlias } from "@/lib/admin/aliases";
import { db, seedTeam, sha, transactionSessionDecoratedDb, type Seed } from "./helpers";

const generation = (teamId: string) => transactionCapability(db()).transaction(async (s) =>
  (await readSlackTeamGenerations(s, teamId)).identityGeneration);

// Spec: ingest only stamps items.member_id on create/change, and (post attribution-fix) an
// unresolved author is left unattributed (null), never falling back to the ingesting connector.
// reattributeItems re-applies current identity mappings to already-ingested rows, turning a null
// into a resolved member_id once mapping exists — and, for the narrow legacy case of a row still
// standing on a connector service-account from before the fix, clears it to null instead of
// leaving it there (a connector id was never "good attribution"). It still never erases a
// previously-resolved HUMAN's attribution just because re-resolution comes up empty on a later
// run. Verified on real Postgres.

async function addMember(
  teamId: string,
  opts: { connector?: boolean } = {},
): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({
      team_id: teamId,
      email: `m-${randomUUID()}@test.local`,
      display_name: opts.connector ? "Slack Sync" : "Author",
      actor_handle: `h-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: "active",
      is_connector: Boolean(opts.connector),
    })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

async function memberOf(teamId: string, path: string): Promise<string | null> {
  const { data } = await db()
    .from("items")
    .select("member_id")
    .eq("team_id", teamId)
    .eq("path", path)
    .maybeSingle();
  return (data as { member_id: string | null } | null)?.member_id ?? null;
}

/** The item_versions.member_id ledger for an item, in work (created_at) order. */
async function versionMembersOf(teamId: string, path: string): Promise<(string | null)[]> {
  const { data: item } = await db().from("items").select("id").eq("team_id", teamId).eq("path", path).single();
  const { data } = await db()
    .from("item_versions")
    .select("member_id, created_at")
    .eq("item_id", (item as { id: string }).id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  return ((data ?? []) as { member_id: string | null }[]).map((r) => r.member_id);
}

/** Ingest via a connector, author unresolved at ingest time (opts.authorMemberId: null explicitly). */
async function putUnresolved(
  seed: Seed,
  connectorId: string,
  path: string,
  frontmatter: Record<string, unknown>,
) {
  return ingestItem(
    db(),
    { teamId: seed.teamId, memberId: connectorId, apiKeyId: randomUUID() },
    {
      project: "acme",
      kind: "transcript",
      actor: "",
      content_sha256: sha(path),
      access: "team",
      path,
      body: "hello",
      frontmatter,
    },
    "team",
    { authorMemberId: null },
  );
}

/** Ingest attributed directly to a known (resolved) member — a "good attribution" baseline. */
async function putResolved(
  seed: Seed,
  actorId: string,
  authorId: string,
  path: string,
  frontmatter: Record<string, unknown>,
) {
  return ingestItem(
    db(),
    { teamId: seed.teamId, memberId: actorId, apiKeyId: randomUUID() },
    {
      project: "acme",
      kind: "transcript",
      actor: "",
      content_sha256: sha(path),
      access: "team",
      path,
      body: "hello",
      frontmatter,
    },
    "team",
    { authorMemberId: authorId },
  );
}

describe("reattributeItems (real Postgres)", () => {
  it("re-points a Slack item to the author once their Slack id is mapped; idempotent after", async () => {
    const seed = await seedTeam();
    const connector = await addMember(seed.teamId, { connector: true });
    const author = await addMember(seed.teamId);

    await putUnresolved(seed, connector, "slack/eng/1.md", {
      source: "slack",
      author_id: "U1",
    });
    expect(await memberOf(seed.teamId, "slack/eng/1.md")).toBeNull(); // unresolved at ingest time

    await setMemberIdentity(db(), seed.teamId, author, {
      provider: "slack",
      externalId: "U1",
    });
    expect(await generation(seed.teamId)).toBe("1");
    const s = await reattributeItems(db(), seed.teamId);
    expect(s.updated).toBe(1);
    expect(await memberOf(seed.teamId, "slack/eng/1.md")).toBe(author); // now the real person
    expect(await generation(seed.teamId)).toBe("3"); // item and its historical version changed

    expect((await reattributeItems(db(), seed.teamId)).updated).toBe(0); // idempotent
    expect(await generation(seed.teamId)).toBe("3");
  });

  it("rolls back a Slack attribution row if its revision cannot be written", async () => {
    const seed = await seedTeam();
    const connector = await addMember(seed.teamId, { connector: true });
    const author = await addMember(seed.teamId);
    await putUnresolved(seed, connector, "slack/eng/failed-revision.md",
      { source: "slack", author_id: "U-failed-revision" });
    await setMemberIdentity(db(), seed.teamId, author,
      { provider: "slack", externalId: "U-failed-revision" });
    const failing = transactionSessionDecoratedDb(db(), (session) => ({ ...session,
      executeSql: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes("update slack_team_state") && sql.includes("identity_generation")) {
          throw new Error("generation unavailable");
        }
        return session.executeSql<T>(sql, params);
      },
    }));
    await expect(reattributeItems(failing, seed.teamId)).rejects.toThrow("generation unavailable");
    expect(await memberOf(seed.teamId, "slack/eng/failed-revision.md")).toBeNull();
    expect(await versionMembersOf(seed.teamId, "slack/eng/failed-revision.md")).toEqual([null]);
    expect(await generation(seed.teamId)).toBe("1");
  });

  it("rolls back a Slack version correction if its revision cannot be written", async () => {
    const seed = await seedTeam();
    const connector = await addMember(seed.teamId, { connector: true });
    const author = await addMember(seed.teamId);
    const path = "slack/eng/failed-version-revision.md";
    await putUnresolved(seed, connector, path, { source: "slack", author_id: "U-version-failure" });
    await setMemberIdentity(db(), seed.teamId, author,
      { provider: "slack", externalId: "U-version-failure" });
    // Isolate the later version write: the item is already healed, while its version is not.
    await db().from("items").update({ member_id: author }).eq("team_id", seed.teamId).eq("path", path);
    const failing = transactionSessionDecoratedDb(db(), (session) => ({ ...session,
      executeSql: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes("update slack_team_state") && sql.includes("identity_generation")) {
          throw new Error("generation unavailable");
        }
        return session.executeSql<T>(sql, params);
      },
    }));
    await expect(reattributeItems(failing, seed.teamId)).rejects.toThrow("generation unavailable");
    expect(await memberOf(seed.teamId, path)).toBe(author);
    expect(await versionMembersOf(seed.teamId, path)).toEqual([null]);
    expect(await generation(seed.teamId)).toBe("1");
  });

  it("retries a scan whose identity-map snapshot is overtaken by a remap", async () => {
    const seed = await seedTeam();
    const connector = await addMember(seed.teamId, { connector: true });
    const first = await addMember(seed.teamId);
    const second = await addMember(seed.teamId);
    await putUnresolved(seed, connector, "slack/eng/raced-map.md",
      { source: "slack", author_id: "U-raced-map" });
    await setMemberIdentity(db(), seed.teamId, first,
      { provider: "slack", externalId: "U-raced-map" });
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { arrived = resolve; });
    let reads = 0;
    const paused = transactionSessionDecoratedDb(db(), (session) => ({ ...session,
      executeSql: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes("from slack_team_state where team_id = $1") && ++reads === 2) {
          arrived();
          await gate;
        }
        return session.executeSql<T>(sql, params);
      },
    }));
    const pending = reattributeItems(paused, seed.teamId);
    await reached; // map was read for the first member; hold the after-map revision check
    try {
      await setMemberIdentity(db(), seed.teamId, second,
        { provider: "slack", externalId: "U-raced-map" }, { force: true });
    } finally {
      release();
    }
    await pending;
    expect(await memberOf(seed.teamId, "slack/eng/raced-map.md")).toBe(second);
    expect(await versionMembersOf(seed.teamId, "slack/eng/raced-map.md")).toEqual([second]);
  });

  it("rolls back an in-flight old-map item write before retrying a remap", async () => {
    const seed = await seedTeam();
    const connector = await addMember(seed.teamId, { connector: true });
    const first = await addMember(seed.teamId);
    const second = await addMember(seed.teamId);
    const path = "slack/eng/raced-write.md";
    await putUnresolved(seed, connector, path, { source: "slack", author_id: "U-raced-write" });
    await setMemberIdentity(db(), seed.teamId, first,
      { provider: "slack", externalId: "U-raced-write" });
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { arrived = resolve; });
    let pausedOnce = false;
    const paused = transactionSessionDecoratedDb(db(), (session) => ({ ...session,
      executeSql: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (!pausedOnce && sql.includes("update slack_team_state") && sql.includes("identity_generation")) {
          pausedOnce = true;
          arrived(); // item changed only inside the uncommitted scan transaction
          await gate;
        }
        return session.executeSql<T>(sql, params);
      },
    }));
    const pending = reattributeItems(paused, seed.teamId);
    await reached;
    try {
      await setMemberIdentity(db(), seed.teamId, second,
        { provider: "slack", externalId: "U-raced-write" }, { force: true });
    } finally {
      release();
    }
    await pending;
    expect(await memberOf(seed.teamId, path)).toBe(second);
    expect(await versionMembersOf(seed.teamId, path)).toEqual([second]);
  });

  it("re-points a git commit item once an email alias is added", async () => {
    const seed = await seedTeam();
    const author = await addMember(seed.teamId);
    await putUnresolved(seed, seed.memberId, "commits/repo/abc.md", {
      source: "git",
      author: "Bob <bob@personal.com>",
    });

    expect((await reattributeItems(db(), seed.teamId)).updated).toBe(0); // not yet resolvable
    await addAuthorAlias(db(), seed.teamId, author, "bob@personal.com");
    expect((await reattributeItems(db(), seed.teamId)).updated).toBe(1);
    expect(await memberOf(seed.teamId, "commits/repo/abc.md")).toBe(author);
    expect(await generation(seed.teamId)).toBe("0"); // non-Slack correction does not advance Slack revision
  });

  it("never un-attributes a real human's existing attribution when the author no longer resolves", async () => {
    const seed = await seedTeam();
    const knownAuthor = await addMember(seed.teamId);
    // Ingested already attributed to a real, non-connector member — "good attribution" — and the
    // frontmatter's slack id was never mapped, so reattribute's resolution comes up empty.
    await putResolved(seed, seed.memberId, knownAuthor, "slack/eng/2.md", {
      source: "slack",
      author_id: "U-unknown",
    });

    const s = await reattributeItems(db(), seed.teamId);
    expect(s.updated).toBe(0);
    expect(await memberOf(seed.teamId, "slack/eng/2.md")).toBe(knownAuthor); // left as-is, never erased
  });

  it("clears a connector-attributed item to null when the author still doesn't resolve (legacy pre-fix data)", async () => {
    const seed = await seedTeam();
    const connector = await addMember(seed.teamId, { connector: true });
    await putUnresolved(seed, connector, "slack/eng/3.md", {
      source: "slack",
      author_id: "U-unknown-2",
    });
    // Simulate a legacy row from before the attribution fix, where this would have landed on the
    // connector instead of staying null.
    await db()
      .from("items")
      .update({ member_id: connector })
      .eq("team_id", seed.teamId)
      .eq("path", "slack/eng/3.md");
    expect(await memberOf(seed.teamId, "slack/eng/3.md")).toBe(connector);

    const s = await reattributeItems(db(), seed.teamId);
    expect(s.updated).toBe(1);
    expect(await memberOf(seed.teamId, "slack/eng/3.md")).toBeNull(); // cleared, not left on the connector
  });

  it("heals the WORK LEDGER too — a version author unmapped at push is re-pointed once the mapping arrives", async () => {
    const seed = await seedTeam();
    const connector = await addMember(seed.teamId, { connector: true });
    const author = await addMember(seed.teamId);
    // Ingested via a connector with the slack author unmapped → item AND its version are unattributed.
    await putUnresolved(seed, connector, "slack/eng/led.md", { source: "slack", author_id: "U-led" });
    expect(await versionMembersOf(seed.teamId, "slack/eng/led.md")).toEqual([null]);

    await setMemberIdentity(db(), seed.teamId, author, { provider: "slack", externalId: "U-led" }); // mapping arrives
    const s = await reattributeItems(db(), seed.teamId);
    expect(s.versionsUpdated).toBe(1);
    expect(await memberOf(seed.teamId, "slack/eng/led.md")).toBe(author);
    expect(await versionMembersOf(seed.teamId, "slack/eng/led.md")).toEqual([author]); // ledger healed, not just the item
    expect((await reattributeItems(db(), seed.teamId)).versionsUpdated).toBe(0); // idempotent
  });

  it("PRESERVES a genuine handoff — each version re-resolves to ITS OWN author, never the current owner", async () => {
    const seed = await seedTeam();
    const a = await addMember(seed.teamId);
    const b = await addMember(seed.teamId);
    await setMemberIdentity(db(), seed.teamId, a, { provider: "slack", externalId: "U-a" });
    await setMemberIdentity(db(), seed.teamId, b, { provider: "slack", externalId: "U-b" });
    const auth = { teamId: seed.teamId, memberId: a, apiKeyId: randomUUID() };
    const path = "slack/eng/handoff.md";
    const mk = (body: string, sid: string) => ({
      project: "acme", kind: "transcript" as const, actor: "", content_sha256: sha(body), access: "team" as const,
      path, body, frontmatter: { source: "slack", author_id: sid },
    });
    // v1 authored by A, v2 (changed body) authored by B — a real handoff, both versions kept.
    await ingestItem(db(), auth, mk("v1", "U-a"), "team", { authorMemberId: a });
    await ingestItem(db(), auth, mk("v2", "U-b"), "team", { authorMemberId: b });
    expect(await versionMembersOf(seed.teamId, path)).toEqual([a, b]);

    const s = await reattributeItems(db(), seed.teamId);
    expect(s.versionsUpdated).toBe(0); // each version already resolves to its own author → untouched
    expect(await versionMembersOf(seed.teamId, path)).toEqual([a, b]); // handoff history intact (NOT both → B)
  });
});
