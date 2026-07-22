import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMemberItems, getMemberAttribution } from "@/lib/attribution/health";
import { db, seedTeam, ingest, type Seed } from "./helpers";

/**
 * Spec: the per-person drill-down (`getMemberItems`) returns the ACTUAL items behind a per-person count —
 * scoped to one member (or the null = unattributed bucket), with the right `source`/`locked`/`signal`,
 * honoring a `source` filter, and reconciling with the `getMemberAttribution` chip counts. Real Postgres
 * (the signal comes from frontmatter the resolver parses; FakeSupabase can't stand in). See
 * docs/design/attribution-drilldown.md.
 */

async function seedItem(
  seed: Seed,
  opts: { source: string; memberId?: string | null; locked?: boolean; access?: "team" | "external"; frontmatter?: Record<string, unknown> }
): Promise<string> {
  const path = `${opts.source}/${randomUUID()}.md`;
  const { id } = await ingest(seed, {
    body: `body ${path}`,
    path,
    access: opts.access ?? "team",
    frontmatter: { source: opts.source, ...opts.frontmatter },
  });
  const patch: Record<string, unknown> = {};
  if (opts.memberId !== undefined && opts.memberId !== seed.memberId) patch.member_id = opts.memberId;
  if (opts.locked) patch.member_id_locked = true;
  if (Object.keys(patch).length) {
    const { error } = await db().from("items").update(patch).eq("id", id);
    if (error) throw new Error(`patch failed: ${error.message}`);
  }
  return id;
}

describe("attribution drill-down (real Postgres)", () => {
  it("returns a member's own items with source/locked/signal, honors the source filter, and reconciles with the counts", async () => {
    const seed = await seedTeam(); // human member "Tester"

    // A: git, attributed to Tester, NOT locked. The frontmatter lists an EDITOR first then the AUTHOR —
    //    the signal must be the role-ranked PRIMARY (author outranks editor), not raw parse order.
    const a = await seedItem(seed, {
      source: "git",
      frontmatter: {
        title: "My commit",
        authors: [
          { email: "editor@corp.com", role: "editor" },
          { email: "tester@corp.com", role: "author" },
        ],
      },
    });
    // B: notion, attributed to Tester but LOCKED (a deliberate correction) → signal suppressed even though
    //    the frontmatter still carries an author.
    const b = await seedItem(seed, {
      source: "notion",
      locked: true,
      frontmatter: { authors: [{ email: "someone@corp.com", role: "author" }] },
    });
    // C: notion, UNATTRIBUTED (member_id null) — belongs to the null bucket, not Tester.
    const c = await seedItem(seed, { source: "notion", memberId: null });
    // D: granola, attributed to Tester (a second source for the reconciliation check).
    const d = await seedItem(seed, { source: "granola" });

    const mine = await getMemberItems(seed.teamId, seed.memberId);
    const byId = Object.fromEntries(mine.map((i) => [i.id, i]));

    // Only Tester's items (A, B, D) — the unattributed C is excluded.
    expect(mine.map((i) => i.id).sort()).toEqual([a, b, d].sort());
    expect(byId[c]).toBeUndefined();

    // A: title from frontmatter, source from SOURCE_EXPR, the resolver's signal, not locked.
    expect(byId[a]).toMatchObject({ title: "My commit", source: "git", kind: "deliverable", locked: false, signal: "tester@corp.com" });
    // B: locked → the "manual" badge; signal SUPPRESSED (the override supersedes the frontmatter signal).
    expect(byId[b]).toMatchObject({ source: "notion", locked: true, signal: null });

    // The source filter narrows to just that person's notion items (only B; C is unattributed).
    const notion = await getMemberItems(seed.teamId, seed.memberId, { source: "notion" });
    expect(notion.map((i) => i.id)).toEqual([b]);

    // The null bucket is the unattributed items — C only.
    const unattributed = await getMemberItems(seed.teamId, null);
    expect(unattributed.map((i) => i.id)).toEqual([c]);

    // Reconciliation: the drill-down's per-source counts equal the chip counts (same SOURCE_EXPR).
    const counts = mine.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.source]: (acc[i.source] ?? 0) + 1 }), {});
    const tester = (await getMemberAttribution(seed.teamId)).find((m) => m.memberId === seed.memberId)!;
    const chipCounts = Object.fromEntries(tester.bySource.map((s) => [s.source, s.items]));
    expect(counts).toEqual(chipCounts);
  });

  it("resolves each item's PROVENANCE against the real identity mappings — method, resolvesTo, and drift", async () => {
    const seed = await seedTeam(); // member "Tester"

    // A second real member with a known roster email → an author signal for THEM resolves via byEmail.
    const { error: oErr } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: "other@corp.com",
        display_name: "Other Person",
        actor_handle: `other-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "team",
        status: "active",
      });
    if (oErr) throw new Error(`seed other failed: ${oErr.message}`);

    // An explicit git-author ALIAS for Tester (the member_emails path) → resolves to Tester via email.
    const { error: aErr } = await db()
      .from("member_emails")
      .insert({ team_id: seed.teamId, email: "tester-git@noreply.example", member_id: seed.memberId });
    if (aErr) throw new Error(`alias insert failed: ${aErr.message}`);

    // P: attributed to Tester, author = Tester's git alias → email mapping, resolves to Tester, NO drift.
    const p = await seedItem(seed, { source: "git", frontmatter: { authors: [{ email: "tester-git@noreply.example", role: "author" }] } });
    // Q: UNATTRIBUTED, but the author signal resolves to Other → the "should be Other's" drift flag.
    const q = await seedItem(seed, { source: "notion", memberId: null, frontmatter: { authors: [{ email: "other@corp.com", role: "author" }] } });
    // R: EXTERNAL-access item whose (untrusted) frontmatter names a team member → resolution SUPPRESSED,
    //    so we never surface a "→ Other?" badge that would invite crediting client content to a member
    //    (the exact misattribution reattributeItems excludes external rows to prevent).
    const r = await seedItem(seed, { source: "notion", access: "external", frontmatter: { authors: [{ email: "other@corp.com", role: "author" }] } });

    const mine = Object.fromEntries((await getMemberItems(seed.teamId, seed.memberId)).map((i) => [i.id, i]));
    expect(mine[p]).toMatchObject({ signal: "tester-git@noreply.example", method: "email", resolvesToName: "Tester", mismatch: false });
    // R is attributed to Tester (the ingesting member) but external → no resolution surfaced.
    expect(mine[r]).toMatchObject({ signal: null, method: "none", resolvesToName: null, mismatch: false });

    const nulls = Object.fromEntries((await getMemberItems(seed.teamId, null)).map((i) => [i.id, i]));
    expect(nulls[q]).toMatchObject({ method: "email", resolvesToName: "Other Person", mismatch: true });
  });
});
