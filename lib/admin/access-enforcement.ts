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
  if (previous === mode) return { ok: true, mode: await readAccessEnforcement(db, teamId) };
  const { error } = await db.from("teams").update({ access_enforcement: mode }).eq("id", teamId);
  if (error) return { ok: false, error: `write failed: ${error.message}` };
  // Read back: the CHECK constraint, a raced write, or a silently-dropped update all look like
  // success at the call site otherwise, and this flag is the one an operator must not be wrong about.
  const readBack = await readAccessEnforcement(db, teamId);
  if (readBack !== mode) return { ok: false, error: `read-back mismatch: wrote '${mode}', row says '${readBack}'` };
  return { ok: true, mode: readBack };
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
