import "server-only";
import { z } from "zod";
import { runSql } from "@/lib/db/pg/pool";
import { completeTextOrNull } from "@/lib/llm/complete";
import type { LlmBackendKeys } from "@/lib/query/llm-backend";
import type { LlmMeterCtx } from "@/lib/costs/llm-usage";

/**
 * Natural-language attribution CORRECTION. An admin describes a fix in plain language ("the Linear
 * docs under aio/ are Fatma's", "meeting notes aren't anyone's work"); the team's LLM turns it into a
 * STRUCTURED, constrained `CorrectionPlan` (never free-form DB actions); we PREVIEW the exact items it
 * would touch (read-only); the admin confirms; and `lib/ingest/attribution-correction` applies it
 * through the single-writer, audited. Safety is layered: the plan schema is closed, a match must be
 * scoped (never "all items"), and nothing mutates until the admin sees the blast radius. See
 * docs/design/attribution-architecture.md §7.
 *
 * This module is READ-ONLY (parse + preview). The write lives in `lib/ingest` (single-writer guard).
 */

/** MVP correction: reassign the items matching a scoped filter to one member (or clear to nobody). */
export const reassignPlanSchema = z
  .object({
    kind: z.literal("reassign"),
    match: z
      .object({
        // Exact single item — the "correct this one" affordance from the drill-down (a UUID targets one
        // row precisely, unlike pathPrefix which is a prefix + can span projects). Not LLM-emitted.
        itemId: z.string().uuid().optional(),
        source: z.string().max(60).optional(),
        pathPrefix: z.string().max(300).optional(),
        onlyUnattributed: z.boolean().optional(),
        fromMemberName: z.string().max(120).optional(),
      })
      .refine((m) => !!(m.itemId || m.source || m.pathPrefix || m.onlyUnattributed || m.fromMemberName), {
        message: "match must be scoped — refusing an unbounded correction",
      }),
    // Target: an email/handle/name to resolve against the roster, or an explicit "nobody" to clear.
    toMember: z.string().min(1).max(200),
  })
  .strict();

export const correctionPlanSchema = reassignPlanSchema; // union point for future correction kinds
export type CorrectionPlan = z.infer<typeof correctionPlanSchema>;

/** Compact team context that grounds the LLM: real members (targets) + the sources actually present. */
export interface CorrectionContext {
  members: { name: string; email: string | null }[];
  sources: string[];
}

export async function buildCorrectionContext(teamId: string): Promise<CorrectionContext> {
  const [members, sources] = await Promise.all([
    runSql<{ name: string | null; email: string | null }>(
      `select display_name as name, email from members
        where team_id = $1 and is_connector is not true and status = 'active' order by display_name`,
      [teamId]
    ),
    runSql<{ source: string }>(
      `select distinct coalesce(nullif(trim(lower(frontmatter->>'source')), ''), kind::text) as source
         from items where team_id = $1`,
      [teamId]
    ),
  ]);
  return {
    members: members.rows.map((r) => ({ name: r.name ?? "(unknown)", email: r.email })),
    sources: sources.rows.map((r) => r.source),
  };
}

const SYSTEM = [
  "You convert an admin's plain-language attribution correction into ONE JSON object matching this shape:",
  '{"kind":"reassign","match":{"source"?:string,"pathPrefix"?:string,"onlyUnattributed"?:boolean,"fromMemberName"?:string},"toMember":string}',
  "- `match` selects the items to re-attribute; include ONLY the criteria the instruction implies, and it MUST be scoped (at least one of source/pathPrefix/onlyUnattributed/fromMemberName) — never match everything.",
  "- `source` must be one of the team's known sources. `pathPrefix` is a leading path fragment. `fromMemberName` limits to items currently attributed to that person.",
  '- `toMember` is who to credit: a member name or email from the roster, or the literal "nobody" to clear attribution (e.g. "meeting notes aren\'t anyone\'s work").',
  "Return ONLY the JSON object. If the instruction is too vague to build a scoped match, return {}.",
].join("\n");

/** Ask the team's LLM to turn the instruction into a validated plan; null when unparseable/too vague. */
export async function parseCorrectionPlan(
  instruction: string,
  ctx: CorrectionContext,
  keys: LlmBackendKeys,
  meter?: LlmMeterCtx
): Promise<CorrectionPlan | null> {
  const user = [
    `Known members: ${ctx.members.map((m) => (m.email ? `${m.name} <${m.email}>` : m.name)).join("; ") || "(none)"}`,
    `Known sources: ${ctx.sources.join(", ") || "(none)"}`,
    `Instruction: ${instruction}`,
  ].join("\n");
  const raw = await completeTextOrNull(
    { system: SYSTEM, prompt: user },
    { keys, jsonObject: true, maxTokens: 400, meter: meter ? { ...meter, source: "attribution" } : undefined }
  );
  if (!raw) return null;
  try {
    const parsed = correctionPlanSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const NOBODY = new Set(["nobody", "no one", "noone", "none", "unattributed", "no-one"]);

/** Resolve a plan's `toMember` → a target. `memberId: null` + `clear: true` means "attribute to nobody".
 *  `error` when the name is unknown or ambiguous (so the admin fixes the instruction, never a silent
 *  mis-apply). Pure over an already-fetched roster. */
export function resolveTarget(
  members: { id: string; name: string; email: string | null }[],
  toMember: string
): { memberId: string | null; clear: boolean; label: string; error?: string } {
  const t = toMember.trim().toLowerCase();
  if (!t) return { memberId: null, clear: false, label: toMember, error: "name a target member (or \"nobody\")" };
  if (NOBODY.has(t)) return { memberId: null, clear: true, label: "nobody" };
  const byEmail = members.filter((m) => (m.email ?? "").toLowerCase() === t);
  const byName = members.filter((m) => m.name.toLowerCase() === t || m.name.toLowerCase().includes(t));
  const hits = byEmail.length ? byEmail : byName;
  if (hits.length === 0) return { memberId: null, clear: false, label: toMember, error: `no team member matches "${toMember}"` };
  if (hits.length > 1) return { memberId: null, clear: false, label: toMember, error: `"${toMember}" is ambiguous (${hits.map((h) => h.name).join(", ")})` };
  return { memberId: hits[0].id, clear: false, label: hits[0].name };
}

/** The items a plan's `match` selects: `{id, path}`, capped. Read-only; shared by preview + apply so
 *  they can't diverge. `fromMemberId` is the resolved id for a `fromMemberName` match (pass null when
 *  the plan has no such criterion). */
export async function matchItems(
  teamId: string,
  plan: CorrectionPlan,
  fromMemberId: string | null,
  cap = 5000
): Promise<{ id: string; path: string }[]> {
  const where: string[] = ["team_id = $1"];
  const params: unknown[] = [teamId];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("$$", `$${params.length}`));
  };
  if (plan.match.itemId) add("id = $$", plan.match.itemId); // exact single item (drill-down "correct this")
  if (plan.match.source) add("coalesce(nullif(trim(lower(frontmatter->>'source')), ''), kind::text) = $$", plan.match.source.toLowerCase());
  if (plan.match.pathPrefix) add("path like $$", plan.match.pathPrefix.replace(/[%_\\]/g, "\\$&") + "%");
  if (plan.match.onlyUnattributed) where.push("member_id is null");
  if (fromMemberId) add("member_id = $$", fromMemberId);
  const { rows } = await runSql<{ id: string; path: string }>(
    `select id, path from items where ${where.join(" and ")} order by updated_at desc limit ${cap}`,
    params
  );
  return rows;
}

/** The fully-resolved correction — target member, the exact matched items, or a human-fixable error.
 *  The ONE resolution path shared by preview (read) and apply (write) so they can never diverge. */
export interface ResolvedCorrection {
  target: { memberId: string | null; clear: boolean; label: string };
  matched: { id: string; path: string }[];
  capped: boolean;
  error?: string;
}

export async function resolveCorrection(teamId: string, plan: CorrectionPlan): Promise<ResolvedCorrection> {
  const { rows: memberRows } = await runSql<{ id: string; name: string | null; email: string | null }>(
    `select id, display_name as name, email from members
      where team_id = $1 and is_connector is not true and status = 'active'`,
    [teamId]
  );
  const members = memberRows.map((m) => ({ id: m.id, name: m.name ?? "(unknown)", email: m.email }));
  const fail = (error: string): ResolvedCorrection => ({ target: { memberId: null, clear: false, label: plan.toMember }, matched: [], capped: false, error });

  const target = resolveTarget(members, plan.toMember);
  if (target.error) return fail(target.error);

  let fromMemberId: string | null = null;
  if (plan.match.fromMemberName) {
    const from = resolveTarget(members, plan.match.fromMemberName);
    if (from.error || !from.memberId) return fail(`couldn't resolve "from" member: ${from.error ?? "not found"}`);
    fromMemberId = from.memberId;
  }
  const matched = await matchItems(teamId, plan, fromMemberId);
  return { target: { memberId: target.memberId, clear: target.clear, label: target.label }, matched, capped: matched.length >= 5000 };
}

export interface CorrectionPreview {
  plan: CorrectionPlan;
  target: { label: string; clear: boolean };
  matchedCount: number;
  samplePaths: string[];
  capped: boolean;
  error?: string;
}

/** Read-only preview: resolve, then surface the count + a few sample paths. Never writes. */
export async function previewCorrection(teamId: string, plan: CorrectionPlan): Promise<CorrectionPreview> {
  const r = await resolveCorrection(teamId, plan);
  return {
    plan,
    target: { label: r.target.label, clear: r.target.clear },
    matchedCount: r.matched.length,
    samplePaths: r.matched.slice(0, 5).map((i) => i.path),
    capped: r.capped,
    error: r.error,
  };
}
