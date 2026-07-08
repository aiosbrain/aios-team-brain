import { beforeEach, describe, expect, it } from "vitest";
import { retrieve } from "@/lib/query/retrieve";
import { db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * ADVERSARIAL — the context-management system under a MULTI-CHANNEL corpus (real Postgres).
 *
 * Today the brain ingests ~one Slack channel, so the retrieval caps (FTS 20 / recency 8 /
 * decisions 50 / tasks 80), the lack of relevance ranking (FTS is a bare `@@` filter — no
 * `ts_rank ORDER BY`), the OR-recall bias, and the `grounded = ftsHits>0` signal all behave fine.
 * This suite simulates the near-future world of many busy channels and asserts, to the observable
 * retrieval outcome, WHERE those choices break down.
 *
 * Convention (CLAUDE.md §1): each test asserts the DESIRED behavior. Ones we get right are green
 * `it()`. Confirmed gaps assert the desired behavior and are `it.fails()` — green today, they flip
 * RED the moment the gap is fixed, which is the signal to promote them to `it()`. Nothing here is a
 * characterization test: every assertion is the product contract, not "whatever the code does now".
 *
 * The companion pure-logic probes (short-token drop, OR-vs-AND) live in test/query-adversarial.
 */

let seed: Seed;

/** Ingest an item on a given channel (path prefix = channel, à la the Data page). */
async function post(channel: string, name: string, body: string, access: "team" | "external" = "team") {
  const source = channel.split("/")[0];
  return ingest(seed, { kind: "transcript", path: `${channel}/${name}.md`, body, access, frontmatter: { source } });
}

/** Retrieve and return just the source paths (the observable "what context did we pull" outcome). */
async function paths(question: string, tier: "team" | "external" = "team"): Promise<string[]> {
  const ctx = await retrieve(db(), seed.teamId, tier, question);
  return ctx.sources.map((s) => s.path);
}

/** A project row to hang directly-seeded tasks/decisions off of (both require project_id). */
async function makeProject(slug: string): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug, name: slug })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed project failed: ${error?.message}`);
  return (data as { id: string }).id;
}

describe("multi-channel adversarial retrieval (real Postgres)", () => {
  beforeEach(async () => {
    seed = await seedTeam();
  });

  // ── STRENGTHS — what the system handles correctly even across channels ───────────────────────

  it("STRENGTH: a specific keyword hit survives noise from other busy channels", async () => {
    // The common, healthy case: one clearly-relevant doc amid unrelated chatter on other channels.
    await post("slack/security", "ssrf", "The SSRF vulnerability in the image proxy was patched with strict input validation.");
    for (let i = 0; i < 15; i++) {
      await post("slack/random", `chatter-${i}`, `Lunch plans and parking notes number ${i}; nothing technical here.`);
    }
    expect(await paths("SSRF image proxy vulnerability")).toContain("slack/security/ssrf.md");
  });

  it("STRENGTH: a 2-char-acronym query now retrieves its doc end-to-end (Gap #1 fixed)", async () => {
    // The only terms shared between question and doc are the acronyms CI + S3. Before the fix
    // toOrQuery dropped every <3-char token, so the query searched on "happened" alone (absent from
    // the doc) and never found it; the doc is buried under newer chatter so recency can't save it.
    await post("slack/eng", "ci-outage", "The CI pipeline broke on the S3 upload step; reverted the change.");
    for (let i = 0; i < 10; i++) {
      await post("slack/random", `n${i}`, `Lunch and parking note ${i}; nothing technical.`);
    }
    expect(await paths("what happened with CI and S3?")).toContain("slack/eng/ci-outage.md");
  });

  it("STRENGTH: ts_rank puts the most-specific item into the capped window (Gap #2 fixed)", async () => {
    // 25 weak items across channels each match ONE query term ("migration"); one target matches five.
    // The target is buried under 8 newer filler items so recency can't rescue it — its ONLY path in
    // is ranked FTS. Before Gap #2, FTS was an unordered `@@` filter, so the target (26th of 26
    // matches, capped at 20) could be dropped; now ts_rank orders it #1 so it's always retrieved.
    for (let i = 0; i < 25; i++) {
      await post(`slack/ch${i % 6}`, `weak-${i}`, `General migration reminder ${i}: nothing specific to report today.`);
    }
    await post("slack/payments", "target", "Payments migration: the Stripe webhook cutover and rollback plan were finalized.");
    for (let i = 0; i < 8; i++) {
      await post("slack/random", `newer-${i}`, `Fresh unrelated chatter ${i}: lunch and parking.`);
    }
    expect(await paths("payments migration Stripe webhook cutover rollback")).toContain("slack/payments/target.md");
  });

  it("STRENGTH: tier isolation holds across every channel (external sees zero team content)", async () => {
    // The one invariant that MUST NOT degrade at scale: an external principal never sees team channels.
    for (const ch of ["slack/eng", "slack/payments", "slack/design", "slack/leadership", "slack/random"]) {
      await post(ch, "note", `Internal ${ch} planning: roadmap, headcount, and vendor pricing details.`, "team");
    }
    await post("slack/clientshare", "note", "Shared status update for the client: milestone 2 is on track.", "external");

    const ext = await retrieve(db(), seed.teamId, "external", "planning roadmap pricing status update");
    const leaked = ext.sources.filter((s) => !s.path.startsWith("slack/clientshare/"));
    expect(leaked, `team content leaked to external: ${leaked.map((s) => s.path).join(", ")}`).toEqual([]);
  });

  // ── GAPS — failure modes that only bite once many channels are live ──────────────────────────

  it("STRENGTH: a single specific item amid same-term noise is still retrieved (recency net)", async () => {
    // 21 low-signal items across channels all mention "scheduled"; one specific target matching 3
    // query terms is posted last. FTS is unranked and capped at 20, so it does NOT prioritize the
    // target — but the recency-8 fallback (newest-first) catches it because it's the most recent.
    // Verified-true finding: for a SINGLE relevant item the recency net (or low-rowid FTS order)
    // reliably protects it. The failure only appears when MANY relevant items compete for the caps
    // AND the target is neither newest nor first-scanned — see the "broad-but-legitimate" gap below.
    for (let i = 0; i < 21; i++) {
      await post(`slack/ch${i % 7}`, `weak-${i}`, `Weekly sync ${i}: the standup is scheduled as usual, nothing else to report.`);
    }
    await post("slack/incidents", "target", "The scheduled security review found a critical auth bypass in the login flow.");
    expect(await paths("scheduled security review")).toContain("slack/incidents/target.md");
  });

  it.fails("GAP: a broad-but-legitimate query matches more items than the caps allow, unranked", async () => {
    // Across 6 channels, 50 genuinely on-topic items about the payments migration. The unique-source
    // ceiling is ~28 (FTS 20 + recency 8), so retrieval returns a bounded, UNRANKED subset — and with
    // no ts_rank there's no guarantee it's the most relevant ~28. "Summarize the payments migration"
    // then silently sees roughly half the real evidence. Desired: full recall for a topic this focused
    // (or at least a *ranked* best-N, so what's dropped is provably the least relevant).
    const posted: string[] = [];
    for (let i = 0; i < 50; i++) {
      await post(`slack/ch${i % 6}`, `payments-${i}`, `Payments migration note ${i}: Stripe webhook cutover step ${i} discussed.`);
      posted.push(`slack/ch${i % 6}/payments-${i}.md`);
    }
    const got = new Set(await paths("payments migration Stripe webhook cutover"));
    const missing = posted.filter((p) => !got.has(p));
    expect(missing, `${missing.length}/50 on-topic items were dropped by the caps`).toEqual([]);
  });

  it("STRENGTH: false grounding fixed — an incidental common term does NOT ground an absent topic (Gap #3)", async () => {
    // Many channels post routine "update" messages. A question about something NEVER ingested
    // (Helsinki datacenter migration) shares the stemmed term "updat" with that chatter. The old
    // signal (any FTS hit) flipped grounded=true → confabulation risk. The IDF signal sees that
    // "update" is corpus-common while helsinki/datacenter/migration match nothing → grounded=false.
    for (let i = 0; i < 12; i++) {
      await post(`slack/ch${i % 6}`, `daily-${i}`, `Daily update ${i}: posted a quick update to the channel, all normal.`);
    }
    const ctx = await retrieve(db(), seed.teamId, "team", "any updates on the Helsinki datacenter migration?");
    expect(ctx.grounded).toBe(false);
  });

  it("STRENGTH: a SPECIFIC single-term query stays grounded amid common-word noise (Gap #3 no regression)", async () => {
    // The danger of any naive grounding fix: rejecting a specific single-term query. "SSRF" is one
    // term but rare (df=1) → must stay grounded even though the corpus is mostly common "update" chatter.
    for (let i = 0; i < 12; i++) {
      await post(`slack/ch${i % 6}`, `daily-${i}`, `Daily update ${i}: routine status, nothing notable.`);
    }
    await post("slack/security", "ssrf", "The SSRF vulnerability in the image proxy was patched.");
    const ctx = await retrieve(db(), seed.teamId, "team", "was the SSRF issue fixed?");
    expect(ctx.grounded).toBe(true);
    expect(ctx.sources.some((s) => s.path === "slack/security/ssrf.md")).toBe(true);
  });

  it("STRENGTH: an all-common-term query still grounds on real matches (no over-abstain)", async () => {
    // If every query term is corpus-common, the IDF signal falls back to "any FTS hit" so a legit
    // "what's the latest update?" isn't wrongly forced to abstain.
    for (let i = 0; i < 6; i++) {
      await post(`slack/ch${i}`, `update-${i}`, `Weekly update ${i}: the team shipped features and fixed bugs.`);
    }
    const ctx = await retrieve(db(), seed.teamId, "team", "what are the latest updates?");
    expect(ctx.grounded).toBe(true);
  });

  it.fails("GAP: no channel scoping — a channel-qualified query still bleeds in other channels", async () => {
    // "Atlas" means different things in different channels: a project in #eng, a vendor in #sales.
    // The user scopes explicitly ("...in the sales channel"), but retrieval has no channel filter —
    // path prefixes aren't a query dimension — so the #eng Atlas bleeds in. Desired: sales-only.
    await post("slack/eng", "atlas", "Project Atlas: refactoring the retrieval layer to add reranking.");
    await post("slack/sales", "atlas", "Atlas Corp (vendor) sent the renewal quote for the analytics contract.");
    const got = await paths("what's the latest on Atlas in the sales channel?");
    const engBleed = got.filter((p) => p.startsWith("slack/eng/"));
    expect(engBleed, `eng-channel Atlas bled into a sales-scoped query: ${engBleed.join(", ")}`).toEqual([]);
  });

  it.fails("GAP: task aggregation truncates — 'how many open tasks' undercounts past the 80 cap", async () => {
    // A multi-channel org easily has >80 live tasks. The structured-context task digest caps at 80
    // (most-recently-updated), so any count/rollup question is answered from a truncated board — the
    // oldest-updated open tasks are simply invisible. Desired: the digest can represent all of them.
    const projectId = await makeProject("ops");
    const base = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 90; i++) {
      const { error } = await db().from("tasks").insert({
        team_id: seed.teamId,
        project_id: projectId,
        row_key: `TASK-${String(i).padStart(3, "0")}`,
        title: `Open task ${i}`,
        status: "in_progress",
        origin: "sync",
        audience: "team",
        // task 0 is the oldest-updated → first to fall off the 80 cap.
        updated_at: new Date(base + i * 60_000).toISOString(),
      });
      if (error) throw new Error(`task insert failed: ${error.message}`);
    }
    const ctx = await retrieve(db(), seed.teamId, "team", "how many open tasks are there across the team?");
    // Desired: the oldest-updated task is still represented so a count is complete.
    expect(ctx.structured).toContain("TASK-000");
  });

  it.fails("GAP: decisions fall off — an older decision is unanswerable once volume passes the 50 cap", async () => {
    // The decisions digest caps at 50 (newest first), with no date-range awareness. In a busy org
    // that's a few weeks of decisions; "what did we decide about vendor X back in Q1" then has NO
    // grounding, even though the decision is on record. Desired: the older decision is retrievable.
    const projectId = await makeProject("gov");
    const base = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 60; i++) {
      const { error } = await db().from("decisions").insert({
        team_id: seed.teamId,
        project_id: projectId,
        row_key: `DEC-${String(i).padStart(3, "0")}`,
        // decided_at ascending → DEC-000 is the OLDEST, first to fall off the newest-50 window.
        decided_at: new Date(base + i * 86_400_000).toISOString().slice(0, 10),
        title: i === 0 ? "Selected Vendor Aurora for the data warehouse" : `Routine decision ${i}`,
        decided_by: "lead",
        still_valid: true,
        audience: "team",
      });
      if (error) throw new Error(`decision insert failed: ${error.message}`);
    }
    const ctx = await retrieve(db(), seed.teamId, "team", "which vendor did we pick for the data warehouse?");
    expect(ctx.structured).toContain("DEC-000");
  });
});
