import "server-only";
import type { DbClient } from "@/lib/db/types";
import { sendOpsAlert, mailerConfigured } from "@/lib/auth/mailer";
import {
  groupCensuses,
  GRAPH_HEALTH_SOURCE,
  type CensusRefusal,
  type GroupCensus,
} from "@/lib/graph/extraction-health";
import { neo4jConfigured } from "@/lib/graph/neo4j";
import { recordIngestRun } from "@/lib/ingest/runs";

/**
 * Email admins when graph extraction health TRANSITIONS — the delivery half of the AIO-693 alarm,
 * re-armed for graphiti 0.29.3 by ALARMFIX-1 (docs/design/dedupe-alarm-0293.md). Copies
 * `lib/query/retrieval-alert`'s shape (the one alert path in this repo that has actually reached a
 * human).
 *
 * TWO machines share the `ingest_runs` `graph_health` ledger, discriminated by `meta.alarm`:
 *
 *  1. POLLUTION — the name-collision census (`lib/graph/extraction-health`) says a group is
 *     accumulating same-name entity splits above its own baseline. One edge-debounced machine over
 *     the COMBINED per-group verdict: judgeable if ANY group judged, polluted if ANY judged group
 *     polluted — with GROUP MEMORY on the recovery edge (the alert row records the polluted group
 *     ids; "recovered" requires each of them judged-and-healthy, or released by the ledger valve).
 *  2. BLINDNESS (the meta-alarm) — unjudgeable-persisting is itself an alert state. The old alarm
 *     sat silently disabled from #490 until this design because `judgeable: false` was a terminal
 *     quiet state nothing listened to; an alarm that cannot fire and does not say so is
 *     indistinguishable from a healthy quiet one. A persisted wall-clock anchor + a refusal
 *     taxonomy (see `refusalRunsClock`) mails after `UNJUDGEABLE_ALERT_HOURS` of clock-running
 *     refusals. Signal-agnostic: any future evidence removal parks the alarm in a state that PAGES
 *     instead of a state that hides.
 *
 * STATE LIVES IN `ingest_runs` (`source: "graph_health"`) — no new table, and the Admin panel's run
 * list doubles as the alarm's audit trail. Rows are written ONLY on a transition. Rows WITHOUT the
 * `meta.alarm` key read as `"pollution"` (legacy rows predate the discriminator; prod's ledger is
 * empty today, but fixtures and older installs are not guaranteed to be). Anchor rows are written
 * `ok: true` — a running clock is not a pipeline failure, and the run list must not render red for
 * a non-failure; the KIND discriminator, not `ok`, is what the reads key on.
 */

export { GRAPH_HEALTH_SOURCE };

/* ── kinds & the per-kind ledger read ─────────────────────────────────────────────────────────── */

export type GraphAlarmKind = "pollution" | "blindness";

/** Kind of a ledger row from its meta. Legacy rows (no `meta.alarm`) are POLLUTION — without this,
 *  a blindness row written between two pollution transitions would corrupt the pollution prior-state
 *  read (e.g. a blindness `fired` row, `ok: false`, would make the next healthy pollution tick mail
 *  "recovered" for an alert that never fired). */
export function alarmKindOf(meta: Record<string, unknown> | null | undefined): GraphAlarmKind {
  return meta && (meta as { alarm?: unknown }).alarm === "blindness" ? "blindness" : "pollution";
}

/** Transition rows are weeks apart, so 50 rows spans years of history — deep enough that the newest
 *  row of either kind is always inside the scan. */
const KIND_SCAN_DEPTH = 50;

export interface GraphHealthLedgerRow {
  ok: boolean;
  meta: Record<string, unknown>;
  finishedAtMs: number;
}

/** Newest graph_health row OF THE GIVEN KIND — the per-kind prior-state read. */
export async function latestGraphHealthOfKind(
  db: DbClient,
  kind: GraphAlarmKind
): Promise<GraphHealthLedgerRow | null> {
  const { data } = await db
    .from("ingest_runs")
    .select("ok, meta, finished_at")
    .eq("source", GRAPH_HEALTH_SOURCE)
    .order("finished_at", { ascending: false })
    .limit(KIND_SCAN_DEPTH);
  for (const raw of data ?? []) {
    const row = raw as { ok: boolean; meta: unknown; finished_at: string | Date };
    // jsonb usually arrives parsed; a string is tolerated so a driver quirk can't blind the read.
    const meta =
      typeof row.meta === "string"
        ? (JSON.parse(row.meta) as Record<string, unknown>)
        : ((row.meta ?? {}) as Record<string, unknown>);
    if (alarmKindOf(meta) !== kind) continue;
    const at = row.finished_at instanceof Date ? row.finished_at.getTime() : Date.parse(row.finished_at);
    return { ok: row.ok, meta, finishedAtMs: Number.isFinite(at) ? at : 0 };
  }
  return null;
}

/* ── the POLLUTION machine ────────────────────────────────────────────────────────────────────── */

export type PollutionAction = "alert" | "recover" | "refresh" | "none";

export interface PollutionGroupTick {
  group: string;
  judgeable: boolean;
  polluted: boolean;
  /** Episodes across the FULL recent+baseline span from the `graph_episodes` ledger — the release
   *  valve's "nothing is being extracted into it" test. null = ledger unreadable → NOT quiet. */
  spanEpisodes: number | null;
}

/**
 * The combined edge detector, pure. Verdict for a tick: judgeable if ANY group judged, polluted if
 * ANY judged group polluted. Unjudgeable ticks are a no-op in BOTH directions — an alarm that
 * "recovers" during an outage teaches people to ignore the recovery mail (standing contract).
 *
 * GROUP MEMORY on the recovery edge: `priorPollutedGroups` (from the alert row's meta) must EACH be
 * judged-and-healthy this tick, or released by the ledger valve, before "recovered" fires. Without
 * this, a small group that alerted and then dipped under its name minimum while the team group
 * judged healthy would mail "recovered" for a group that was never re-judged — the one-quiet-Saturday
 * false recovery this file already documents, reintroduced one layer up. While any
 * previously-polluted group is neither, the combined verdict is UNJUDGEABLE (action "none"), not
 * healthy.
 *
 * MEMORY MUST NOT FORGET A GROUP THAT POLLUTES MID-INCIDENT (review HIGH on the first cut): the
 * MAIL is edge-debounced, but the STATE is not — a group judging polluted while the alarm is
 * already active joins the memory via a `"refresh"` action (one `ok:false` ledger row carrying the
 * UNION of prior and new groups, NO mail). Without it, B polluting during A's incident and then
 * dipping unjudged would let A's recovery mail fire while B is still splintering — the same false
 * recovery HIGH-A closes, through a side door.
 *
 * THE RELEASE VALVE, ledger-defined like everything else here: a previously-polluted group whose
 * `graph_episodes` flow is ZERO across the full recent+baseline span (a decommissioned external
 * group, an ended client project) has no ongoing pollution to recover FROM — holding the machine
 * UNJUDGEABLE for it would leave the card red until heat death, the slow-motion cry-wolf that trains
 * admins to ignore the surface. Evaluated at read time from the ledger; no new row type. A prior
 * group with no ledger rows at all in the span (team deleted, cascade removed the rows) is quiet by
 * the same definition.
 */
export function decidePollutionAction(input: {
  groups: PollutionGroupTick[];
  priorPolluted: boolean;
  priorPollutedGroups: string[];
}): { action: PollutionAction; pollutedGroups: string[] } {
  const judged = input.groups.filter((g) => g.judgeable);
  const pollutedGroups = judged.filter((g) => g.polluted).map((g) => g.group);
  if (judged.length === 0) return { action: "none", pollutedGroups };
  if (pollutedGroups.length > 0) {
    if (!input.priorPolluted) return { action: "alert", pollutedGroups };
    // Already alerting: no mail — but a group judging polluted that memory does not yet hold must
    // JOIN it (a "refresh" row with the union), or its later unjudged dip is invisible to recovery.
    const joined = pollutedGroups.filter((g) => !input.priorPollutedGroups.includes(g));
    return joined.length > 0
      ? {
          action: "refresh",
          pollutedGroups: [...new Set([...input.priorPollutedGroups, ...pollutedGroups])],
        }
      : { action: "none", pollutedGroups };
  }
  if (!input.priorPolluted) return { action: "none", pollutedGroups };
  const byGroup = new Map(input.groups.map((g) => [g.group, g]));
  const released = (name: string): boolean => {
    const g = byGroup.get(name);
    if (!g) return true; // no ledger presence in the span — quiet by definition
    if (g.judgeable && !g.polluted) return true; // judged-and-healthy
    return g.spanEpisodes === 0; // ledger-quiet across the full recent+baseline span
  };
  return input.priorPollutedGroups.every(released)
    ? { action: "recover", pollutedGroups }
    : { action: "none", pollutedGroups }; // combined verdict: UNJUDGEABLE, not healthy
}

/* ── the BLINDNESS machine (meta-alarm) ───────────────────────────────────────────────────────── */

/** Wall-clock hours of clock-running refusals before the meta-alarm mails. Wall-clock — not
 *  "unjudgeable on every tick" — deliberately, so a quiet weekend with no scheduler activity cannot
 *  reset or satisfy the clock. */
export const UNJUDGEABLE_ALERT_HOURS = 24;
const UNJUDGEABLE_ALERT_MS = UNJUDGEABLE_ALERT_HOURS * 3_600_000;

/**
 * `graph-unreadable` parks this long before it runs the clock. The grace's job is LEDGER HYGIENE
 * (no anchor/cleared row pairs from routine graphiti restarts), not mail latency — 6h exceeds every
 * observed healthy graphiti unavailability and matches `EXTRACTION_LAG_BUDGET_MS`'s precedent for
 * exactly this budget shape. Serial with the 24h clock, so worst-case time-to-page for a rotted
 * credential is grace + 24h ≈ 30h — ONCE a process has lived through the grace unreadable; the
 * in-memory marker's deploy-reset corner (see `unreadableSinceMs`) is unbounded, not late.
 */
export const UNREADABLE_GRACE_MS = 6 * 3_600_000;

/**
 * Does this refusal RUN the meta-alarm clock, or PARK it?
 *  • `predicate-suspect` RUNS — episodes flow but the census reads nothing; whether that's a
 *    graphiti rename or a stalled extractor, the alarm is blind to a live pipeline.
 *  • `no-baseline` runs ONLY when the ledger shows the baseline window had episode flow — a fresh
 *    install whose recent window clears the name minimum before its baseline fills would otherwise
 *    get a "your alarm is blind" mail at ~week 2 while perfectly healthy. The ledger-defined-young
 *    test applies per WINDOW, symmetrically with the census tripwire.
 *  • `small-sample` (ledger-confirmed young/quiet group) and `graph-unconfigured` (no Neo4j —
 *    nothing to protect) PARK.
 *  • `graph-unreadable` parks for `UNREADABLE_GRACE_MS`, then RUNS: no path in this repo mails on
 *    Neo4j being down, so a permanent park would reproduce the silent-death shape behind a pager
 *    that does not exist. Transient restarts stay quiet inside the grace; a rotted credential
 *    eventually pages, with unreadable-specific copy.
 */
export function refusalRunsClock(
  refusal: CensusRefusal,
  opts: { baselineEpisodes: number | null; unreadableSinceMs: number | null; nowMs: number }
): boolean {
  switch (refusal) {
    case "predicate-suspect":
      return true;
    case "no-baseline":
      return (opts.baselineEpisodes ?? 0) > 0;
    case "graph-unreadable":
      return (
        opts.unreadableSinceMs !== null && opts.nowMs - opts.unreadableSinceMs >= UNREADABLE_GRACE_MS
      );
    case "small-sample":
    case "graph-unconfigured":
      return false;
  }
}

export type BlindnessTickClass = "judged" | "running" | "parked";

/** A tick with ANY judged group is a judged tick (the pollution machine had evidence); else it is
 *  clock-running if ANY refusal runs the clock; else parked (changes nothing, like the old
 *  unknown-tick contract). */
export function classifyBlindnessTick(
  groups: Array<{ judgeable: boolean; clockRuns: boolean }>
): BlindnessTickClass {
  if (groups.some((g) => g.judgeable)) return "judged";
  if (groups.some((g) => g.clockRuns)) return "running";
  return "parked";
}

export type BlindnessPhase = "anchor" | "fired" | "cleared";
export type BlindnessAction = "anchor" | "fire" | "clear" | "none";

/**
 * The blindness edge machine, pure. Three persisted phases carry three distinguishable meanings —
 * one meaning is not enough in either direction:
 *  • without `fired`, every clock-running tick past hour 24 would RE-MAIL FOREVER;
 *  • without `cleared`, a judged tick that voids the clock would leave a stale anchor behind, and a
 *    clock-running refusal weeks later would FIRE INSTANTLY off it.
 * The anchor is PERSISTED (a ledger row), never in-memory: an in-memory clock resets on every
 * deploy — frequent here — and could keep the meta-alarm perpetually below threshold.
 *
 * The mail condition is exactly: an `anchor` ≥ `UNJUDGEABLE_ALERT_HOURS` old with no `fired` or
 * `cleared` since it, evaluated on a CLOCK-RUNNING tick (a parked tick changes nothing — parking
 * would mean nothing if a parked tick could still fire).
 */
export function decideBlindnessAction(input: {
  tick: BlindnessTickClass;
  latest: { phase: BlindnessPhase; atMs: number } | null;
  nowMs: number;
}): BlindnessAction {
  const { tick, latest, nowMs } = input;
  if (tick === "parked") return "none";
  if (tick === "judged") {
    if (latest !== null && (latest.phase === "anchor" || latest.phase === "fired")) return "clear";
    return "none";
  }
  // clock-running refusal tick
  if (latest === null || latest.phase === "cleared") return "anchor";
  if (latest.phase === "fired") return "none"; // edge-debounced: one mail per blind spell
  return nowMs - latest.atMs >= UNJUDGEABLE_ALERT_MS ? "fire" : "none";
}

/** A `clear` mails "the alarm is judging again" ONLY when the spell actually fired — clearing a
 *  mere anchor (the clock ran but never hit 24h) is edge-only bookkeeping, no mail. */
export function blindnessClearMails(latestPhase: BlindnessPhase): boolean {
  return latestPhase === "fired";
}

/* ── the scheduled runner ─────────────────────────────────────────────────────────────────────── */

/**
 * When Neo4j FIRST became unreadable, in-memory. Only the 6h grace reads this — the 24h clock
 * itself is ledger-persisted.
 *
 * Tradeoff, stated honestly: a brain deploy resets this marker, so the grace only ever elapses
 * inside a single process lifetime. Under deploys landing more often than every 6h INDEFINITELY,
 * the unreadable leg NEVER runs the clock and never pages — the "worst-case ≈ 30h" on
 * `UNREADABLE_GRACE_MS` holds only once some process lives ≥6h while Neo4j is unreadable; the
 * degenerate corner is UNBOUNDED, not merely late. Accepted because (a) a sustained sub-6h deploy
 * cadence does not survive a weekend or any quiet period, which bounds the gap in practice, and
 * (b) persisting the grace start would write the routine-restart anchor/cleared ledger churn the
 * grace exists to avoid. The grace resets; the clock does not.
 */
let unreadableSinceMs: number | null = null;

export interface GraphHealthTickResult {
  pollution: PollutionAction;
  blindness: BlindnessAction;
}

const pct = (n: number | null) => (n === null ? "?" : `${Math.round(n * 1000) / 10}%`);

async function activeAdminEmails(db: DbClient): Promise<string[]> {
  const { data } = await db
    .from("members")
    .select("email")
    .eq("role", "admin")
    .eq("status", "active");
  const emails = (data ?? [])
    .map((m) => (m as { email: string | null }).email)
    .filter((e): e is string => !!e && e.includes("@"));
  return [...new Set(emails.map((e) => e.toLowerCase()))];
}

function adminUrl(): string {
  return process.env.APP_URL
    ? `${process.env.APP_URL.replace(/\/$/, "")} → Admin → Integrations`
    : "Admin → Integrations";
}

async function mailAdmins(db: DbClient, subject: string, text: string): Promise<void> {
  if (!mailerConfigured()) return; // transitions are still recorded — state must not depend on mail
  for (const to of await activeAdminEmails(db)) await sendOpsAlert(to, subject, text);
}

/**
 * One scheduler-tick evaluation of BOTH machines. Best-effort throughout — nothing here may fail
 * the ingest tick. Returns the actions taken, for the tick's log line.
 */
export async function runGraphHealthCheck(
  db: DbClient,
  nowMs = Date.now()
): Promise<GraphHealthTickResult> {
  const none: GraphHealthTickResult = { pollution: "none", blindness: "none" };
  try {
    // No Neo4j configured ⇒ every group would refuse `graph-unconfigured`, which parks both
    // machines — nothing to protect, nothing to page about. Short-circuit before any query.
    if (!neo4jConfigured()) return none;
    const startedAt = Date.now();
    const censuses = await groupCensuses(null, nowMs);
    if (censuses.length === 0) return none; // cold start (no ledger flow) or unreadable ledger — park

    const unreadable = censuses.some((c) => c.pollution.refusal === "graph-unreadable");
    if (unreadable && unreadableSinceMs === null) unreadableSinceMs = nowMs;
    if (!unreadable) unreadableSinceMs = null;

    const pollution = await runPollutionMachine(db, censuses, startedAt, nowMs);
    const blindness = await runBlindnessMachine(db, censuses, startedAt, nowMs);
    return { pollution, blindness };
  } catch {
    return none; // best-effort — the ingest tick must never pay for the alarm
  }
}

async function runPollutionMachine(
  db: DbClient,
  censuses: GroupCensus[],
  startedAt: number,
  nowMs: number
): Promise<PollutionAction> {
  const prior = await latestGraphHealthOfKind(db, "pollution").catch(() => null);
  const priorPolluted = prior !== null && prior.ok === false;
  const priorGroupsRaw = prior?.meta.groups;
  const priorPollutedGroups = Array.isArray(priorGroupsRaw)
    ? priorGroupsRaw.filter((g): g is string => typeof g === "string")
    : [];
  const { action, pollutedGroups } = decidePollutionAction({
    groups: censuses.map((c) => ({
      group: c.group,
      judgeable: c.pollution.judgeable,
      polluted: c.pollution.polluted,
      spanEpisodes: c.spanEpisodes,
    })),
    priorPolluted,
    priorPollutedGroups,
  });
  if (action === "none") return "none";

  const pollutedCensuses = censuses.filter((c) => pollutedGroups.includes(c.group));
  const reasons = pollutedCensuses
    .map((c) => c.pollution.reason)
    .filter((r): r is string => r !== null);
  await recordIngestRun(db, {
    source: GRAPH_HEALTH_SOURCE,
    trigger: "scheduler",
    ok: action === "recover",
    errors:
      action === "alert"
        ? reasons
        : action === "refresh"
          ? [
              `pollution memory refresh: recovery now requires each of ${pollutedGroups.join(", ")} ` +
                `judged-and-healthy or ledger-quiet (a group joined the active incident)`,
            ]
          : [],
    meta: {
      alarm: "pollution",
      groups: pollutedGroups,
      ...(action === "refresh" ? { refresh: true } : {}),
      census: censuses.map((c) => ({
        group: c.group,
        recentShare: c.pollution.recentShare,
        baselineShare: c.pollution.baselineShare,
        refusal: c.pollution.refusal,
      })),
    },
    startedAt,
    finishedAt: nowMs,
  });

  // A refresh is STATE ONLY: the alert mail already went out for this incident, and mailing again
  // per joining group would undo the edge debounce. The row alone widens the recovery requirement.
  if (action === "refresh") return "refresh";

  if (action === "alert") {
    const perGroup = pollutedCensuses
      .map(
        (c) =>
          `  • ${c.group}: ${pct(c.pollution.recentShare)} of recently-active entity names are split ` +
          `across more than one node (baseline ${pct(c.pollution.baselineShare)})`
      )
      .join("\n");
    await mailAdmins(
      db,
      "⚠️ AIOS Team Brain — graph extraction degraded",
      `The graph extractor is accumulating same-name duplicate entities — the same thing in the ` +
        `world is landing as several parallel nodes, so retrieval and narrative arcs quietly ` +
        `degrade.\n\nGroup(s) over their own baseline:\n${perGroup}\n\nThat is the signature of ` +
        `embedding candidate retrieval missing existing nodes (embedding degradation, index ` +
        `trouble) or an extraction model resolving identity badly — the failure that silently ` +
        `degraded the graph for four days on 2026-07-30. Check the Extraction model in ` +
        `${adminUrl()} and consider reverting a recent change.\n\nYou'll get one more email when ` +
        `it recovers.`
    );
  } else {
    await mailAdmins(
      db,
      "✅ AIOS Team Brain — graph extraction recovered",
      `Graph extraction has recovered: every previously-affected group is either judged healthy ` +
        `again or has had no episode flow for the full measurement span. No action needed.\n\n` +
        `Note: entities created while it was degraded may remain duplicated in the graph until a ` +
        `cleanup re-projection.`
    );
  }
  return action;
}

/** Highest-signal refusal among the clock-running groups, for the anchor/fired rows and the mail
 *  copy: predicate-suspect (a live pipeline the alarm can't see) outranks unreadable outranks
 *  no-baseline. */
function primaryRunningRefusal(
  running: Array<{ refusal: CensusRefusal | null }>
): CensusRefusal | null {
  const order: CensusRefusal[] = ["predicate-suspect", "graph-unreadable", "no-baseline"];
  for (const r of order) if (running.some((g) => g.refusal === r)) return r;
  return running[0]?.refusal ?? null;
}

function blindnessMailText(refusal: CensusRefusal | null): string {
  const where = adminUrl();
  if (refusal === "predicate-suspect") {
    // Two causes, and the mail says so — it cannot distinguish a rename from a stall, so it names
    // both instead of diagnosing. Since the stalled-extractor leg is banner-only today, this mail
    // may be the only push notification a stall gets.
    return (
      `The graph pollution alarm has been unable to judge for over ${UNJUDGEABLE_ALERT_HOURS} hours — ` +
      `it is not protecting you.\n\nCause on record: episodes ARE being projected into the graph, ` +
      `but the entity-name census reads ZERO names. Two different failures produce that signature ` +
      `and this alarm cannot tell them apart:\n` +
      `  • a graphiti upgrade renamed what the census reads (the Entity label or its created_at ` +
      `property), or\n` +
      `  • the extractor is STALLED — episodes are 202-accepted while the worker dies on every job, ` +
      `so no new nodes are written (both 2026-07 prod incidents had this shape).\n\n` +
      `Check the extraction banner at ${where} and the graphiti service logs.\n\n` +
      `You'll get one more email when the alarm can judge again.`
    );
  }
  if (refusal === "graph-unreadable") {
    return (
      `The graph pollution alarm has been unable to judge for over ${UNJUDGEABLE_ALERT_HOURS} hours — ` +
      `it is not protecting you.\n\nCause on record: the graph database (Neo4j) has been UNREADABLE ` +
      `for well past the transient-restart grace. A routine graphiti restart recovers in minutes, so ` +
      `suspect a rotted credential (NEO4J_URL / NEO4J_USER / NEO4J_PASSWORD) or a down service. ` +
      `Nothing else in this app pages on Neo4j being down — this mail is that pager.\n\n` +
      `Check the graph service and the retrieval-health card at ${where}.\n\n` +
      `You'll get one more email when the alarm can judge again.`
    );
  }
  return (
    `The graph pollution alarm has been unable to judge for over ${UNJUDGEABLE_ALERT_HOURS} hours — ` +
    `it is not protecting you.\n\nEpisodes are flowing but the census cannot accumulate a judgeable ` +
    `sample. See the per-group census on the retrieval-health card at ${where} for the exact ` +
    `refusal cause.\n\nYou'll get one more email when the alarm can judge again.`
  );
}

async function runBlindnessMachine(
  db: DbClient,
  censuses: GroupCensus[],
  startedAt: number,
  nowMs: number
): Promise<BlindnessAction> {
  const ticks = censuses.map((c) => ({
    judgeable: c.pollution.judgeable,
    refusal: c.pollution.refusal,
    clockRuns:
      c.pollution.refusal !== null &&
      refusalRunsClock(c.pollution.refusal, {
        baselineEpisodes: c.baselineEpisodes,
        unreadableSinceMs,
        nowMs,
      }),
  }));
  const tick = classifyBlindnessTick(ticks);
  const latestRow = await latestGraphHealthOfKind(db, "blindness").catch(() => null);
  const phaseRaw = latestRow?.meta.phase;
  const latest =
    latestRow !== null && (phaseRaw === "anchor" || phaseRaw === "fired" || phaseRaw === "cleared")
      ? { phase: phaseRaw as BlindnessPhase, atMs: latestRow.finishedAtMs }
      : null;
  const action = decideBlindnessAction({ tick, latest, nowMs });
  if (action === "none") return "none";

  const refusal = primaryRunningRefusal(ticks.filter((t) => t.clockRuns));
  if (action === "anchor") {
    // ok: true — a running clock is not a pipeline failure; the kind+phase, not `ok`, carry meaning.
    await recordIngestRun(db, {
      source: GRAPH_HEALTH_SOURCE,
      trigger: "scheduler",
      ok: true,
      meta: { alarm: "blindness", phase: "anchor", refusal },
      startedAt,
      finishedAt: nowMs,
    });
    return "anchor";
  }
  if (action === "fire") {
    const text = blindnessMailText(refusal);
    await recordIngestRun(db, {
      source: GRAPH_HEALTH_SOURCE,
      trigger: "scheduler",
      ok: false,
      errors: [
        `pollution alarm unjudgeable for ≥${UNJUDGEABLE_ALERT_HOURS}h (refusal: ${refusal ?? "unknown"})`,
      ],
      meta: { alarm: "blindness", phase: "fired", refusal },
      startedAt,
      finishedAt: nowMs,
    });
    await mailAdmins(db, "⚠️ AIOS Team Brain — the graph pollution alarm has gone blind", text);
    return "fire";
  }
  // clear — edge-only bookkeeping; mails only when the spell actually fired.
  await recordIngestRun(db, {
    source: GRAPH_HEALTH_SOURCE,
    trigger: "scheduler",
    ok: true,
    meta: { alarm: "blindness", phase: "cleared" },
    startedAt,
    finishedAt: nowMs,
  });
  if (latest !== null && blindnessClearMails(latest.phase)) {
    await mailAdmins(
      db,
      "✅ AIOS Team Brain — the graph pollution alarm is judging again",
      `The pollution alarm produced a judged verdict again — it is back to protecting the graph. ` +
        `No action needed.`
    );
  }
  return "clear";
}

/** Test-only: reset the in-memory unreadable-grace marker between cases. */
export function _resetUnreadableGraceForTests(): void {
  unreadableSinceMs = null;
}
