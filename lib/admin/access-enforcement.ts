import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { visibleProjects } from "@/lib/access/oracle";
import { isPrincipal } from "@/lib/access/eligibility";
import { ensureAccessBootstrap, GENERAL_SLUG, EXTERNAL_SHARED_SLUG } from "@/lib/access/bootstrap";
import { drainTeamContext, type DrainResult } from "@/lib/projects/context/backfill";
import { findUnpartitionedItems } from "@/lib/projects/context/coverage";

/**
 * The operator surface for `teams.access_enforcement` (spec §5/§11) — the permissive→enforcing
 * rollout flag that gates the whole Phase B enforced read (`lib/access/enforce.ts`).
 *
 * Until this module existed the column had **no writer outside tests**: shipping the substrate
 * without a way to arm it meant every brain in the field stayed a single flat team-tier pool, and
 * the only way to change that was raw SQL against production Postgres. That is what this fixes.
 *
 * The flip is NOT symmetric, and the asymmetry is the whole design:
 *
 *   → `permissive` is the fail-open-to-today direction. It can never hide anything, so it is
 *     unconditional — and it is the ONE-COMMAND UNDO for a team that somehow reached a bad
 *     enforcing state (including one flipped by hand in SQL before this existed).
 *   → `enforcing` is the direction that can BRICK a brain. Under enforcing a read serves only
 *     items with a CURRENT include-membership into a project the reader's groups are granted;
 *     an un-partitioned item resolves to nothing and vanishes (`visibleItemIdsForProjects` fails
 *     closed by design). A team that has never run the scheduler has NO memberships at all, so
 *     flipping it blind hides 100% of its content from 100% of its people. So this direction
 *     PREPARES (bootstrap + drain the backfill) and then VERIFIES against the real oracle, and
 *     refuses to write the flag if verification does not pass.
 */

export const ENFORCEMENT_MODES = ["permissive", "enforcing"] as const;
export type EnforcementMode = (typeof ENFORCEMENT_MODES)[number];

/** Reject anything that is not one of the two literals — a typo that silently left a client brain
 *  permissive is the exact failure mode this command exists to remove. */
export function isEnforcementMode(value: string): value is EnforcementMode {
  return (ENFORCEMENT_MODES as readonly string[]).includes(value);
}

/**
 * Read the flag. THROWS on a read error rather than returning a default — same discipline as
 * `teamEnforcesAccess`: a swallowed error that reports the wrong mode to an operator is worse
 * than no answer, because they act on it.
 */
export async function readAccessEnforcement(db: DbClient, teamId: string): Promise<string> {
  const { data, error } = await db.from("teams").select("access_enforcement").eq("id", teamId).maybeSingle();
  if (error) throw new Error(`access_enforcement read failed: ${error.message}`);
  if (!data) throw new Error(`team ${teamId} not found`);
  return (data as { access_enforcement: string }).access_enforcement;
}

export interface BlindPrincipal {
  memberId: string;
  email: string | null;
  kind: string;
  tier: string | null;
}

export interface EnforcementReadiness {
  /** True when flipping to `enforcing` right now would NOT hide content from a human principal. */
  ready: boolean;
  /** Hard reasons to refuse — each would cost a human access to content they can see today. */
  blockers: string[];
  /** Real behaviour changes that are NOT lockouts of a human — reported, never fatal. */
  warnings: string[];
  itemsScanned: number;
  /** Items with no CURRENT include-membership: invisible to everyone the moment enforcement is on. */
  unpartitioned: { count: number; examples: string[] };
  humanPrincipals: number;
  agentPrincipals: number;
  /** Active humans whose oracle set would NOT include their tier's system project → they go blind. */
  blindHumans: BlindPrincipal[];
  /** Active agents the oracle resolves to nothing — expected (agents are never auto-admitted). */
  unplacedAgents: BlindPrincipal[];
  /** Active connector service accounts: they can read today and will read nothing under enforcing. */
  activeConnectors: BlindPrincipal[];
}

type MemberRow = {
  id: string;
  email: string | null;
  kind: string;
  is_connector: boolean;
  status: string;
  tier: string | null;
};

/**
 * Would `enforcing` be safe for this team RIGHT NOW? Read-only — it changes nothing, so it is
 * also the `--dry-run` answer.
 *
 * The checks are deliberately derived from the SAME primitives the enforced read uses rather than
 * from a proxy for them: per-member visibility comes from the oracle itself (`visibleProjects`),
 * so a broken group/grant edge anywhere in the chain shows up as the member actually going blind,
 * not as a table row that looks plausible. An inspector that agrees with enforcement is the only
 * kind worth having (the §15.6 rule, applied to the flip).
 */
export async function assessEnforcementReadiness(db: DbClient, teamId: string): Promise<EnforcementReadiness> {
  const blockers: string[] = [];
  const warnings: string[] = [];

  // 1. The §11 system projects must exist — everything below points at them.
  const { data: projectRows, error: pErr } = await db
    .from("projects")
    .select("id, slug")
    .eq("team_id", teamId)
    .in("slug", [GENERAL_SLUG, EXTERNAL_SHARED_SLUG]);
  if (pErr) throw new Error(`system-project read failed: ${pErr.message}`);
  const projectBySlug = new Map(((projectRows ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));
  const generalId = projectBySlug.get(GENERAL_SLUG);
  const externalSharedId = projectBySlug.get(EXTERNAL_SHARED_SLUG);
  for (const [slug, id] of [
    [GENERAL_SLUG, generalId],
    [EXTERNAL_SHARED_SLUG, externalSharedId],
  ] as const) {
    if (!id) blockers.push(`the §11 system project '${slug}' does not exist — the access bootstrap has never completed for this team`);
  }

  // 2. Every ACTIVE HUMAN must still reach their tier's system project through the oracle. This is
  //    the "does anyone go blind" question, asked of the thing that will actually answer it.
  const { data: memberRows, error: mErr } = await db
    .from("members")
    .select("id, email, kind, is_connector, status, tier")
    .eq("team_id", teamId);
  if (mErr) throw new Error(`members read failed: ${mErr.message}`);
  const all = (memberRows ?? []) as MemberRow[];
  const principals = all.filter((m) => isPrincipal({ ...m, tier: m.tier ?? undefined }));
  const blindHumans: BlindPrincipal[] = [];
  const unplacedAgents: BlindPrincipal[] = [];
  let humanPrincipals = 0;
  let agentPrincipals = 0;

  for (const m of principals) {
    const { projectIds } = await visibleProjects(db, { teamId, memberId: m.id });
    const identity: BlindPrincipal = { memberId: m.id, email: m.email, kind: m.kind, tier: m.tier };
    if (m.kind === "human") {
      humanPrincipals++;
      // A team-tier human must reach BOTH system projects — General (all team content) and
      // external-shared, which holds the team-visible external content they can see today. A
      // team member who reaches General alone has silently lost the external corpus, so checking
      // General only would pass a real regression. An external-tier human must reach
      // external-shared. Any other tier value reaches NEITHER built-in group, which is a lockout.
      const required =
        m.tier === "team"
          ? [generalId, externalSharedId]
          : m.tier === "external"
            ? [externalSharedId]
            : [undefined];
      if (required.some((p) => !p || !projectIds.has(p))) blindHumans.push(identity);
    } else {
      agentPrincipals++;
      if (projectIds.size === 0) unplacedAgents.push(identity);
    }
  }
  // CONNECTORS are not principals by design (service accounts must never resolve visibility), but
  // `authenticateApiKey` only rejects a non-ACTIVE member — so a connector key can read the corpus
  // today and will read NOTHING once enforcing. Not a lockout of a person, so not a blocker; but a
  // silent integration going empty is exactly the kind of change an operator must be told about.
  // (Live prod check while building this: 4 of that team's 9 active members are connectors.)
  const activeConnectors = all.filter((m) => m.is_connector && m.status === "active");
  if (blindHumans.length > 0) {
    blockers.push(
      `${blindHumans.length} active human member(s) would see NOTHING under enforcing — their groups grant no path to their tier's system project`
    );
  }
  if (unplacedAgents.length > 0) {
    warnings.push(
      `${unplacedAgents.length} active agent member(s) are in no granted group and will read ZERO items under enforcing ` +
        `(agents are never auto-admitted to Everyone/External by design — place them explicitly, or their pulls go empty)`
    );
  }
  if (activeConnectors.length > 0) {
    warnings.push(
      `${activeConnectors.length} active connector member(s) can read the corpus today and will read ZERO items under ` +
        `enforcing (a connector is not a principal, so the oracle resolves it to nothing). Connectors normally only PUSH — ` +
        `check whether any of yours also pulls before you rely on this being harmless`
    );
  }

  // 3. Every item must already be partitioned. An un-partitioned item is invisible to EVERYONE the
  //    instant the flag flips, so this is the check that decides the whole question.
  const unpartitioned = await findUnpartitionedItems(db, teamId);
  if (unpartitioned.count > 0) {
    blockers.push(
      `${unpartitioned.count} item(s)${unpartitioned.truncated ? "+ (scan truncated)" : ""} have no current project membership ` +
        `and would become invisible to everyone — the §11 backfill has not completed`
    );
  } else if (unpartitioned.truncated) {
    // A truncated scan that found nothing is NOT a clean bill of health — it is an unfinished
    // question, and the answer decides whether a team's whole corpus disappears.
    blockers.push(
      `the coverage scan hit its batch guard after ${unpartitioned.scanned} item(s) — the rest of the corpus is unverified`
    );
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    itemsScanned: unpartitioned.scanned,
    unpartitioned: { count: unpartitioned.count, examples: unpartitioned.examples },
    humanPrincipals,
    agentPrincipals,
    blindHumans,
    unplacedAgents,
    activeConnectors: activeConnectors.map((m) => ({ memberId: m.id, email: m.email, kind: m.kind, tier: m.tier })),
  };
}

export interface SetEnforcementResult {
  ok: boolean;
  error?: string;
  /** The mode read BACK from the row after the write — the only mode worth reporting. */
  mode?: string;
  previous: string;
  changed: boolean;
  prepared?: DrainResult;
  readiness?: EnforcementReadiness;
}

export interface SetEnforcementOptions {
  /** Assess only; write nothing and run no preparation. */
  dryRun?: boolean;
  /** Member id to attribute the audit row to (an operator running the CLI has none). */
  actorMemberId?: string | null;
  /** The UNATTENDED policy (PRET-2, Codex M4's exactness fix): refuse to write when the
   *  AUTHORITATIVE readiness assessment carries warnings — the manual path shows warnings to a
   *  human who decides; the unattended path has no human. Living here (post-drain, pre-write)
   *  means the cheap pre-scan in `autoFlipIfReady` is purely a cost optimization: a warning
   *  shape it under-detects still nets at this gate, never as an unwarned flip. */
  refuseOnWarnings?: boolean;
}

/**
 * Set a team's enforcement mode, and read the column BACK before reporting success.
 *
 * `enforcing` runs the §11 preparation first (`ensureAccessBootstrap` + a full backfill drain —
 * both idempotent, and both exactly what the 30-minute scheduler tick does anyway), then verifies.
 * That ordering is what makes the command safe on a team that has never run the scheduler: rather
 * than refusing and leaving the operator to go find the two functions themselves, it does the work
 * and only then arms the flag. If preparation fails, or verification still finds a blocker, the
 * flag is NOT written — a brain nobody can read is far worse than a brain still on today's
 * behaviour.
 */
export async function setAccessEnforcement(
  db: DbClient,
  teamId: string,
  mode: EnforcementMode,
  opts: SetEnforcementOptions = {}
): Promise<SetEnforcementResult> {
  const previous = await readAccessEnforcement(db, teamId);
  const base = { previous, changed: false };

  if (mode === "enforcing") {
    let prepared: DrainResult | undefined;
    if (!opts.dryRun) {
      const boot = await ensureAccessBootstrap(db, teamId);
      if (!boot.ok) return { ...base, ok: false, error: `access bootstrap failed: ${boot.error}` };
      prepared = await drainTeamContext(db, teamId);
      if (!prepared.ok) return { ...base, ok: false, error: `context backfill failed: ${prepared.error}`, prepared };
    }
    const readiness = await assessEnforcementReadiness(db, teamId);
    if (!readiness.ready) {
      return {
        ...base,
        ok: false,
        error: `refusing to enforce — ${readiness.blockers.join("; ")}`,
        prepared,
        readiness,
      };
    }
    if (opts.refuseOnWarnings && readiness.warnings.length > 0) {
      return {
        ...base,
        ok: false,
        error: `deferred on warnings (unattended policy) — ${readiness.warnings.join("; ")}`,
        prepared,
        readiness,
      };
    }
    if (opts.dryRun) return { ...base, ok: true, mode: previous, readiness };
    const written = await writeMode(db, teamId, mode, previous);
    if (!written.ok) return { ...base, ok: false, error: written.error, prepared, readiness };
    if (written.mode !== previous) await auditFlip(db, teamId, previous, written.mode!, opts.actorMemberId ?? null);
    return { ok: true, previous, mode: written.mode, changed: written.mode !== previous, prepared, readiness };
  }

  // permissive — the fail-open-to-today direction. Never gated: it is the undo.
  if (opts.dryRun) return { ...base, ok: true, mode: previous };
  const written = await writeMode(db, teamId, mode, previous);
  if (!written.ok) return { ...base, ok: false, error: written.error };
  if (written.mode !== previous) await auditFlip(db, teamId, previous, written.mode!, opts.actorMemberId ?? null);
  return { ok: true, previous, mode: written.mode, changed: written.mode !== previous };
}

async function writeMode(
  db: DbClient,
  teamId: string,
  mode: EnforcementMode,
  previous: string
): Promise<{ ok: boolean; error?: string; mode?: string }> {
  // A no-change flip still READS BACK (the operator asked what the mode is, and the answer has to
  // come off the row) but does not WRITE: an `access.enforcement_changed` audit row saying
  // permissive→permissive is noise in the one trail someone will later read to reconstruct when a
  // team's visibility actually changed.
  if (previous === mode) {
    const readBack = await readAccessEnforcement(db, teamId);
    // The read-back is only worth doing if it can FAIL. A no-op merely looks like one: another
    // operator can flip the row between our `previous` read and this one, and without this check
    // that race reports `ok` for a mode nobody asked for and fires a phantom
    // `enforcement_changed` audit row attributed to the wrong operator (because `written.mode !==
    // previous` becomes true). Same discipline as the write path below.
    if (readBack !== mode) {
      return { ok: false, error: `concurrent change: expected '${mode}', row now says '${readBack}'` };
    }
    return { ok: true, mode: readBack };
  }
  // Guarded predicate + RETURNING (PRET-2, program §4's flip-writer contract; Codex M2): the
  // write applies only if the row still holds the mode we read, and success is judged by the
  // MATCHED ROW COUNT — a plain read-back cannot distinguish "my write landed" from "a
  // concurrent caller landed the same target mode", which reported changed:true and fired a
  // second, mis-attributed audit row for one actual transition. The hold column travels in the
  // SAME statement (Codex H2): any downgrade arms it, any enforcing flip clears it — atomic by
  // construction, no separate write to fail silently.
  const { data, error } = await db
    .from("teams")
    .update({ access_enforcement: mode, autoflip_hold: mode === "permissive" })
    .eq("id", teamId)
    .eq("access_enforcement", previous)
    .select("access_enforcement");
  if (error) return { ok: false, error: `write failed: ${error.message}` };
  const rows = (data ?? []) as { access_enforcement: string }[];
  if (rows.length !== 1) {
    return { ok: false, error: `concurrent change: the guarded write matched ${rows.length} row(s) — the row moved under us` };
  }
  if (rows[0].access_enforcement !== mode) {
    return { ok: false, error: `write anomaly: wrote '${mode}', RETURNING says '${rows[0].access_enforcement}'` };
  }
  return { ok: true, mode: rows[0].access_enforcement };
}

async function auditFlip(db: DbClient, teamId: string, from: string, to: string, memberId: string | null) {
  await audit(db, {
    team_id: teamId,
    actor_kind: memberId ? "member" : "system",
    member_id: memberId,
    action: "access.enforcement_changed",
    target_type: "team",
    target_id: teamId,
    meta: { from, to },
  });
}

// ---------------------------------------------------------------------------
// PRET-2 — the UNATTENDED flip path (spec docs/design/pret2-convergence-gated-flip.md §1;
// program docs/design/retire-permissive-model.md §4). Everything below may run with no human
// watching, so it is stage-ordered by cost and fails toward "stays permissive, loudly".
// ---------------------------------------------------------------------------

export interface AutoFlipResult {
  flipped: boolean;
  /** Present when the team was considered and REFUSED (blockers/warnings/error). Absent for the
   *  silent no-ops (already enforcing, the operator-undo hold — whose reason lives on the
   *  enforcement_changed row itself, not in deferral spam — and the queued-past-budget case). */
  deferred?: { blockers: string[]; warnings: string[]; error?: string };
  /** True when the EXPENSIVE stage (prepare→drain→assess) ran — what the pass's budget counts. */
  drained: boolean;
}

/**
 * The CHEAP warning scan (spec §1.1: computed BEFORE any drain is paid), a COST OPTIMIZATION
 * only — the AUTHORITATIVE warning gate is `setAccessEnforcement`'s `refuseOnWarnings`
 * (post-drain, pre-write), so a shape this scan under-detects nets there, never as an unwarned
 * flip (Codex M4). Two adapter queries, NO per-agent oracle loop (the old loop was unbounded
 * N+1 — an oracle call per agent per permissive team per tick): connectors from the members
 * read; unplaced agents from one bulk group-membership read via the groups module's sanctioned
 * helper (an agent in a group with zero
 * project grants is the rare shape the authoritative gate still catches).
 */
export async function assessUnattendedWarnings(db: DbClient, teamId: string): Promise<string[]> {
  const warnings: string[] = [];
  const { data: memberRows, error } = await db
    .from("members")
    .select("id, email, kind, is_connector, status, tier")
    .eq("team_id", teamId);
  if (error) throw new Error(`members read failed: ${error.message}`);
  const all = (memberRows ?? []) as MemberRow[];
  const connectors = all.filter((m) => m.is_connector && m.status === "active");
  if (connectors.length > 0) {
    // CLASS-keyed, no census (review L2): the deferral fingerprint hashes these strings, and a
    // count that churns (a connector added) is not a distinct STUCK state worth a new audit row.
    warnings.push(`active connector member(s) would read ZERO items under enforcing`);
  }
  const agents = all.filter((m) => isPrincipal({ ...m, tier: m.tier ?? undefined }) && m.kind !== "human");
  if (agents.length > 0) {
    // One bulk read via the groups module's sanctioned helper (the access-chain single-writer
    // guard rightly refuses this file naming the edge tables directly — it contains write verbs).
    const { placedMemberIds } = await import("@/lib/access/groups");
    const placed = await placedMemberIds(db, teamId, agents.map((a) => a.id));
    if (agents.some((a) => !placed.has(a.id))) {
      warnings.push(`agent member(s) in no granted group would read ZERO items under enforcing`);
    }
  }
  return warnings;
}

/** One deferral row per DISTINCT state (spec §1.1's fingerprint latch): an unchanged stuck state
 *  writes nothing. `audit()` is best-effort — a swallowed write just retries next attempt. */
async function deferAutoFlip(
  db: DbClient,
  teamId: string,
  deferred: { blockers: string[]; warnings: string[]; error?: string },
  drained = false
): Promise<AutoFlipResult> {
  const { createHash } = await import("node:crypto");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([[...deferred.blockers].sort(), [...deferred.warnings].sort(), deferred.error ?? ""]))
    .digest("hex")
    .slice(0, 16);
  try {
    const { data } = await db
      .from("audit_log")
      .select("meta")
      .eq("team_id", teamId)
      .eq("action", "access.autoflip_deferred")
      .order("created_at", { ascending: false })
      // id DESC breaks same-timestamp ties deterministically (Codex: created_at alone is
      // unordered under equal values — the clock-tie class this repo just fixed in arc-corrections).
      .order("id", { ascending: false })
      .limit(1);
    const last = ((data ?? []) as { meta: { fingerprint?: string } }[])[0];
    if (last?.meta?.fingerprint !== fingerprint) {
      await audit(db, {
        team_id: teamId,
        actor_kind: "system",
        action: "access.autoflip_deferred",
        target_type: "team",
        target_id: teamId,
        meta: { ...deferred, fingerprint },
      });
    }
  } catch {
    // the latch read failing must not turn a deferral into a throw — next attempt retries
  }
  return { flipped: false, deferred, drained };
}

export interface AutoFlipDeferral {
  at: string;
  blockers: string[];
  warnings: string[];
  error?: string;
}

/** The most recent auto-flip deferral — the stuck-state surfacing read (spec §1.4), shared by
 *  the permission inspector and the CLI so the two surfaces cannot disagree. Null = never
 *  deferred (or the read failed — surfacing is best-effort, never a 500). */
export async function latestAutoFlipDeferral(db: DbClient, teamId: string): Promise<AutoFlipDeferral | null> {
  try {
    const { data } = await db
      .from("audit_log")
      .select("created_at, meta")
      .eq("team_id", teamId)
      .eq("action", "access.autoflip_deferred")
      .order("created_at", { ascending: false })
      // id DESC breaks same-timestamp ties deterministically (Codex: created_at alone is
      // unordered under equal values — the clock-tie class this repo just fixed in arc-corrections).
      .order("id", { ascending: false })
      .limit(1);
    const row = ((data ?? []) as { created_at: string | Date; meta: Record<string, unknown> }[])[0];
    if (!row) return null;
    const at = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
    return {
      at,
      blockers: Array.isArray(row.meta.blockers) ? (row.meta.blockers as string[]) : [],
      warnings: Array.isArray(row.meta.warnings) ? (row.meta.warnings as string[]) : [],
      ...(typeof row.meta.error === "string" ? { error: row.meta.error } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The unattended flip. NEVER throws (spec §1.1 error containment — one team's failure must not
 * abort the fleet pass): every stage's throw becomes a deferral with `error` in meta. Stage
 * order is cost order — mode read, hold read, cheap warning scan, and only then the full
 * prepare→drain→assess→write sequence via `setAccessEnforcement` (reused, not reimplemented).
 */
export async function autoFlipIfReady(
  db: DbClient,
  teamId: string,
  opts: {
    /** The pass's drain-budget gate: false = run only the cheap stages; a ready team QUEUES
     *  silently for the next pass instead of entering the expensive sequence (spec §1.2 — the
     *  budget bounds drains, cheap checks run for every permissive team every pass). */
    drainAllowed?: boolean;
  } = {}
): Promise<AutoFlipResult> {
  const drainAllowed = opts.drainAllowed !== false;
  // Tracked OUTSIDE the try so a throw AFTER the expensive stage began still reports
  // drained:true and consumes the pass's budget (Codex M1: a late throw defaulting to
  // drained:false let a pass run unboundedly many full drains).
  let drained = false;
  try {
    // ONE read for both facts: the mode, and the HOLD — a teams column written atomically with
    // every downgrade (Codex H2: the previous audit-derived hold rode a best-effort insert
    // that could silently fail, re-flipping an operator's undo within a tick; and audit
    // created_at ties are unordered). Only a manual enforcing flip clears it.
    const { data, error } = await db
      .from("teams")
      .select("access_enforcement, autoflip_hold")
      .eq("id", teamId)
      .maybeSingle();
    if (error) throw new Error(`team read failed: ${error.message}`);
    if (!data) throw new Error(`team ${teamId} not found`);
    const row = data as { access_enforcement: string; autoflip_hold?: boolean | null };
    if (row.access_enforcement !== "permissive") return { flipped: false, drained }; // already enforcing
    if (row.autoflip_hold === true) return { flipped: false, drained }; // held — the undo stands
    const warnings = await assessUnattendedWarnings(db, teamId);
    if (warnings.length > 0) return deferAutoFlip(db, teamId, { blockers: [], warnings });
    if (!drainAllowed) return { flipped: false, drained }; // ready — queued for next pass
    drained = true;
    const r = await setAccessEnforcement(db, teamId, "enforcing", { actorMemberId: null, refuseOnWarnings: true });
    if (r.ok) return { flipped: r.changed, drained };
    // A refusal AFTER readiness passed (a raced guarded write, a genuine write error) carries
    // empty blockers — `r.error` is then the only reason and must reach the audit row (review
    // M1: `?? []` never falls through on an empty-but-present array, so the deferral explained
    // nothing). The authoritative warning refusal (refuseOnWarnings) lands here too, with the
    // full assessment's warnings attached.
    const blockers = r.readiness?.blockers?.length ? r.readiness.blockers : r.readiness?.warnings?.length ? [] : [r.error ?? "refused"];
    return deferAutoFlip(db, teamId, { blockers, warnings: r.readiness?.warnings ?? [] }, drained);
  } catch (err) {
    return deferAutoFlip(
      db,
      teamId,
      { blockers: [], warnings: [], error: err instanceof Error ? err.message : String(err) },
      drained
    );
  }
}
