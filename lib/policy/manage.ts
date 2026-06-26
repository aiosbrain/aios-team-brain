import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/api/audit";
import type { PolicyEffect } from "./evaluate";

/**
 * The single write path for the `policies` table — what the admin Policies editor calls. Validates
 * the rule shape and audits every change, so policy authoring is centralized + traceable (the
 * pure evaluator in ./evaluate decides; this just stores the rules it reads). Reads via
 * `listAllPolicies` (incl. disabled, for the editor); `lib/policy.loadPolicies` loads enabled-only
 * for `authorize()`.
 */

const EFFECTS: PolicyEffect[] = ["allow", "deny", "require_approval"];
const ROLES = ["admin", "lead", "member"];
const TIERS = ["team", "external"];

export interface PolicyInput {
  description?: string;
  priority?: number;
  subjectRole?: "admin" | "lead" | "member" | null;
  subjectTier?: "team" | "external" | null;
  subjectActor?: string | null;
  action: string;
  resource?: string;
  effect: PolicyEffect;
  enabled?: boolean;
}

export interface PolicyRecord {
  id: string;
  priority: number;
  description: string;
  subject_role: string | null;
  subject_tier: string | null;
  subject_actor: string | null;
  action: string;
  resource: string;
  effect: PolicyEffect;
  enabled: boolean;
}

export interface PolicyActor {
  memberId?: string | null;
}

function validate(input: PolicyInput): void {
  if (!input.action?.trim()) throw new Error("action is required (e.g. \"code.run\" or \"item.*\")");
  if (!EFFECTS.includes(input.effect)) throw new Error(`invalid effect "${input.effect}"`);
  if (input.subjectRole && !ROLES.includes(input.subjectRole)) throw new Error("invalid subject role");
  if (input.subjectTier && !TIERS.includes(input.subjectTier)) throw new Error("invalid subject tier");
  if (input.priority != null && !Number.isInteger(input.priority)) throw new Error("priority must be an integer");
}

/** The mutable rule fields (shared by create + update). */
function fields(input: PolicyInput) {
  return {
    priority: input.priority ?? 0,
    description: (input.description ?? "").trim(),
    subject_role: input.subjectRole ?? null,
    subject_tier: input.subjectTier ?? null,
    subject_actor: (input.subjectActor ?? "").trim() || null,
    action: input.action.trim(),
    resource: (input.resource ?? "*").trim() || "*",
    effect: input.effect,
    enabled: input.enabled ?? true,
  };
}

export async function listAllPolicies(supabase: SupabaseClient, teamId: string): Promise<PolicyRecord[]> {
  const { data, error } = await supabase
    .from("policies")
    .select("id, priority, description, subject_role, subject_tier, subject_actor, action, resource, effect, enabled")
    .eq("team_id", teamId)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`policy list failed: ${error.message}`);
  return (data ?? []) as PolicyRecord[];
}

export async function createPolicy(
  supabase: SupabaseClient,
  teamId: string,
  input: PolicyInput,
  actor: PolicyActor = {}
): Promise<string> {
  validate(input);
  const { data, error } = await supabase
    .from("policies")
    .insert({ team_id: teamId, created_by: actor.memberId ?? null, ...fields(input) })
    .select("id")
    .single();
  if (error || !data) throw new Error(`policy create failed: ${error?.message}`);
  await audit(supabase, {
    team_id: teamId, actor_kind: "member", member_id: actor.memberId ?? null,
    action: "policy.created", target_type: "policy", target_id: data.id,
    meta: { action: input.action, effect: input.effect, resource: input.resource ?? "*" },
  });
  return data.id;
}

export async function updatePolicy(
  supabase: SupabaseClient,
  teamId: string,
  id: string,
  input: PolicyInput,
  actor: PolicyActor = {}
): Promise<void> {
  validate(input);
  const { error } = await supabase
    .from("policies")
    .update({ ...fields(input), updated_at: new Date().toISOString() })
    .eq("team_id", teamId)
    .eq("id", id);
  if (error) throw new Error(`policy update failed: ${error.message}`);
  await audit(supabase, {
    team_id: teamId, actor_kind: "member", member_id: actor.memberId ?? null,
    action: "policy.updated", target_type: "policy", target_id: id,
    meta: { action: input.action, effect: input.effect },
  });
}

export async function setPolicyEnabled(
  supabase: SupabaseClient,
  teamId: string,
  id: string,
  enabled: boolean,
  actor: PolicyActor = {}
): Promise<void> {
  const { error } = await supabase
    .from("policies")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("team_id", teamId)
    .eq("id", id);
  if (error) throw new Error(`policy toggle failed: ${error.message}`);
  await audit(supabase, {
    team_id: teamId, actor_kind: "member", member_id: actor.memberId ?? null,
    action: enabled ? "policy.enabled" : "policy.disabled", target_type: "policy", target_id: id, meta: {},
  });
}

export async function deletePolicy(
  supabase: SupabaseClient,
  teamId: string,
  id: string,
  actor: PolicyActor = {}
): Promise<void> {
  const { error } = await supabase.from("policies").delete().eq("team_id", teamId).eq("id", id);
  if (error) throw new Error(`policy delete failed: ${error.message}`);
  await audit(supabase, {
    team_id: teamId, actor_kind: "member", member_id: actor.memberId ?? null,
    action: "policy.deleted", target_type: "policy", target_id: id, meta: {},
  });
}
