import "server-only";
import type { DbClient } from "@/lib/db/types";
import { enqueueJob, registerJobHandler, type JobHandler } from "@/lib/jobs";
import { getTypefullyCredentials } from "@/lib/integrations/typefully";
import { getBrandProfile } from "@/lib/brand/manage";
import { getVariant, setVariantStatus } from "./store";
import { getPublishDryRun } from "./settings";
import { cancelPublication, createPublication, getPublication, setPublicationState, type PublicationRow } from "./publications";
import { scheduleAnalyticsCollection } from "./collect-analytics";
import { governanceFromBrand, validateContent } from "./validate";
import { typefullyProvider } from "./providers/typefully";
import type { SocialPublishingProvider } from "./providers/types";
import type { VariantRow } from "./types";

/**
 * Publishing (Social Brain M5). An APPROVED, EXTERNAL variant is scheduled: a publication row is
 * created and a `publish` job is enqueued on the durable M0 runner (`run_after` = the scheduled
 * time). The job handler runs the provider call and advances the publication + variant. NEVER
 * auto-publishes — scheduling is always an explicit admin action; even `fully_autonomous` still
 * requires the click for V1. Dry-run (the default, `social_settings.publish_dry_run`) records a
 * publication without calling any provider, so the whole path is exercisable with nothing going live.
 *
 * The DOOR is fail-closed (2026-07-16 audit #1/#3/#6). Every safety property is CHECKED AT CREATION
 * time, but `runPublication` fires much later off a row it must not blindly trust — so it RE-VERIFIES,
 * at fire time, the three things that keep team content off public networks:
 *   1. tier      — only `access==='external'` content is ever posted (internal never leaks);
 *   2. status    — the variant must still be in the publish lifecycle (a regenerate/reject aborts it);
 *   3. governance — the CURRENT body is re-run through the brand gate (a regenerated body may violate);
 * and it re-reads the LIVE dry-run setting so flipping the toggle back on stops a pending post.
 * A door refusal is a POLICY stop, not a transient error: the publication is cancelled (terminal),
 * never requeued.
 */

// V1 targets X + LinkedIn (matches the variant set the planner produces).
const PLATFORMS = ["x", "linkedin"];

// Fire-time variant statuses that still legitimately belong to an in-flight publish. A variant that
// has reverted OUT of this set (e.g. regenerated → 'rejected'/'generated', or unapproved) must NOT
// fire. `failed`/`publishing` are included so a retry after a transient provider error still runs.
const PUBLISHABLE_STATUSES = new Set(["scheduled", "publishing", "failed"]);

export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
}

/**
 * Would publishing this variant right now leak or violate policy? Returns a human reason to refuse,
 * or null when it's safe to post. Fail-closed: only `external` + in-lifecycle + governance-clean
 * content passes. Shared by `scheduleVariant` (reject up front) and `runPublication` (the door).
 */
export async function publishRefusalReason(
  db: DbClient,
  teamId: string,
  variant: VariantRow,
  opts: { requirePublishable?: boolean } = {}
): Promise<string | null> {
  if (variant.access !== "external") {
    return `only external (public) content can be published — variant is '${variant.access}' (internal)`;
  }
  if (opts.requirePublishable && !PUBLISHABLE_STATUSES.has(variant.status)) {
    return `variant is no longer scheduled to publish (status '${variant.status}')`;
  }
  const brand = await getBrandProfile(db, teamId);
  const result = validateContent(variant.body, governanceFromBrand(brand));
  if (!result.ok) {
    return `governance gate blocks the current body: ${result.violations.map((v) => `${v.rule}(${v.term})`).join(", ")}`;
  }
  return null;
}

/**
 * Terminally stop a publication at the door (a policy refusal or the dry-run brake). Cancels the
 * publication and — only if the variant is still mid-publish (`PUBLISHABLE_STATUSES`) — rewinds it to
 * `rewindTo`, so it's never stranded in `scheduled`/`publishing` with no exit. A variant that already
 * left the lifecycle (e.g. regenerated → `rejected`) is left untouched.
 */
async function abortPublication(
  db: DbClient,
  teamId: string,
  pub: PublicationRow,
  variant: VariantRow,
  reason: string,
  rewindTo: "approved" | "rejected"
): Promise<void> {
  await setPublicationState(db, teamId, pub.id, { status: "cancelled", last_error: reason.slice(0, 2000) });
  if (PUBLISHABLE_STATUSES.has(variant.status)) {
    await setVariantStatus(db, teamId, variant.id, rewindTo);
  }
}

/**
 * Finalize an already-posted publication as `published` (idempotent re-entry, audit #2) — keeps the
 * external id already persisted, advances the variant, and (best-effort) schedules analytics. Used
 * when a prior attempt posted but crashed before marking published, so we never re-post. The variant
 * is stamped `published` ONLY if it's still mid-publish — if it left the lifecycle between attempts
 * (regenerated → `generated`/`rejected`), the publication record stays honest but we don't clobber the
 * variant with a `published` status whose body no longer matches what actually posted.
 */
async function finalizePublished(
  db: DbClient,
  teamId: string,
  publicationId: string,
  variant: VariantRow
): Promise<void> {
  await setPublicationState(db, teamId, publicationId, {
    status: "published",
    published_at: new Date().toISOString(),
    last_error: null,
  });
  if (PUBLISHABLE_STATUSES.has(variant.status)) {
    await setVariantStatus(db, teamId, variant.id, "published");
  }
  await scheduleAnalyticsCollection(db, teamId, publicationId).catch(() => {});
}

/** Schedule an approved variant for publishing. Returns the created publication. */
export async function scheduleVariant(
  db: DbClient,
  teamId: string,
  variantId: string,
  opts: { at?: Date; actor?: { memberId?: string | null } } = {}
): Promise<PublicationRow> {
  const variant = await getVariant(db, teamId, variantId);
  if (!variant) throw new Error(`scheduleVariant: variant ${variantId} not found for team`);
  if (variant.status !== "approved") {
    throw new PublishError(`variant must be 'approved' to publish (is '${variant.status}')`);
  }
  // Fail-closed at the door: never even schedule internal or gate-violating content.
  const refusal = await publishRefusalReason(db, teamId, variant);
  if (refusal) throw new PublishError(refusal);

  const dryRun = await getPublishDryRun(db, teamId);
  const scheduledAt = opts.at ?? new Date();
  const pub = await createPublication(
    db,
    teamId,
    { variantId, access: variant.access, dryRun, scheduledAt: scheduledAt.toISOString() },
    opts.actor ?? {}
  );

  await enqueueJob(db, {
    teamId,
    kind: "publish",
    payload: { publicationId: pub.id },
    runAfter: opts.at,
    dedupKey: `publish:${pub.id}`,
  });
  await setVariantStatus(db, teamId, variantId, "scheduled");
  return pub;
}

/**
 * Run a scheduled publication. Re-verifies the fail-closed door at fire time (tier/status/governance
 * + live dry-run), then — in dry-run — records success without calling any provider, or live resolves
 * the Typefully credentials (or an injected provider in tests) and publishes. A door refusal cancels
 * the publication (terminal). A transient provider/DB error marks it failed and rethrows so the M0
 * runner retries with backoff.
 */
export async function runPublication(
  db: DbClient,
  teamId: string,
  publicationId: string,
  opts: { provider?: SocialPublishingProvider } = {}
): Promise<void> {
  const pub = await getPublication(db, teamId, publicationId);
  if (!pub) throw new Error(`runPublication: publication ${publicationId} not found for team`);
  if (pub.status === "published" || pub.status === "cancelled") return; // terminal — idempotent

  const variant = await getVariant(db, teamId, pub.variant_id);
  if (!variant) throw new Error(`runPublication: variant ${pub.variant_id} not found`);

  // ── Idempotent re-entry (audit #2): a PRIOR attempt already got an external id from the provider
  // (persisted below, before we mark 'published') but then crashed/failed mid-finalize. The post is
  // already live — do NOT re-post; just finalize with the id we have. Keyed on `!pub.dry_run` (our
  // own column), NOT the id string: a live row's id is always non-empty (a no-id provider response
  // still persists a sentinel below), and a dry-run row only ever gets an id atomically WITH
  // `status='published'` (caught by the terminal check), so it never reaches here mid-flight. ──
  if (pub.external_id && !pub.dry_run) {
    await finalizePublished(db, teamId, publicationId, variant);
    return;
  }

  // ── Fail-closed door: re-verify tier + status + governance at FIRE time (audit #1/#3/#6). A
  // refusal is a policy stop — cancel (terminal), do NOT throw (a throw would requeue and retry).
  // Rewind the variant to `rejected` (needs a fresh, gate-passing regenerate before it can re-enter
  // the publish path) so it isn't stranded mid-lifecycle with no exit. ──
  const refusal = await publishRefusalReason(db, teamId, variant, { requirePublishable: true });
  if (refusal) {
    await abortPublication(db, teamId, pub, variant, `refused: ${refusal}`, "rejected");
    return;
  }

  // Re-read the LIVE dry-run setting, not just the snapshot (audit #6). A publication SCHEDULED live
  // but now dry-run-ON is the operator hitting the brakes: HOLD it (cancel + rewind to `approved` so
  // it can be re-scheduled once the brake is released) — never record a fake dry-run "success". An
  // INTENDED dry-run (pub.dry_run) still records a dry-run publication; that's the point of dry-run.
  const liveDryRun = await getPublishDryRun(db, teamId);
  if (!pub.dry_run && liveDryRun) {
    await abortPublication(db, teamId, pub, variant, "refused: dry-run re-enabled after scheduling — post held", "approved");
    return;
  }
  const dryRun = pub.dry_run;

  await setPublicationState(db, teamId, publicationId, { status: "publishing" });
  await setVariantStatus(db, teamId, pub.variant_id, "publishing");

  // Hoisted so the catch can persist an id the provider already returned (defense-in-depth, audit #2).
  let externalId = "dry-run";
  let url: string | null = null;
  try {
    if (!dryRun) {
      let provider = opts.provider;
      let socialSetId = "";
      if (!provider) {
        const creds = await getTypefullyCredentials(db, teamId);
        if (!creds) throw new PublishError("Typefully is not connected — add a key in Admin → Social");
        if (!creds.socialSetId) throw new PublishError("no Typefully social set configured");
        provider = typefullyProvider(creds.key);
        socialSetId = creds.socialSetId;
      }
      const res = await provider.publish({
        text: variant.body,
        platforms: PLATFORMS,
        scheduleAt: pub.scheduled_at,
        socialSetId,
        idempotencyKey: `publish:${pub.id}`,
      });
      // A no-id / non-JSON 2xx (the adapter's verify-at-build case) MUST still arm the re-entry guard,
      // else a crash-window retry re-posts. Persist a non-empty sentinel keyed to this publication.
      externalId = res.externalId || `accepted:${pub.id}`;
      url = res.url;
      // Persist the external id FIRST, in its own write (audit #2). If we crash before marking
      // 'published', the re-entry guard above sees this id next attempt and finalizes WITHOUT
      // re-posting — no duplicate live post.
      await setPublicationState(db, teamId, publicationId, { external_id: externalId, external_url: url });
    }

    await setPublicationState(db, teamId, publicationId, {
      status: "published",
      external_id: externalId,
      external_url: url,
      published_at: new Date().toISOString(),
      last_error: null,
    });
    await setVariantStatus(db, teamId, pub.variant_id, "published");
    // Schedule a delayed analytics collection (M6) — best-effort, never fails the publish.
    await scheduleAnalyticsCollection(db, teamId, publicationId).catch(() => {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // If the provider already accepted (we have an id) but a later write threw, persist that id
    // alongside 'failed' so the retry short-circuits instead of re-posting (audit #2 defense).
    const fields: Parameters<typeof setPublicationState>[3] =
      !dryRun && externalId !== "dry-run"
        ? { status: "failed", external_id: externalId, external_url: url, last_error: msg.slice(0, 2000) }
        : { status: "failed", last_error: msg.slice(0, 2000) };
    await setPublicationState(db, teamId, publicationId, fields).catch(() => {});
    await setVariantStatus(db, teamId, pub.variant_id, "failed").catch(() => {});
    throw new Error(`publish failed: ${msg}`); // rethrow → M0 retries with backoff
  }
}

/**
 * Cancel a scheduled/pending publication (admin action) so it never posts, and return its variant to
 * `approved` so it can be re-scheduled. No-op if the publication already published. (audit #6)
 */
export async function cancelScheduledPublication(
  db: DbClient,
  teamId: string,
  publicationId: string,
  actor: { memberId?: string | null } = {}
): Promise<{ cancelled: boolean }> {
  const pub = await getPublication(db, teamId, publicationId);
  if (!pub) throw new Error(`cancelScheduledPublication: publication ${publicationId} not found for team`);
  const { cancelled } = await cancelPublication(db, teamId, publicationId, actor);
  if (cancelled) {
    const variant = await getVariant(db, teamId, pub.variant_id);
    // Only rewind a variant that's still mid-publish; never disturb one already published elsewhere.
    if (variant && PUBLISHABLE_STATUSES.has(variant.status)) {
      await setVariantStatus(db, teamId, pub.variant_id, "approved");
    }
  }
  return { cancelled };
}

/** The `publish` job handler (M0's first real handler). Registered at module load. */
const publishJobHandler: JobHandler = async (job, db) => {
  const publicationId = String((job.payload as { publicationId?: string }).publicationId ?? "");
  if (!publicationId) throw new Error("publish job missing publicationId");
  await runPublication(db, job.team_id, publicationId, {});
};

registerJobHandler("publish", publishJobHandler);
