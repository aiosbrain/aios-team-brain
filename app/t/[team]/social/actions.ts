"use server";

import { revalidatePath } from "next/cache";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import { discoverOpportunities } from "@/lib/social/discover";
import { discoverOpportunitiesFromArcs } from "@/lib/social/discover-arcs";
import { planOpportunity } from "@/lib/social/plan";
import { generatePlanDrafts } from "@/lib/social/generate";
import { generateVariantImage, imageBudget } from "@/lib/media/generate-image";
import { setAutonomy, setPublishDryRun } from "@/lib/social/settings";
import { submitForApproval, decideApproval } from "@/lib/social/approvals";
import { scheduleVariant, cancelScheduledPublication } from "@/lib/social/publish";
import { runCollectAnalytics } from "@/lib/social/collect-analytics";
import { saveTypefully } from "@/lib/integrations/typefully";
import type { AutonomyLevel } from "@/lib/social/autonomy";

type DiscoverResult = { ok: boolean; created?: number; skipped?: number; scanned?: number; error?: string };

/** Run content discovery over recent brain knowledge (admins only). */
/** ENFB-4 (round 1 H4): the action-level parent gate — the target's chain must be
 *  EVERY-visible to the acting admin, else the action's existing not-found shape. ONE
 *  resolver (store.actorSeesChain) so the seven actions cannot drift. */
async function actorChainGate(
  teamId: string,
  memberId: string,
  ref: { opportunityId?: string; planId?: string; variantId?: string; publicationId?: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { visibleItemIds } = await import("@/lib/access/enforce");
  const { actorSeesChain } = await import("@/lib/social/store");
  const vis = await visibleItemIds(adminClient(), { teamId, memberId });
  if (vis.error) return { ok: false, error: "visibility resolution failed" };
  if (!(await actorSeesChain(adminClient(), teamId, ref, vis.ids))) {
    return { ok: false, error: "not found for team" };
  }
  return { ok: true };
}

export async function discoverNow(teamSlug: string): Promise<DiscoverResult> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    // ENFB-4: the scan is bounded to the acting admin's oracle set (fail closed on error).
    const { visibleItemIds } = await import("@/lib/access/enforce");
    const vis = await visibleItemIds(adminClient(), { teamId: ctx.teamId, memberId: ctx.memberId });
    if (vis.error) return { ok: false, error: "visibility resolution failed" };
    const s = await discoverOpportunities(adminClient(), ctx.teamId, { actor: { memberId: ctx.memberId }, visibleItemIds: vis.ids });
    revalidatePath(`/t/${teamSlug}/social`);
    return { ok: true, created: s.created, skipped: s.skipped, scanned: s.scanned };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "discovery failed" };
  }
}

/**
 * Discover opportunities from the team's narrative arcs (admins only). Sources from the team-tier
 * arc set; each opportunity is created at its tier-safe access (an arc built from internal evidence
 * stays `team` and can't become a public post). Idempotent by `arc:<id>`.
 */
export async function discoverFromArcsNow(teamSlug: string): Promise<DiscoverResult> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    const db = adminClient();
    const keys = await resolveAnsweringKeys(db, ctx.teamId);
    // PRET-3 (spec §1, a STATED product change on enforcing teams): discovery mines the arcs
    // the ACTING ADMIN can see — their oracle scope on an enforcing team, the built-in
    // partitions on a permissive one — not a hardcoded tier union that ignored enforcement.
    const { resolveArcScope } = await import("@/lib/graph/partition-read");
    const scope = await resolveArcScope(db, { teamId: ctx.teamId, teamSlug, memberId: ctx.memberId, tier: "team" });
    const s = await discoverOpportunitiesFromArcs(db, ctx.teamId, teamSlug, "team", scope.groups, keys, {
      actor: { memberId: ctx.memberId },
    });
    revalidatePath(`/t/${teamSlug}/social`);
    return { ok: true, created: s.created, skipped: s.skipped, scanned: s.scanned };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "arc discovery failed" };
  }
}

/** Plan an opportunity into platform variants (admins only). Idempotent. */
export async function planNow(
  teamSlug: string,
  opportunityId: string
): Promise<{ ok: boolean; variants?: number; created?: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const gate = await actorChainGate(ctx.teamId, ctx.memberId, { opportunityId });
  if (!gate.ok) return gate;
  try {
    const r = await planOpportunity(adminClient(), ctx.teamId, opportunityId, { memberId: ctx.memberId });
    revalidatePath(`/t/${teamSlug}/social`);
    return { ok: true, variants: r.variants.length, created: r.created };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "planning failed" };
  }
}

/** Generate drafts for an opportunity's variants, in-brand + governance-gated (admins only). */
export async function generateDrafts(
  teamSlug: string,
  opportunityId: string
): Promise<{ ok: boolean; generated?: number; blocked?: number; failed?: number; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const gate = await actorChainGate(ctx.teamId, ctx.memberId, { opportunityId });
  if (!gate.ok) return gate;
  try {
    const { visibleItemIds: vres } = await import("@/lib/access/enforce");
    const genVis = await vres(adminClient(), { teamId: ctx.teamId, memberId: ctx.memberId });
    if (genVis.error) return { ok: false, error: "visibility resolution failed" };
    const s = await generatePlanDrafts(adminClient(), ctx.teamId, opportunityId, { actorVisibleItemIds: genVis.ids });
    revalidatePath(`/t/${teamSlug}/social`);
    return { ok: true, generated: s.generated, blocked: s.blocked, failed: s.failed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "generation failed" };
  }
}

/** Set the team's autonomy level (admins only). */
export async function setAutonomyLevel(
  teamSlug: string,
  level: AutonomyLevel
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await setAutonomy(adminClient(), ctx.teamId, level, { memberId: ctx.memberId });
    revalidatePath(`/t/${teamSlug}/social`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not set autonomy" };
  }
}

/** Submit a generated variant for approval (admins only). Routed by autonomy. */
export async function submitApproval(
  teamSlug: string,
  variantId: string
): Promise<{ ok: boolean; outcome?: string; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const gate = await actorChainGate(ctx.teamId, ctx.memberId, { variantId });
  if (!gate.ok) return gate;
  try {
    const r = await submitForApproval(adminClient(), ctx.teamId, variantId, { memberId: ctx.memberId });
    revalidatePath(`/t/${teamSlug}/social`);
    return { ok: true, outcome: r.outcome };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not submit" };
  }
}

/** Approve or deny a pending content approval (admins only). */
export async function decideContentApproval(
  teamSlug: string,
  approvalId: string,
  decision: "approved" | "denied",
  note: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  // ENFB-4 H4: the approval's variant chain must be EVERY-visible to the decider.
  const { data: approvalRow } = await adminClient()
    .from("content_approvals")
    .select("variant_id")
    .eq("team_id", ctx.teamId)
    .eq("id", approvalId)
    .maybeSingle();
  if (!approvalRow) return { ok: false, error: "not found for team" };
  const decideGate = await actorChainGate(ctx.teamId, ctx.memberId, { variantId: (approvalRow as { variant_id: string }).variant_id });
  if (!decideGate.ok) return decideGate;
  try {
    await decideApproval(adminClient(), ctx.teamId, approvalId, decision, note, { memberId: ctx.memberId });
    revalidatePath(`/t/${teamSlug}/social`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not decide" };
  }
}

/** Connect (or update) Typefully — the publishing key + social-set id (admins only). */
export async function connectTypefully(
  teamSlug: string,
  input: { key?: string; socialSetId?: string }
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await saveTypefully(adminClient(), { teamId: ctx.teamId, memberId: ctx.memberId }, input);
    revalidatePath(`/t/${teamSlug}/social`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not save Typefully key" };
  }
}

/** Toggle publish dry-run mode (admins only). */
export async function setDryRun(teamSlug: string, dryRun: boolean): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await setPublishDryRun(adminClient(), ctx.teamId, dryRun, { memberId: ctx.memberId });
    revalidatePath(`/t/${teamSlug}/social`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not set dry-run" };
  }
}

/** Schedule/publish an approved variant (admins only). `at` empty = publish now. */
export async function scheduleVariantAction(
  teamSlug: string,
  variantId: string,
  at?: string
): Promise<{ ok: boolean; dryRun?: boolean; warning?: string; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const gate = await actorChainGate(ctx.teamId, ctx.memberId, { variantId });
  if (!gate.ok) return gate;
  try {
    const when = at && at.trim() ? new Date(at) : undefined;
    if (when && Number.isNaN(when.getTime())) return { ok: false, error: "invalid schedule time" };
    const pub = await scheduleVariant(adminClient(), ctx.teamId, variantId, { at: when, actor: { memberId: ctx.memberId } });
    revalidatePath(`/t/${teamSlug}/social`);
    // audit #9: a job was enqueued, but nothing drains the queue unless the poller is enabled — so a
    // "scheduled" post would silently never go out. Surface that instead of a false success.
    const warning =
      process.env.SOCIAL_JOBS_ENABLED === "true"
        ? undefined
        : "scheduled, but the job poller is off (SOCIAL_JOBS_ENABLED unset) — this post will not run until it's enabled";
    return { ok: true, dryRun: pub.dry_run, warning };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not schedule" };
  }
}

/** Cancel a scheduled/pending publication so it never posts (admins only). audit #6. */
export async function cancelPublicationAction(
  teamSlug: string,
  publicationId: string
): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const gate = await actorChainGate(ctx.teamId, ctx.memberId, { publicationId });
  if (!gate.ok) return gate;
  try {
    const { cancelled } = await cancelScheduledPublication(adminClient(), ctx.teamId, publicationId, {
      memberId: ctx.memberId,
    });
    revalidatePath(`/t/${teamSlug}/social`);
    return { ok: true, cancelled };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not cancel" };
  }
}

/** Collect/refresh analytics for a publication now (admins only). */
/** ENFB-4: the ONE stated action exemption (round 2 H5) — analytics refresh moves COUNTS
 *  only (no title/body leaves or enters), the same metrics ruling as the analytics reads. */
export async function refreshAnalytics(teamSlug: string, publicationId: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await runCollectAnalytics(adminClient(), ctx.teamId, publicationId);
    revalidatePath(`/t/${teamSlug}/social`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not refresh analytics" };
  }
}

/** Generate an image for a variant (admins only). Opt-in + daily-capped. */
export async function generateImage(
  teamSlug: string,
  variantId: string
): Promise<{ ok: boolean; remaining?: number; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const imgGate = await actorChainGate(ctx.teamId, ctx.memberId, { variantId });
  if (!imgGate.ok) return imgGate;
  try {
    const db = adminClient();
    await generateVariantImage(db, ctx.teamId, variantId, { actor: { memberId: ctx.memberId } });
    const budget = await imageBudget(db, ctx.teamId);
    revalidatePath(`/t/${teamSlug}/social`);
    return { ok: true, remaining: budget.remaining };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "image generation failed" };
  }
}
