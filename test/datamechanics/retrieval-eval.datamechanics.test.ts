import { beforeEach, describe, expect, it } from "vitest";
import { retrieve } from "@/lib/query/retrieve";
import { db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * Retrieval-quality EVAL HARNESS (context-management, Organ 3). A deterministic recall benchmark:
 * a fixed mini-corpus + question→expected-source cases run through the REAL `retrieve()`. It pins
 * today's keyword-FTS recall so improvements (semantic/hybrid retrieval) are *provable* and
 * regressions fail CI. Runs in the data-mechanics tier (real Postgres, no model) → fully reproducible.
 *
 * Cases are tagged `semanticGap: true` when the question shares no surface keywords with its target
 * (paraphrase/synonym) — exactly what keyword FTS misses and semantic retrieval should fix. The
 * keyword cases MUST all hit (guards FTS); overall recall must stay ≥ the recorded baseline.
 */

interface Doc {
  path: string;
  body: string;
  kind?: "deliverable" | "transcript";
  source?: string;
}

interface EvalCase {
  name: string;
  question: string;
  expectPath: string;
  semanticGap: boolean;
}

// Filler docs ingested AFTER the targets so they dominate the recency window — this forces the
// eval to measure actual SEARCH recall (FTS/semantic), not the "8 most recent items" fallback.
// They share no terms with any case question.
const FILLERS: Doc[] = [
  { path: "deliverables/lunch-notes.md", body: "Team lunch is moving to Thursdays; vegetarian options will be added to the catering order." },
  { path: "deliverables/wifi.md", body: "The office wifi password rotates monthly; grab the new one from the front desk whiteboard." },
  { path: "deliverables/holiday-schedule.md", body: "Holiday schedule: the office is closed the last week of December for the winter break." },
  { path: "deliverables/expenses.md", body: "Reminder: submit travel expense reports by the fifth of each month for timely reimbursement." },
  { path: "deliverables/parking.md", body: "Visitor parking is in lot C; register the plate at reception to avoid a ticket." },
  { path: "deliverables/all-hands.md", body: "The monthly all-hands moves to the larger room downstairs; coffee and pastries provided." },
  { path: "deliverables/desk-booking.md", body: "Hot desks are bookable a week ahead through the room calendar; release yours if plans change." },
  { path: "deliverables/printer.md", body: "The third-floor printer is back online; install the driver from the shared software portal." },
];

const CORPUS: Doc[] = [
  { path: "deliverables/auth-redesign.md", body: "Authentication redesign: we migrated to passwordless magic links and removed the legacy password flow entirely." },
  { path: "transcripts/standup.md", kind: "transcript", source: "slack", body: "Standup: Priya is blocked on the payments integration, waiting on Stripe API keys from finance." },
  { path: "deliverables/onboarding.md", body: "New hire onboarding guide: set up the dev environment, request VPN access, and join the engineering channel." },
  { path: "transcripts/incident.md", kind: "transcript", source: "slack", body: "Production outage on the checkout service was caused by a memory leak; we rolled back the deploy and restored service." },
  { path: "deliverables/roadmap.md", body: "Q3 roadmap: ship the analytics dashboard, launch the mobile app beta, and hire two backend engineers." },
  { path: "deliverables/security-review.md", body: "Security review found an SSRF vulnerability in the image proxy; we patched it and added strict input validation." },
  { path: "transcripts/customer-call.md", kind: "transcript", source: "slack", body: "Call with Acme Corp: they require single sign-on and audit logs before signing the enterprise contract." },
  { path: "deliverables/perf-notes.md", body: "The dashboard felt sluggish; we added database indexes and cut p95 latency from 1200ms to 180ms." },
];

const CASES: EvalCase[] = [
  // Keyword cases — the question reuses the doc's terms; FTS must find these.
  { name: "magic-links", question: "passwordless magic links authentication", expectPath: "deliverables/auth-redesign.md", semanticGap: false },
  { name: "stripe-blocked", question: "who is blocked on Stripe payments?", expectPath: "transcripts/standup.md", semanticGap: false },
  { name: "checkout-outage", question: "production outage on the checkout service", expectPath: "transcripts/incident.md", semanticGap: false },
  { name: "ssrf", question: "SSRF in the image proxy", expectPath: "deliverables/security-review.md", semanticGap: false },
  { name: "roadmap", question: "Q3 roadmap analytics dashboard and mobile beta", expectPath: "deliverables/roadmap.md", semanticGap: false },
  // Semantic gaps — paraphrase/synonym, little/no keyword overlap; FTS likely misses, semantic should fix.
  { name: "how-login", question: "how do users sign in now?", expectPath: "deliverables/auth-redesign.md", semanticGap: true },
  { name: "big-deal", question: "what does the large prospect need before they commit?", expectPath: "transcripts/customer-call.md", semanticGap: true },
  { name: "day-one", question: "what should someone just joining the team do first?", expectPath: "deliverables/onboarding.md", semanticGap: true },
  { name: "speedup", question: "what made the app faster?", expectPath: "deliverables/perf-notes.md", semanticGap: true },
];

// Baseline = keyword-FTS recall measured on this corpus (2026-06-26): 6/9. The 3 misses are genuine
// semantic gaps (how-login, big-deal, speedup) — paraphrases with no surface-term overlap that FTS
// can't reach. Semantic/hybrid retrieval should raise this toward 9/9; this `>=` assertion is the
// regression guard. Bump it when the floor genuinely rises.
const OVERALL_RECALL_BASELINE = 6 / 9;

let seed: Seed;

async function pathsFor(question: string): Promise<string[]> {
  const ctx = await retrieve(db(), seed.teamId, "team", question);
  return ctx.sources.map((s) => s.path);
}

describe("retrieval eval — recall benchmark (real Postgres)", () => {
  beforeEach(async () => {
    // The data-mechanics tier truncates beforeEach (runs before this), so re-seed the corpus per test.
    seed = await seedTeam();
    // Targets first, fillers second → fillers are the most-recent, so the recency fallback can't
    // trivially surface the targets; only FTS/semantic search can.
    for (const d of [...CORPUS, ...FILLERS]) {
      await ingest(seed, { kind: d.kind ?? "deliverable", path: d.path, body: d.body, access: "team", frontmatter: d.source ? { source: d.source } : {} });
    }
  });

  it("retrieves the target for every KEYWORD case (FTS floor)", async () => {
    const misses: string[] = [];
    for (const c of CASES.filter((c) => !c.semanticGap)) {
      const paths = await pathsFor(c.question);
      if (!paths.includes(c.expectPath)) misses.push(c.name);
    }
    expect(misses, `keyword cases that failed to retrieve their target: ${misses.join(", ")}`).toEqual([]);
  });

  it("reports overall recall@sources and the semantic gaps (≥ baseline)", async () => {
    const results = await Promise.all(
      CASES.map(async (c) => ({ c, hit: (await pathsFor(c.question)).includes(c.expectPath) }))
    );
    const hits = results.filter((r) => r.hit).length;
    const recall = hits / CASES.length;
    const gaps = results.filter((r) => !r.hit).map((r) => `${r.c.name}${r.c.semanticGap ? " (semantic)" : ""}`);
    // Visibility in CI logs — these are the cases semantic retrieval should close.
    console.info(`[retrieval-eval] recall=${hits}/${CASES.length} (${(recall * 100).toFixed(0)}%); gaps: ${gaps.join(", ") || "none"}`);
    expect(recall).toBeGreaterThanOrEqual(OVERALL_RECALL_BASELINE);
  });
});
