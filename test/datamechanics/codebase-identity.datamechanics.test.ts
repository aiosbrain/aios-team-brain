import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ingestCodebaseScan } from "@/lib/codebases/ingest";
import { getCodebaseDetail } from "@/lib/metrics/codebases";
import { addAuthorAlias } from "@/lib/admin/aliases";
import { createMember } from "@/lib/admin/members";
import { codebaseScanPayloadSchema } from "@/lib/api/schemas";
import { db, seedTeam } from "./helpers";

const NOREPLY = "123+john@users.noreply.github.com";

function scan(slug: string, contributions: { author_key: string; author_email: string; day: string; commits: number }[]) {
  return codebaseScanPayloadSchema.parse({
    codebase: { slug, full_name: `acme/${slug}`, open_issues: 0 },
    metrics: {
      head_sha: "a".repeat(40), window_days: 90, commits_window: 8, ai_commits_window: 8,
      active_days: 3, days_since_last_commit: 1,
    },
    contributions,
    issues: [],
  });
}

async function ingest(seed: { teamId: string; memberId: string }, payload: ReturnType<typeof scan>) {
  return ingestCodebaseScan(db(), { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() }, payload);
}

describe("codebase contributor identity (real Postgres)", () => {
  it("aliasing collapses two git identities into one mapped contributor row (with avatar)", async () => {
    const seed = await seedTeam();
    const john = await createMember(db(), seed.teamId, {
      email: "john@john.test", displayName: "John Ellison", actorHandle: "john", role: "admin",
    });
    await db().from("members").update({ avatar_url: "https://avatars/x.png", github_login: "john" }).eq("id", john.id);

    const slug = `repo-${randomUUID().slice(0, 6)}`;
    await ingest(seed, scan(slug, [
      { author_key: "john@john.test", author_email: "john@john.test", day: "2026-06-10", commits: 5 },
      { author_key: NOREPLY, author_email: NOREPLY, day: "2026-06-10", commits: 3 },
    ]));

    // Before aliasing: the noreply identity is a separate unmapped row.
    let detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.contributors.length).toBe(2);
    expect(detail?.contributors.some((c) => c.member_id === null)).toBe(true);

    // After aliasing the noreply identity → one mapped row, avatar surfaced.
    const r = await addAuthorAlias(db(), seed.teamId, john.id, NOREPLY);
    expect(r.backfilled).toBe(1);
    detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.contributors.length).toBe(1);
    const row = detail!.contributors[0];
    expect(row.member_id).toBe(john.id);
    expect(row.member_name).toBe("John Ellison");
    expect(row.avatar_url).toBe("https://avatars/x.png");
    expect(row.commits).toBe(8); // 5 + 3 collapsed
  });

  it("the same alias cannot map to two members; remap requires force", async () => {
    const seed = await seedTeam();
    const a = await createMember(db(), seed.teamId, { email: "a@x.test", displayName: "A", actorHandle: "aa", role: "member" });
    const b = await createMember(db(), seed.teamId, { email: "b@x.test", displayName: "B", actorHandle: "bb", role: "member" });

    const first = await addAuthorAlias(db(), seed.teamId, a.id, NOREPLY);
    expect(first.aliased).toBe(true);

    // claiming the same alias for B without force → collision, no change
    const collide = await addAuthorAlias(db(), seed.teamId, b.id, NOREPLY);
    expect(collide.collisions).toBeGreaterThan(0);
    const { data: stillA } = await db()
      .from("member_emails").select("member_id").eq("team_id", seed.teamId).eq("email", NOREPLY).maybeSingle();
    expect((stillA as { member_id: string }).member_id).toBe(a.id);

    // with force → remapped to B
    const forced = await addAuthorAlias(db(), seed.teamId, b.id, NOREPLY, { force: true });
    expect(forced.aliased).toBe(true);
    const { data: nowB } = await db()
      .from("member_emails").select("member_id").eq("team_id", seed.teamId).eq("email", NOREPLY).maybeSingle();
    expect((nowB as { member_id: string }).member_id).toBe(b.id);
  });

  it("does not silently re-point contributions already mapped to another member", async () => {
    const seed = await seedTeam();
    await createMember(db(), seed.teamId, { email: "a@x.test", displayName: "A", actorHandle: "aa", role: "member" });
    const b = await createMember(db(), seed.teamId, { email: "b@x.test", displayName: "B", actorHandle: "bb", role: "member" });
    const slug = `repo-${randomUUID().slice(0, 6)}`;
    await ingest(seed, scan(slug, [{ author_key: "a@x.test", author_email: "a@x.test", day: "2026-06-10", commits: 4 }]));
    // contribution is mapped to A (matches A's email). Try to claim it for B.
    const noForce = await addAuthorAlias(db(), seed.teamId, b.id, "a@x.test");
    expect(noForce.collisions).toBeGreaterThan(0);
    expect(noForce.remapped).toBe(0);
    const forced = await addAuthorAlias(db(), seed.teamId, b.id, "a@x.test", { force: true });
    expect(forced.remapped).toBeGreaterThan(0);
  });
});
