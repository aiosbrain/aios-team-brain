import "server-only";
import type { DbClient } from "@/lib/db/types";
import { isPrincipal } from "@/lib/access/eligibility";
import { visibleProjects } from "@/lib/access/oracle";
import { findUnpartitionedItems } from "@/lib/projects/context/coverage";
import { GENERAL_SLUG, EXTERNAL_SHARED_SLUG } from "@/lib/access/bootstrap";
import { censusTeamSystemEdges } from "@/lib/access/groups";
import { describeUnsanctionedEdges } from "@/lib/access/system-projects";

/**
 * The STANDING access-health check (PRET-6 §1 — the flip subsystem's readiness scan, re-homed
 * when the subsystem's job completed): "is any human locked out, any agent/connector reading
 * zero, any item unreachable?" — asked of the SAME primitives the enforced read uses (the
 * oracle itself), so a broken group/grant edge shows up as the member actually going blind,
 * never as a plausible-looking table row. Surfaced through the permission inspector's route.
 * Read-only. Under the retired model there is no flip to gate — `blockers` are ACCESS VIOLATIONS an
 * operator must fix (grants/backfill), `warnings` are read-zero states worth knowing.
 */

export interface BlindPrincipal {
  memberId: string;
  email: string | null;
  kind: string;
  tier: string | null;
}

export interface AccessHealth {
  /** True when NO human principal is locked out, every item is reachable, AND no group is let in
   *  that the substrate never sanctioned (AUDITFIX-23). */
  healthy: boolean;
  /** Hard reasons to refuse. AUDITFIX-23 WIDENED this from lock-OUT only: an entry is either a human
   *  locked OUT of content they can see today, or a group let IN that the substrate never sanctioned.
   *  Both are fatal to `healthy`, which is the only contract any consumer depends on. */
  blockers: string[];
  /** Real behaviour changes that are neither a lockout nor an over-exposure — reported, never fatal. */
  warnings: string[];
  itemsScanned: number;
  /** Items with no CURRENT include-membership: invisible to everyone. */
  unpartitioned: { count: number; examples: string[] };
  humanPrincipals: number;
  agentPrincipals: number;
  /** Active humans whose oracle set does NOT include their builtin's system project → blind. */
  blindHumans: BlindPrincipal[];
  /** Active agents the oracle resolves to nothing — expected (agents are never auto-admitted). */
  unplacedAgents: BlindPrincipal[];
  /** Active connector service accounts: they push, and a pull through their key reads nothing. */
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
 * Is anyone blind, is anything unreachable, RIGHT NOW? Read-only.
 *
 * The checks are deliberately derived from the SAME primitives the enforced read uses rather than
 * from a proxy for them: per-member visibility comes from the oracle itself (`visibleProjects`),
 * so a broken group/grant edge anywhere in the chain shows up as the member actually going blind,
 * not as a table row that looks plausible. An inspector that agrees with enforcement is the only
 * kind worth having (the §15.6 rule).
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

  // AUDITFIX-23: the inverse assertion. Every other check here asks "is someone locked OUT"; this one
  // asks "is a group let IN that the substrate never sanctioned" — the state AUDITFIX-3 made
  // uncreatable but that an unaudited instance may already hold, and that no surface reported.
  //
  // It calls the SAME census the scheduled path uses. A second implementation here is the divergence
  // AUDITFIX-15A exists to prevent, and it is also what lets ONE mutation cover both surfaces — a
  // structural guard fails the build if this call goes away.
  //
  // FAILS CLOSED: an undetermined census is a blocker, never a clean bill of health.
  {
    const census = await censusTeamSystemEdges(db, teamId);
    if (!census.ok) {
      blockers.push(`the system-edge census could not complete, so this team's grants are UNVERIFIED: ${census.error}`);
    } else if (census.edges.length > 0) {
      blockers.push(
        `${describeUnsanctionedEdges(census.edges)} — a system project's grants are the access substrate, ` +
          `so these hand their whole corpus to a group that was never sanctioned. Repair is AUDITFIX-21; ` +
          `until then it is a deliberate out-of-band act.`
      );
    }
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
  const customOnlyHumans: BlindPrincipal[] = [];
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
      // system project — the access-violation warning.
      const inEveryone = builtinRows.everyone.has(m.id);
      const inExternal = builtinRows.external.has(m.id);
      if (inEveryone || inExternal) {
        const required = inEveryone ? [generalId, externalSharedId] : [externalSharedId];
        if (required.some((p) => !p || !projectIds.has(p))) blindHumans.push(identity);
      } else if (projectIds.size === 0) {
        // In NEITHER builtin and the oracle resolves nothing — genuinely blind.
        blindHumans.push(identity);
      } else {
        // Codex diff-review Medium: a human in no builtin but with CUSTOM grants is NOT blind —
        // they see their granted projects. Flagging them as "see NOTHING" was false. They still
        // lack the builtin floor (no General/external-shared), which is worth telling the
        // operator — as a warning, never a blocker.
        customOnlyHumans.push(identity);
      }
    } else {
      agentPrincipals++;
      if (projectIds.size === 0) unplacedAgents.push(identity);
    }
  }
  // CONNECTORS are not principals by design (service accounts must never resolve visibility), but
  // `authenticateApiKey` only rejects a non-ACTIVE member — so a pull through a connector key
  // reads NOTHING. Neither a lockout nor an over-exposure, so not a blocker; but a silent integration going
  // empty is exactly the kind of change an operator must be told about.
  // (Live prod check while building this: 4 of that team's 9 active members are connectors.)
  const activeConnectors = all.filter((m) => m.is_connector && m.status === "active");
  if (blindHumans.length > 0) {
    blockers.push(
      `${blindHumans.length} active human member(s) see NOTHING — their groups grant no path to their builtin's system project`
    );
  }
  if (customOnlyHumans.length > 0) {
    warnings.push(
      `${customOnlyHumans.length} active human member(s) are in NO builtin group but hold custom grants — they see their granted projects only, with no General/external-shared floor (deliberate cross-enrollment looks like this; a botched removal does too)`
    );
  }
  if (unplacedAgents.length > 0) {
    warnings.push(
      `${unplacedAgents.length} active agent member(s) are in no granted group and read ZERO items ` +
        `(agents are never auto-admitted to Everyone/External by design — place them explicitly, or their pulls go empty)`
    );
  }
  if (activeConnectors.length > 0) {
    warnings.push(
      `${activeConnectors.length} active connector member(s): a connector is not a principal, so a pull through its key ` +
        `reads ZERO items. Connectors normally only PUSH — check whether any of yours also pulls before you rely on this being harmless`
    );
  }

  // 3. Every item must be partitioned. An un-partitioned item is invisible to EVERYONE, so this
  //    is the check that decides the whole question.
  const unpartitioned = await findUnpartitionedItems(db, teamId);
  if (unpartitioned.count > 0) {
    // ⚠️ DO NOT ENUMERATE THE CAUSES HERE. The original message named exactly one ("the backfill has
    // not completed"), which was the only cause the OLD grant-only predicate could see. AUDITFIX-15A
    // widened the predicate, so I widened the message to name two — and a review produced a
    // counterexample to that too: an active non-connector AGENT in the built-in `everyone` group.
    // Built-ins admit humans only, so the item is correctly unreachable, while BOTH stated causes are
    // false — the backfill completed, and the group does contain an active non-connector agent.
    // Unknown built-in slugs, retracted units, and exclude/closed memberships are further cases.
    //
    // An exhaustive "either/or" is a claim about the whole predicate, and this one has now been wrong
    // twice. Point at what to inspect instead; the examples below say which items.
    blockers.push(
      `${unpartitioned.count} item(s)${unpartitioned.truncated ? "+ (floor — more exist)" : ""} are reachable by NO eligible ` +
        `principal. Inspect, for each: its context unit (active?), its membership (current include?), ` +
        `its project's grants, and whether any granted group holds an ELIGIBLE member — built-in ` +
        `groups admit humans only`
    );
  }
  // The old `else if (truncated)` arm is GONE, not forgotten: under the new contract `truncated`
  // implies `count === MAX_UNREACHABLE`, so the first branch always wins and the arm was dead code
  // describing a batch guard that no longer exists.

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

