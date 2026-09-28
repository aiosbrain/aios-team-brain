import { createHash } from "node:crypto";
import { z } from "zod";
import { TASK_STATUSES } from "@/lib/api/schemas";

const scalar = (s: string) => !/[\u0000\uD800-\uDFFF]/u.test(s);
const text = (max: number, min = 1) =>
  z
    .string()
    .refine((s) => scalar(s) && [...s].length >= min && [...s].length <= max);
const nonblank = (max: number) => text(max).refine((s) => /\S/u.test(s));
export const identifier = text(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const due = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const [y, m, d] = s.split("-").map(Number);
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    return (
      y >= 1 &&
      m >= 1 &&
      m <= 12 &&
      d >= 1 &&
      d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    );
  })
  .nullable();
const fields = {
  title: nonblank(500),
  assignee: identifier.nullable(),
  status: z.enum(TASK_STATUSES),
  due,
};
const base = {
  contract_version: z.literal("mcp-next/1"),
  destination: z.object({ project_id: identifier }).strict(),
};
export const submitSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("note.append"),
      params: z
        .object({ title: nonblank(200), body: nonblank(25000) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("task.create"),
      params: z.object({ operation_id: identifier, ...fields }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("task.update"),
      params: z
        .object({
          operation_id: identifier,
          task_id: identifier,
          expected_revision: text(128),
          changes: z
            .object(fields)
            .partial()
            .strict()
            .refine((v) => Object.keys(v).length > 0),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("decision.record"),
      params: z
        .object({
          operation_id: identifier,
          title: nonblank(500),
          rationale: nonblank(25000),
          impact: text(5000, 0),
        })
        .strict(),
    })
    .strict(),
]);
export type SubmitRequest = z.infer<typeof submitSchema>;
export type ActionType = SubmitRequest["type"];
export const errorSchema = z
  .object({
    code: z.enum([
      "invalid_payload",
      "unauthorized",
      "not_found",
      "forbidden",
      "revoked_authorization",
      "stale_revision",
      "operation_id_conflict",
      "mapping_required",
      "upgrade_required",
      "capability_unavailable",
      "rate_limited",
      "execution_failed",
      "operation_in_progress",
      "unavailable",
    ]),
    message: text(1000),
    retryable: z.boolean(),
    recovery: text(1000),
  })
  .strict()
  .refine((v) => v.code !== "unavailable" || v.retryable);
export type ActionError = z.infer<typeof errorSchema>;
export const effectSchema = z
  .object({
    entity: z
      .object({
        kind: z.enum(["note", "task", "decision"]),
        id: identifier,
        revision: text(128),
      })
      .strict(),
    sync: z
      .object({
        state: z.enum([
          "not_applicable",
          "pending",
          "synced",
          "conflict",
          "failed",
        ]),
        providers: z
          .array(
            z
              .object({
                provider: z.enum(["linear", "plane"]),
                state: z.enum(["pending", "synced", "conflict", "failed"]),
                error_code: text(100, 0).nullable(),
              })
              .strict(),
          )
          .max(2),
      })
      .strict(),
  })
  .strict();
export type ConsumerResult = z.infer<typeof effectSchema>;
const identity = {
  contract_version: z.literal("mcp-next/1"),
  action_id: identifier,
  audit_ref: identifier,
};
export const statusSchema = z.union([
  z
    .object({
      ...identity,
      status: z.literal("succeeded"),
      ...effectSchema.shape,
    })
    .strict(),
  z
    .object({
      ...identity,
      status: z.literal("pending_approval"),
      approval_request_id: identifier,
    })
    .strict(),
  z
    .object({
      ...identity,
      status: z.enum(["denied", "failed", "conflict"]),
      error: errorSchema,
    })
    .strict(),
  z.object({ ...identity, status: z.enum(["requested", "running"]) }).strict(),
]);
export type ActionStatus = z.infer<typeof statusSchema>;
export function parseSubmitRequest(value: unknown): SubmitRequest {
  return submitSchema.parse(value);
}
export function validateStatus(value: unknown): ActionStatus {
  return statusSchema.parse(value);
}
/** RFC 8785 for this closed string/object-only request vocabulary (no numeric inputs). */
export function canonicalRequest(value: unknown): string {
  if (Array.isArray(value))
    return "[" + value.map(canonicalRequest).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonicalRequest((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
export function operationKey(
  request: SubmitRequest,
  memberId: string,
  teamId: string,
  projectId: string,
): string {
  return request.type === "note.append"
    ? hash(
        canonicalRequest([
          "note/1",
          memberId,
          teamId,
          projectId,
          request.params.title,
          request.params.body,
        ]),
      )
    : request.params.operation_id;
}
