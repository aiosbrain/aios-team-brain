import "server-only";
import type { DbClient } from "@/lib/db/types";
import { isPrincipal } from "@/lib/access/eligibility";
import { visibleProjects } from "@/lib/access/oracle";
import { findUnpartitionedItems } from "@/lib/projects/context/coverage";
import { GENERAL_SLUG, EXTERNAL_SHARED_SLUG } from "@/lib/access/bootstrap";

/**
 * The STANDING access-health check (PRET-6 §1 — the flip subsystem's readiness scan, re-homed
 * when the subsystem's job completed): "is any human locked out, any agent/connector reading
 * zero, any item unreachable?" — asked of the SAME primitives the enforced read uses (the
 * oracle itself), so a broken group/grant edge shows up as the member actually going blind,
 * never as a plausible-looking table row. Surfaced through the permission inspector's route.
 * Read-only. Under the retired model there is no flip to gate — `blockers` are LOCKOUTS an
 * operator must fix (grants/backfill), `warnings` are read-zero states worth knowing.
 */

export interface BlindPrincipal {
  memberId: string;
  email: string | null;
  kind: string;
  tier: string | null;
}

export interface AccessHealth {
  /** True when NO human principal is locked out and every item is reachable. */
  healthy: boolean;
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
export async function assessAccessHealth(db: DbClient, teamId: string): Promise<AccessHealth> {
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

  // PRET-4 §1c: the required floor derives from EXPLICIT builtin membership, not from tier —
  // otherwise every legitimately cross-enrolled member red-flags after the model changes. One
  // bulk read via the groups module's sanctioned helper (`builtinMembershipBySlug`).
  const { builtinMembershipBySlug } = await import("@/lib/access/groups");
  const builtinRows = await builtinMembershipBySlug(db, teamId);
  for (const m of principals) {
    const { projectIds } = await visibleProjects(db, { teamId, memberId: m.id });
    const identity: BlindPrincipal = { memberId: m.id, email: m.email, kind: m.kind, tier: m.tier };
    if (m.kind === "human") {
      humanPrincipals++;
      // A member in `everyone` must reach BOTH system projects — General (all team content)
      // and external-shared, which holds the team-visible external content they can see
      // today; reaching General alone means they silently lost the external corpus. A member
      // in `external` only must reach external-shared. A member in NEITHER builtin reaches no
      // system project — the lockout warning.
      const inEveryone = builtinRows.everyone.has(m.id);
      const inExternal = builtinRows.external.has(m.id);
      const required = inEveryone
        ? [generalId, externalSharedId]
        : inExternal
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
    healthy: blockers.length === 0,
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

