import "server-only";
import type { PoolClient } from "pg";
import { canonicalSha256, type CanonicalJson } from "./canonical";
import type { GatewayDecision } from "./types";

export type GatewayPolicyRow = {
  id: string;
  subject_role: "admin" | "lead" | "member" | null;
  subject_tier: "team" | "external" | null;
  subject_actor: string | null;
  action: string;
  resource: string;
  priority: number;
  effect: "allow" | "deny" | "require_approval";
  updated_at: string;
};
export type GatewayPrincipal = {
  actor: string;
  role: "admin" | "lead" | "member";
  tier: "team" | "external";
};
export type GatewayPolicyResult = {
  decision: GatewayDecision;
  policyVersion: string;
  policyRuleId: string | null;
};

const effectRank = { allow: 1, require_approval: 2, deny: 3 } as const;
const decision = (effect: GatewayPolicyRow["effect"]): GatewayDecision =>
  effect === "deny" ? "block" : effect;
export function gatewayPolicyVersion(rows: GatewayPolicyRow[]): string {
  const active = [...rows].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return canonicalSha256(
    active.map((r) => ({
      id: r.id,
      subject_role: r.subject_role,
      subject_tier: r.subject_tier,
      subject_actor: r.subject_actor,
      action: r.action,
      resource: r.resource,
      priority: r.priority,
      effect: r.effect,
      updated_at: r.updated_at,
    })) as CanonicalJson,
  );
}
function subjectSpecificity(
  row: GatewayPolicyRow,
  p: GatewayPrincipal,
): number {
  const dimensions =
    Number(row.subject_actor !== null) +
    Number(row.subject_role !== null) +
    Number(row.subject_tier !== null);
  if (dimensions > 1) return -1;
  if (row.subject_actor !== null) return row.subject_actor === p.actor ? 4 : -1;
  if (row.subject_role !== null) return row.subject_role === p.role ? 3 : -1;
  if (row.subject_tier !== null) return row.subject_tier === p.tier ? 2 : -1;
  return 1;
}

export function evaluateGatewayPolicy(
  rows: GatewayPolicyRow[],
  input: {
    principal: GatewayPrincipal;
    tool: string;
    owner: string;
    repo: string;
  },
): GatewayPolicyResult {
  const action = `gateway.aios-github-readonly.${input.tool}`;
  const resource = `github.repository:${input.owner}/${input.repo}`;
  const active = [...rows].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const policyVersion = gatewayPolicyVersion(active);
  const candidates = active
    .map((row) => ({
      row,
      subject: subjectSpecificity(row, input.principal),
      tool:
        row.action === action
          ? 2
          : row.action === "gateway.aios-github-readonly.*"
            ? 1
            : -1,
      resource:
        row.resource === resource
          ? 2
          : row.resource === "github.repository:*"
            ? 1
            : -1,
    }))
    .filter((x) => x.subject > 0 && x.tool > 0 && x.resource > 0);
  candidates.sort(
    (a, b) =>
      b.subject - a.subject ||
      b.tool - a.tool ||
      b.resource - a.resource ||
      b.row.priority - a.row.priority ||
      effectRank[b.row.effect] - effectRank[a.row.effect] ||
      (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0),
  );
  const winner = candidates[0]?.row;
  return {
    decision: winner ? decision(winner.effect) : "block",
    policyVersion,
    policyRuleId: winner?.id ?? null,
  };
}

export async function loadGatewayPolicies(
  client: PoolClient,
  teamId: string,
): Promise<GatewayPolicyRow[]> {
  const result = await client.query<GatewayPolicyRow>(
    `select id::text, subject_role::text, subject_tier::text, subject_actor, action, resource, priority, effect::text, updated_at::text from policies where team_id=$1 and enabled order by id`,
    [teamId],
  );
  return result.rows;
}
