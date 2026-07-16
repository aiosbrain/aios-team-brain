import type { GatewayPolicyInput } from "./admin-persistence";
import { exactObject, isUuid } from "./http";

export function parseGatewayPolicyInput(value: unknown): GatewayPolicyInput | null {
  if (
    !exactObject(value, [
      "subject",
      "tool",
      "resource",
      "effect",
      "priority",
      "enabled",
      "correlationId",
    ]) ||
    typeof value.tool !== "string" ||
    typeof value.resource !== "string" ||
    !["block", "require_approval", "allow"].includes(String(value.effect)) ||
    !Number.isInteger(value.priority) ||
    typeof value.enabled !== "boolean" ||
    !isUuid(value.correlationId)
  )
    return null;
  const subject = value.subject;
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) return null;
  const record = subject as Record<string, unknown>;
  let parsed: GatewayPolicyInput["subject"];
  if (record.type === "team" && exactObject(record, ["type"])) {
    parsed = { type: "team" };
  } else if (
    record.type === "actor" &&
    exactObject(record, ["type", "memberId"]) &&
    isUuid(record.memberId)
  ) {
    parsed = { type: "actor", memberId: record.memberId };
  } else if (
    record.type === "role" &&
    exactObject(record, ["type", "role"]) &&
    ["admin", "lead", "member"].includes(String(record.role))
  ) {
    parsed = {
      type: "role",
      role: record.role as "admin" | "lead" | "member",
    };
  } else if (
    record.type === "tier" &&
    exactObject(record, ["type", "tier"]) &&
    ["team", "external"].includes(String(record.tier))
  ) {
    parsed = { type: "tier", tier: record.tier as "team" | "external" };
  } else {
    return null;
  }
  return {
    subject: parsed,
    tool: value.tool,
    resource: value.resource,
    effect: value.effect as GatewayPolicyInput["effect"],
    priority: value.priority as number,
    enabled: value.enabled,
    correlationId: value.correlationId,
  };
}
