import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AIO-1167 R86 F1 — historical generated output fails CLOSED (real Postgres, a real upgrade).
 *
 * Spec (Astra R86 adjudication F1). The additive migration `20261105163000_query_output_authorization_epoch`
 * deliberately leaves pre-contract rows NULL. NULL generated output — an answer, its citations, a run's
 * partial text or final pointer, a query-log preview — is UNCERTIFIED: it is never projected or matched,
 * before or after a revocation, and it is never stamped with today's epoch. What stays: the member's own
 * historical questions (user-authored) and the run/conversation structure. Explicit 0 stays readable
 * source-free output; a positive epoch is readable only while it is the current, verifiable one.
 *
 * The rows are written BEFORE the provenance columns exist and upgraded through the existing migration
 * file — the path a deployed instance takes — not inserted with a literal NULL.
 */

const probe = vi.hoisted(() => ({ epochReadFails: false, titleClassificationFails: false }));
vi.mock("@/lib/db/pg/pool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/pg/pool")>();
  const runSql = (async (...args: Parameters<typeof actual.runSql>) => {
    if (probe.titleClassificationFails && String(args[0]).includes("first_question")) {
      throw new Error("title classification read failed");
    }
    return actual.runSql(...args);
  }) as typeof actual.runSql;
  return { ...actual, runSql };
});
vi.mock("@/lib/access/authorization-epoch", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/access/authorization-epoch")>();
  return {
    ...real,
    lockedRevocationEpoch: async (...args: Parameters<typeof real.lockedRevocationEpoch>) => {
      if (probe.epochReadFails) throw new Error("authorization epoch read failed");
      return real.lockedRevocationEpoch(...args);
    },
  };
});

import { advanceAuthorizationEpoch, revocationEpoch } from "@/lib/access/authorization-epoch";
import {
  archiveConversation, deriveTitle, getConversation, listConversations, recentTurns, renameConversation, searchConversations,
} from "@/lib/chat/store";
import { runSql } from "@/lib/db/pg/pool";
import { latestRun } from "@/lib/query/turn-runs";
import { db, seedTeam, type Seed } from "./helpers";

const MIGRATION = readFileSync(
  join(process.cwd(), "postgres/migrations/20261105163000_query_output_authorization_epoch.sql"), "utf8");
const TABLES = ["chat_turn_runs", "chat_messages", "query_log"] as const;

beforeEach(() => {
  probe.epochReadFails = false;
  probe.titleClassificationFails = false;
});
// Whatever happened above, leave the schema exactly as the suite found it (the migration is idempotent).
afterAll(async () => {
  await runSql(MIGRATION, []);
});

const ownerOf = (seed: Seed) => ({ teamId: seed.teamId, memberId: seed.memberId });

async function conversation(seed: Seed, title: string): Promise<string> {
  const { rows } = await runSql<{ id: string }>(
    `insert into conversations(team_id, member_id, title) values ($1,$2,$3) returning id`,
    [seed.teamId, seed.memberId, title]);
  return rows[0].id;
}
async function message(seed: Seed, convo: string, role: string, content: string, cited: string[] = []) {
  const { rows } = await runSql<{ id: string }>(
    `insert into chat_messages(conversation_id, team_id, member_id, role, content, cited_item_ids)
     values ($1,$2,$3,$4,$5,$6::uuid[]) returning id`, [convo, seed.teamId, seed.memberId, role, content, cited]);
  return rows[0].id;
}
async function run(seed: Seed, convo: string, status: string, partial: string, finalMessage: string | null) {
  await runSql(
    `insert into chat_turn_runs(conversation_id, team_id, member_id, question, status, partial_text, final_message_id)
     values ($1,$2,$3,'what is the ledger?',$4,$5,$6)`, [convo, seed.teamId, seed.memberId, status, partial, finalMessage]);
}
async function stamp(table: string, id: string, epoch: number) {
  await runSql(`update ${table} set context_authorization_epoch=$2 where id=$1`, [id, epoch]);
}
async function columnPresent(table: string): Promise<boolean> {
  const { rows } = await runSql(
    `select 1 from information_schema.columns where table_name=$1 and column_name='context_authorization_epoch'`, [table]);
  return rows.length > 0;
}

describe("AIO-1167 R86 F1: pre-contract generated output is uncertified after the real upgrade", () => {
  it("NULL completed/partial generated output is suppressed everywhere; questions, 0 and current epochs stay", async () => {
    const seed = await seedTeam();
    const owner = ownerOf(seed);
    const cited = "00000000-0000-0000-0000-0000000000c1";

    // ── Before the contract: the provenance columns do not exist yet. ──────────────────────────────
    for (const table of TABLES) await runSql(`alter table ${table} drop column if exists context_authorization_epoch`, []);
    for (const table of TABLES) expect(await columnPresent(table), table).toBe(false);
    const legacy = await conversation(seed, "legacy thread");
    await message(seed, legacy, "user", "historical question about obsidianquill");
    const legacyAnswer = await message(seed, legacy, "assistant", "obsidianquill answer from a Drive document", [cited]);
    await run(seed, legacy, "done", "", legacyAnswer);
    const legacyPartial = await conversation(seed, "legacy partial");
    await run(seed, legacyPartial, "streaming", "obsidianquill partial text", null);
    await runSql(
      `insert into query_log(team_id, member_id, question, answer_preview, cited_item_ids) values ($1,$2,$3,$4,$5::uuid[])`,
      [seed.teamId, seed.memberId, "historical question", "obsidianquill preview", [cited]]);

    // ── The deployed upgrade path: the existing additive migration. ────────────────────────────────
    await runSql(MIGRATION, []);
    for (const table of TABLES) expect(await columnPresent(table), table).toBe(true);
    const { rows: nulls } = await runSql<{ n: number }>(
      `select (select count(*) from chat_messages where team_id=$1 and context_authorization_epoch is null)
            + (select count(*) from chat_turn_runs where team_id=$1 and context_authorization_epoch is null)
            + (select count(*) from query_log where team_id=$1 and context_authorization_epoch is null) as n`,
      [seed.teamId]);
    expect(Number(nulls[0].n), "upgraded rows are left NULL — never stamped with an epoch").toBe(5);

    // ── Rows written under the contract: explicit 0, and a positive epoch. ─────────────────────────
    const epoch = await revocationEpoch(db(), seed.teamId);
    const modern = await conversation(seed, "modern thread");
    await stamp("chat_messages", await message(seed, modern, "user", "modern question"), 0);
    await stamp("chat_messages", await message(seed, modern, "assistant", "nebulith source-free answer"), 0);
    await stamp("chat_messages", await message(seed, modern, "assistant", "quasarvellum protected answer", [cited]), epoch);

    const thread = async (id: string) => (await getConversation(db(), owner, id))!.messages;
    const found = async (q: string) => (await searchConversations(db(), owner, q)).map((c) => c.id).sort();
    const assertHistoricalSuppressed = async () => {
      // The member's own question stays; the generated answer — text AND citations — does not.
      expect((await thread(legacy)).map((m) => [m.role, m.content])).toEqual([
        ["user", "historical question about obsidianquill"],
      ]);
      expect((await thread(legacy)).some((m) => (m.cited_item_ids ?? []).length > 0)).toBe(false);
      // A search matches the question's conversation, never through the answer text.
      expect(await found("Drive document")).toEqual([]);
      expect(await found("historical question")).toEqual([legacy]);
      // Runs: no partial, no final pointer to the hidden answer; the question (structure) stays.
      expect(await latestRun(db(), owner, legacy)).toMatchObject({
        status: "error", partial_text: "", final_message_id: null, question: "what is the ledger?",
      });
      expect(await latestRun(db(), owner, legacyPartial)).toMatchObject({ status: "error", partial_text: "" });
      expect(await recentTurns(db(), owner, legacy)).toEqual([]);
    };

    // Before any revocation: historical output is already uncertified; 0 and the current epoch read.
    await assertHistoricalSuppressed();
    expect((await thread(modern)).map((m) => m.content))
      .toEqual(["modern question", "nebulith source-free answer", "quasarvellum protected answer"]);
    expect(await found("quasarvellum")).toEqual([modern]);

    // A processed Drive revocation advances the barrier: the stale positive epoch disappears too.
    await advanceAuthorizationEpoch(seed.teamId);
    await assertHistoricalSuppressed();
    expect((await thread(modern)).map((m) => m.content)).toEqual(["modern question", "nebulith source-free answer"]);
    expect(await found("quasarvellum")).toEqual([]);
    expect(await found("nebulith")).toEqual([modern]);
    // A positive epoch that IS current after the revocation is readable again.
    const current = await revocationEpoch(db(), seed.teamId);
    await stamp("chat_messages", await message(seed, modern, "assistant", "zirconfold current answer"), current);
    expect((await thread(modern)).map((m) => m.content)).toContain("zirconfold current answer");

    // An unreadable epoch: only 0 survives; historical stays hidden, positive hides.
    probe.epochReadFails = true;
    await assertHistoricalSuppressed();
    expect((await thread(modern)).map((m) => m.content)).toEqual(["modern question", "nebulith source-free answer"]);

    // The upgraded query-log row stays NULL; no reader projects its preview (guarded by
    // test/guards/query-log-generated-text.test.ts).
    const { rows: preview } = await runSql<{ e: string | null }>(
      `select context_authorization_epoch::text as e from query_log where team_id=$1`, [seed.teamId]);
    expect(preview).toEqual([{ e: null }]);
  });
});

/**
 * AIO-1167 R88 — a legacy conversation's title is as uncertified as its historical answer.
 *
 * Before R76 the automatic title was generated from the question AND the answer, after the answer was
 * stored, so a secret present only in the answer could live on in `conversations.title`. List, detail and
 * search share one projection: a conversation holding ANY historical (NULL-provenance) answer shows the
 * title derived from its first question ("New chat" without one), and its raw title is never matched.
 */
describe("AIO-1167 R88: legacy answer-derived titles are projected, never exposed or matched", () => {
  it("list, detail and search expose only the question-derived title — before/after revocation and on read failures", async () => {
    const seed = await seedTeam();
    const owner = ownerOf(seed);
    const SECRET = "vermillionquorum";

    // ── Before the contract: the legacy writer stored the answer, then titled from question + answer. ──
    for (const table of TABLES) await runSql(`alter table ${table} drop column if exists context_authorization_epoch`, []);
    const question = "who signs off the treasury ledger?";
    const legacy = await conversation(seed, `Treasury ledger: ${SECRET} signs off`); // answer-derived title
    await message(seed, legacy, "user", question);
    await message(seed, legacy, "assistant", `${SECRET} signs off the treasury ledger each quarter`);
    const orphan = await conversation(seed, `Summary of ${SECRET} handoff`); // no user question survives
    await message(seed, orphan, "assistant", `${SECRET} handoff summary`);
    await runSql(MIGRATION, []);

    // ── Modern controls (written under the contract). ─────────────────────────────────────────────────
    const autoTitled = await conversation(seed, "Nebulith onboarding checklist"); // epoch-0 automatic title
    await stamp("chat_messages", await message(seed, autoTitled, "user", "what is the onboarding checklist?"), 0);
    await stamp("chat_messages", await message(seed, autoTitled, "assistant", "a source-free checklist"), 0);
    const manual = await conversation(seed, "untitled");
    await stamp("chat_messages", await message(seed, manual, "user", "a quick note"), 0);
    expect(await renameConversation(db(), owner, manual, "Pelagic manual title")).toBe(true);
    const protectedQuestion = "where is the halcyon budget?";
    const protectedConvo = await conversation(seed, deriveTitle(protectedQuestion)); // question-derived
    await stamp("chat_messages", await message(seed, protectedConvo, "user", protectedQuestion), 0);
    await stamp("chat_messages",
      await message(seed, protectedConvo, "assistant", "the halcyon budget lives in Drive"), await revocationEpoch(db(), seed.teamId));

    const titleOf = async (id: string) => (await listConversations(db(), owner)).find((c) => c.id === id)?.title;
    const found = async (q: string) => (await searchConversations(db(), owner, q)).map((c) => [c.id, c.title]);
    const assertProjected = async () => {
      expect(await titleOf(legacy)).toBe(deriveTitle(question));
      expect(await titleOf(orphan)).toBe("New chat");
      expect((await getConversation(db(), owner, legacy))?.title).toBe(deriveTitle(question));
      expect((await getConversation(db(), owner, orphan))?.title).toBe("New chat");
      expect(await found(SECRET), "text only the raw legacy title holds never matches").toEqual([]);
      expect(await found("Summary of"), "nor does any other raw-title-only text").toEqual([]);
      // A permitted match (the member's own question) returns the conversation — with the SAFE title.
      expect(await found("treasury")).toEqual([[legacy, deriveTitle(question)]]);
      // Controls: certified titles stay visible and searchable.
      expect(await titleOf(autoTitled)).toBe("Nebulith onboarding checklist");
      expect(await found("Nebulith")).toEqual([[autoTitled, "Nebulith onboarding checklist"]]);
      expect(await titleOf(manual)).toBe("Pelagic manual title");
      expect(await found("Pelagic")).toEqual([[manual, "Pelagic manual title"]]);
      expect(await titleOf(protectedConvo)).toBe(deriveTitle(protectedQuestion));
    };

    await assertProjected(); // before any revocation
    // Modern messages appended later never re-certify the legacy title.
    await stamp("chat_messages", await message(seed, legacy, "user", "and next quarter?"), 0);
    await stamp("chat_messages", await message(seed, legacy, "assistant", "a source-free reply"), 0);
    await assertProjected();
    await advanceAuthorizationEpoch(seed.teamId); // a processed Drive revocation
    await assertProjected();
    probe.epochReadFails = true; // the classification does not depend on the epoch
    await assertProjected();
    probe.epochReadFails = false;

    // A failed classification read never falls back to the raw title: the readers refuse.
    probe.titleClassificationFails = true;
    await expect(listConversations(db(), owner)).rejects.toThrow(/title classification/);
    await expect(getConversation(db(), owner, legacy)).rejects.toThrow(/title classification/);
    await expect(searchConversations(db(), owner, SECRET)).rejects.toThrow(/title classification/);
    probe.titleClassificationFails = false;
  });

  it("owner and archive isolation, ordering and limits are unchanged", async () => {
    const seed = await seedTeam();
    const owner = ownerOf(seed);
    const { rows: other } = await runSql<{ id: string }>(
      `insert into members(team_id, email, display_name, actor_handle, role, tier, status)
       values ($1, $2, 'Other', $3, 'member', 'team', 'active') returning id`,
      [seed.teamId, `other-${Date.now()}@t.local`, `other-${Date.now()}`]);
    const theirs = await runSql<{ id: string }>(
      `insert into conversations(team_id, member_id, title) values ($1,$2,'Someone else''s thread') returning id`,
      [seed.teamId, other[0].id]);
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) {
      const id = await conversation(seed, `Thread ${n}`);
      await stamp("chat_messages", await message(seed, id, "user", `question ${n}`), 0);
      await runSql(`update conversations set updated_at = now() + ($2 || ' seconds')::interval where id=$1`, [id, String(n)]);
      ids.push(id);
    }
    const archived = await conversation(seed, "Archived thread");
    expect(await archiveConversation(db(), owner, archived)).toBe(true);

    const listed = await listConversations(db(), owner);
    expect(listed.map((c) => c.id)).toEqual([...ids].reverse()); // newest-active first, own, unarchived
    expect(listed.map((c) => c.title)).toEqual(["Thread 2", "Thread 1", "Thread 0"]);
    expect((await listConversations(db(), owner, 2)).map((c) => c.id)).toEqual([ids[2], ids[1]]);
    expect(await getConversation(db(), owner, theirs.rows[0].id)).toBeNull();
    expect(await searchConversations(db(), owner, "Someone")).toEqual([]);
    expect(await searchConversations(db(), owner, "Archived")).toEqual([]);
  });
});
