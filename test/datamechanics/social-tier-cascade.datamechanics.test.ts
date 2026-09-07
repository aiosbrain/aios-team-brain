import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createOpportunity,
  createPlan,
  addVariant,
  listOpportunities,
  narrowSocialChainForItem,
} from "@/lib/social/store";
import { Client } from "pg";
import { ingestItem } from "@/lib/ingest";
import { PgClient } from "@/lib/db/pg/client";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { db, ingest, seedTeam, sha } from "./helpers";

/**
 * Spec (Pass-1 review, Wave 0 follow-on): the social chain's evidence→tier ceiling must survive a
 * RECLASSIFICATION, not just hold at create time.
 *
 * `lib/social/tier`'s invariant is that an opportunity may be at most as public as its most-restrictive
 * evidence item — because its title/summary, and every plan/variant/publication derived from it, are
 * written FROM that item's content. `assertEvidenceTier` enforces it in `createOpportunity` and nowhere
 * else, so when an evidence item is later narrowed external→team the existing `external` opportunity
 * silently violates the invariant and keeps serving that derived text to external principals.
 *
 * Unlike the caches (4h/5min TTL) this chain is PERSISTENT: nothing expires it and nothing recomputes
 * the ceiling, so the exposure is permanent. There is no RLS backstop (CLAUDE.md §5).
 */

/** The whole descendant chain's stored tier, so a test asserts propagation rather than one row. */
async function chainAccess(teamId: string) {
  const pick = async (table: string) => {
    const { data } = await db().from(table).select("access").eq("team_id", teamId);
    return ((data ?? []) as { access: string }[]).map((r) => r.access);
  };
  return {
    opportunities: await pick("social_opportunities"),
    plans: await pick("content_plans"),
    variants: await pick("content_variants"),
    approvals: await pick("content_approvals"),
    media: await pick("media_assets"),
    publications: await pick("social_publications"),
    analytics: await pick("publication_analytics"),
  };
}

/** The three tables below the variant, each owned by a different module. Seeded directly because their
 *  creation paths need a provider/generation round-trip this spec doesn't care about. */
async function seedBelowVariant(teamId: string, variantId: string, access: "team" | "external") {
  await db()
    .from("content_approvals")
    .insert({ team_id: teamId, variant_id: variantId, access, status: "pending" });
  await db()
    .from("media_assets")
    .insert({ team_id: teamId, variant_id: variantId, access, provider: "test", model: "m", data_base64: "x" });
  const { data: pub } = await db()
    .from("social_publications")
    .insert({ team_id: teamId, variant_id: variantId, access })
    .select("id")
    .single();
  await db()
    .from("publication_analytics")
    .insert({ team_id: teamId, publication_id: (pub as { id: string }).id, access });
}

async function seedChain(
  teamId: string,
  access: "team" | "external",
  evidenceItemId: string | undefined,
  dedupKey: string
) {
  const opp = await createOpportunity(db(), teamId, {
    access,
    sourceType: "item",
    title: "What we learned shipping the client portal",
    summary: "derived from the evidence item's content",
    evidence: evidenceItemId ? [{ itemId: evidenceItemId, path: "docs/spec.md" }] : [],
    dedupKey,
  });
  const plan = await createPlan(db(), teamId, opp.id, { objective: "thought leadership" });
  const variant = await addVariant(db(), teamId, plan.id, {
    platform: "x",
    format: "text",
    body: "a post quoting the spec",
  });
  await seedBelowVariant(teamId, variant.id, access);
  return { opp, plan, variant };
}

describe("social chain follows a narrowed evidence item (real Postgres)", () => {
  it("narrows the opportunity AND its whole derived chain when its evidence item goes external→team", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, {
      kind: "deliverable",
      path: "docs/spec.md",
      body: "the client-visible spec",
      access: "external",
    });
    await seedChain(seed.teamId, "external", item.id, "opp-evidence");

    // Before: legitimately external — the evidence was external, so the ceiling allowed it.
    expect(await chainAccess(seed.teamId)).toEqual({
      opportunities: ["external"],
      plans: ["external"],
      variants: ["external"],
      approvals: ["external"],
      media: ["external"],
      publications: ["external"],
      analytics: ["external"],
    });

    // The evidence item is reclassified upstream WITHOUT touching its prose (the unchanged fast path).
    await ingest(seed, {
      kind: "deliverable",
      path: "docs/spec.md",
      body: "the client-visible spec",
      access: "team",
    });

    // After: the ceiling dropped, so the opportunity and everything derived from it must drop with it.
    expect(await chainAccess(seed.teamId)).toEqual({
      opportunities: ["team"],
      plans: ["team"],
      variants: ["team"],
      approvals: ["team"],
      media: ["team"],
      publications: ["team"],
      analytics: ["team"],
    });
  });

  it("finishes the walk after a crash partway through it (idempotent, not anchored on the current tier)", async () => {
    // The statements autocommit — there is no enclosing transaction — so a mid-walk failure is real:
    // the opportunity narrows, then the plan update throws. If the candidate scan were anchored on
    // `access = 'external'` AT THE OPPORTUNITY (the obvious way to write it), the retry would find
    // nothing citing this item, return 0, and leave the plan and variant — the actual derived post body,
    // still publishable — at `external` FOREVER. That is the same permanent over-exposure this whole
    // cascade exists to remove, reintroduced by the cascade's own failure path.
    //
    // Simulated here by narrowing ONLY the opportunity (the exact state a crash at that point leaves)
    // and then asking the cascade to finish.
    const seed = await seedTeam();
    const item = await ingest(seed, {
      kind: "deliverable",
      path: "docs/spec.md",
      body: "the client-visible spec",
      access: "external",
    });
    const { opp } = await seedChain(seed.teamId, "external", item.id, "opp-crash");
    await db()
      .from("social_opportunities")
      .update({ access: "team" })
      .eq("team_id", seed.teamId)
      .eq("id", opp.id);

    const moved = await narrowSocialChainForItem(db(), seed.teamId, item.id);

    expect(await chainAccess(seed.teamId)).toEqual({
      opportunities: ["team"],
      plans: ["team"],
      variants: ["team"],
      approvals: ["team"],
      media: ["team"],
      publications: ["team"],
      analytics: ["team"],
    });
    // Nothing MOVED at the opportunity level this pass, so the audit stream stays quiet rather than
    // emitting a duplicate `social.tier_narrowed` for a chain that was already recorded.
    expect(moved).toBe(0);
  });

  it("records the remediation even when the chain writes then fail", async () => {
    // The observability half of the crash path above. With the audit emitted LAST, the dominant crash
    // window (opportunity narrowed, plan update throws) left NO `social.tier_narrowed` row at all — and
    // the retry, seeing the opportunity already at `team`, had nothing left to record. The chain healed
    // silently, so the one durable trace that internal content had been retracted from a client-facing
    // surface was gone forever. A leak-remediation trail has to over-record, not under-record.
    const seed = await seedTeam();
    const item = await ingest(seed, {
      kind: "deliverable",
      path: "docs/spec.md",
      body: "the client-visible spec",
      access: "external",
    });
    await seedChain(seed.teamId, "external", item.id, "opp-audit");

    const raw = new Client({ connectionString: process.env.DATABASE_URL });
    await raw.connect();
    await raw.query(
      `create or replace function _fail_plans() returns trigger as $$ begin raise exception 'simulated plan failure'; end $$ language plpgsql;
       create trigger _t_fail_plans before update on content_plans for each row execute function _fail_plans();`
    );
    try {
      await expect(narrowSocialChainForItem(db(), seed.teamId, item.id)).rejects.toThrow();
    } finally {
      await raw
        .query(`drop trigger if exists _t_fail_plans on content_plans; drop function if exists _fail_plans();`)
        .catch(() => {});
      await raw.end().catch(() => {});
    }

    const { data } = await db()
      .from("audit_log")
      .select("action")
      .eq("team_id", seed.teamId)
      .eq("action", "social.tier_narrowed");
    expect((data ?? []).length).toBe(1); // recorded despite the failure that followed
  });

  it("A13-13: ingest-bound cascade failure rolls back the chain and early audit; retry commits both", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, {
      kind: "deliverable",
      path: "docs/atomic-social.md",
      body: "external evidence",
      access: "external",
    });
    await seedChain(seed.teamId, "external", item.id, "opp-atomic-ingest");

    const raw = new Client({ connectionString: process.env.DATABASE_URL });
    await raw.connect();
    await raw.query(
      `create or replace function _a13_fail_plans() returns trigger as $$ begin raise exception 'a13 plan failure'; end $$ language plpgsql;
       create trigger _a13_t_fail_plans before update on content_plans for each row execute function _a13_fail_plans();`
    );
    try {
      await expect(
        ingest(seed, {
          kind: "deliverable",
          path: "docs/atomic-social.md",
          body: "external evidence",
          access: "team",
        })
      ).rejects.toThrow(/a13 plan failure/);
      const { data: stored } = await db()
        .from("items")
        .select("access")
        .eq("team_id", seed.teamId)
        .eq("id", item.id)
        .single();
      expect((stored as { access: string }).access).toBe("external");
      expect(await chainAccess(seed.teamId)).toEqual({
        opportunities: ["external"],
        plans: ["external"],
        variants: ["external"],
        approvals: ["external"],
        media: ["external"],
        publications: ["external"],
        analytics: ["external"],
      });
      const { data: audits } = await db()
        .from("audit_log")
        .select("id")
        .eq("team_id", seed.teamId)
        .eq("action", "social.tier_narrowed");
      expect(audits ?? []).toHaveLength(0);
    } finally {
      await raw
        .query(
          `drop trigger if exists _a13_t_fail_plans on content_plans; drop function if exists _a13_fail_plans();`
        )
        .catch(() => {});
      await raw.end().catch(() => {});
    }

    await ingest(seed, {
      kind: "deliverable",
      path: "docs/atomic-social.md",
      body: "external evidence",
      access: "team",
    });
    expect((await chainAccess(seed.teamId)).opportunities).toEqual(["team"]);
    const { data: audits } = await db()
      .from("audit_log")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("action", "social.tier_narrowed");
    expect(audits ?? []).toHaveLength(1);
  });

  it("A13-13: an actual social audit INSERT deadlock is savepoint-local and the bound cascade commits once", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, {
      kind: "deliverable",
      path: "docs/audit-savepoint-social.md",
      body: "external evidence for audit recovery",
      access: "external",
    });
    await seedChain(seed.teamId, "external", item.id, "opp-audit-savepoint");
    let attempts = 0;
    let fired = 0;
    const faulted = new PgClient({
      decorateSessionExecutor: (execute) => {
        attempts++;
        return async <T>(text: string, params: unknown[] = []) => {
          if (fired === 0 && /^INSERT INTO audit_log /i.test(text.replace(/\s+/g, " ").trim())) {
            fired++;
            await execute(
              "do $a13$ begin raise exception 'social audit deadlock' using errcode = '40P01'; end $a13$"
            );
          }
          return execute<T>(text, params);
        };
      },
    });
    const body = "external evidence for audit recovery";
    const result = await ingestItem(
      faulted,
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
      {
        project: "acme",
        kind: "deliverable",
        actor: "tester",
        frontmatter: {},
        path: "docs/audit-savepoint-social.md",
        body,
        content_sha256: sha(body),
      },
      "team"
    );

    expect(result.accessChanged).toBe(true);
    expect(fired, "the social.tier_narrowed audit INSERT fault fired").toBe(1);
    expect(attempts, "the recovered audit deadlock did not replay ingest").toBe(1);
    expect(await chainAccess(seed.teamId)).toEqual({
      opportunities: ["team"],
      plans: ["team"],
      variants: ["team"],
      approvals: ["team"],
      media: ["team"],
      publications: ["team"],
      analytics: ["team"],
    });
    const { data: missedAudit } = await db()
      .from("audit_log")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("action", "social.tier_narrowed");
    expect(missedAudit ?? []).toHaveLength(0);
  });

  it.each([
    { pathKind: "unchanged-body", changed: false },
    { pathKind: "changed-body", changed: true },
  ])(
    "A13-08/13: settled no-widening refusal performs no inherited/social cascade ($pathKind)",
    async ({ pathKind, changed }) => {
      const seed = await seedTeam();
      const boot = await ensureAccessBootstrap(db(), seed.teamId);
      if (!boot.ok) throw new Error(`bootstrap fixture failed: ${boot.error}`);
      const originalBody = `external evidence for ${pathKind}`;
      const path = `docs/no-widening-social-${pathKind}.md`;
      const item = await ingest(seed, {
        kind: "deliverable",
        path,
        body: originalBody,
        access: "external",
      });
      await seedChain(seed.teamId, "external", item.id, `opp-no-widening-${pathKind}`);
      const { data: general, error: projectError } = await db()
        .from("projects")
        .select("id")
        .eq("team_id", seed.teamId)
        .eq("kind", "system")
        .eq("slug", "general")
        .single();
      const { data: externalGroup, error: groupError } = await db()
        .from("groups")
        .select("id")
        .eq("team_id", seed.teamId)
        .eq("slug", "external")
        .eq("is_builtin", true)
        .single();
      if (projectError || groupError || !general || !externalGroup) {
        throw new Error("no-widening fixture topology missing");
      }
      const { error: grantError } = await db().from("project_groups").insert({
        team_id: seed.teamId,
        project_id: general.id,
        group_id: externalGroup.id,
      });
      if (grantError) throw new Error(`invalid topology fixture failed: ${grantError.message}`);

      let cascadeWrites = 0;
      const traced = new PgClient({
        decorateSessionExecutor: (execute) => async <T>(text: string, params: unknown[] = []) => {
          const normalized = text.replace(/\s+/g, " ").trim();
          if (
            /^UPDATE (tasks|extracted_facts|stakeholder_mentions|social_opportunities|content_plans|content_variants|content_approvals|media_assets|social_publications|publication_analytics) /i.test(
              normalized
            )
          ) {
            cascadeWrites++;
          }
          return execute<T>(text, params);
        },
      });
      const attemptedBody = changed ? `${originalBody}\nrejected edit` : originalBody;
      await expect(
        ingestItem(
          traced,
          { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
          {
            project: "acme",
            kind: "deliverable",
            actor: "tester",
            frontmatter: {},
            path,
            body: attemptedBody,
            content_sha256: sha(attemptedBody),
          },
          "team"
        )
      ).rejects.toThrow(/context gate refusal|no-widening/i);

      expect(cascadeWrites, "early desired-audience gate runs before expensive cascade writes").toBe(0);
      const { data: stored } = await db()
        .from("items")
        .select("access, body")
        .eq("team_id", seed.teamId)
        .eq("id", item.id)
        .single();
      expect(stored).toMatchObject({ access: "external", body: originalBody });
      expect(await chainAccess(seed.teamId)).toEqual({
        opportunities: ["external"],
        plans: ["external"],
        variants: ["external"],
        approvals: ["external"],
        media: ["external"],
        publications: ["external"],
        analytics: ["external"],
      });
    }
  );

  it("stops serving it on the external read path — the observable leak", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, {
      kind: "deliverable",
      path: "docs/spec.md",
      body: "the client-visible spec",
      access: "external",
    });
    await seedChain(seed.teamId, "external", item.id, "opp-read");
    // ENFB-4: the viewer set always holds the evidence item, so the TIER CASCADE stays this
    // arm's only discriminator (the membership gate has its own pins in enfb4-social.dm).
    const vis: ReadonlySet<string> = new Set([item.id]);
    expect(await listOpportunities(db(), seed.teamId, "external", 50, vis)).toHaveLength(1);

    await ingest(seed, {
      kind: "deliverable",
      path: "docs/spec.md",
      body: "the client-visible spec",
      access: "team",
    });

    // The thing that actually matters: an external principal can no longer read the derived text.
    expect(await listOpportunities(db(), seed.teamId, "external", 50, vis)).toHaveLength(0);
    expect(await listOpportunities(db(), seed.teamId, "team", 50, vis)).toHaveLength(1); // still there internally
  });

  it("leaves an opportunity citing a DIFFERENT item alone", async () => {
    // The cascade must be evidence-scoped, not team-wide — narrowing one doc must not retract unrelated
    // client-facing content.
    const seed = await seedTeam();
    const narrowed = await ingest(seed, { kind: "deliverable", path: "docs/a.md", body: "doc a", access: "external" });
    const untouched = await ingest(seed, { kind: "deliverable", path: "docs/b.md", body: "doc b", access: "external" });
    await seedChain(seed.teamId, "external", narrowed.id, "opp-a");
    await seedChain(seed.teamId, "external", untouched.id, "opp-b");

    await ingest(seed, { kind: "deliverable", path: "docs/a.md", body: "doc a", access: "team" });

    const { data } = await db()
      .from("social_opportunities")
      .select("dedup_key, access")
      .eq("team_id", seed.teamId);
    const byKey = Object.fromEntries(
      ((data ?? []) as { dedup_key: string; access: string }[]).map((r) => [r.dedup_key, r.access])
    );
    expect(byKey["opp-a"]).toBe("team");
    expect(byKey["opp-b"]).toBe("external"); // unrelated evidence → untouched
  });

  it("does NOT widen an opportunity when its evidence item is widened team→external", async () => {
    // The invariant is a CEILING, not equality. A team-tier item becoming external raises what WOULD be
    // permitted, but publishing internal-derived content externally is a human decision — auto-widening
    // would silently make internal narrative public.
    const seed = await seedTeam();
    const item = await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "internal spec", access: "team" });
    await seedChain(seed.teamId, "team", item.id, "opp-widen");

    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "internal spec", access: "external" });

    expect(await chainAccess(seed.teamId)).toEqual({
      opportunities: ["team"],
      plans: ["team"],
      variants: ["team"],
      approvals: ["team"],
      media: ["team"],
      publications: ["team"],
      analytics: ["team"],
    });
  });

  it("is a no-op for an opportunity already at the narrower tier", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec", access: "external" });
    await seedChain(seed.teamId, "team", item.id, "opp-noop");

    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec", access: "team" });

    expect(await chainAccess(seed.teamId)).toEqual({
      opportunities: ["team"],
      plans: ["team"],
      variants: ["team"],
      approvals: ["team"],
      media: ["team"],
      publications: ["team"],
      analytics: ["team"],
    });
  });
});
