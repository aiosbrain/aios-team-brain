import "server-only";
import type { DbClient } from "@/lib/db/types";
import { enqueueJob, registerJobHandler, type JobHandler } from "@/lib/jobs";
import { getTypefullyCredentials } from "@/lib/integrations/typefully";
import { getVariant, setVariantStatus } from "./store";
import { getPublishDryRun } from "./settings";
import { createPublication, getPublication, setPublicationState, type PublicationRow } from "./publications";
import { scheduleAnalyticsCollection } from "./collect-analytics";
import { typefullyProvider } from "./providers/typefully";
import type { SocialPublishingProvider } from "./providers/types";

/**
 * Publishing (Social Brain M5). An APPROVED variant is scheduled: a publication row is created and
 * a `publish` job is enqueued on the durable M0 runner (`run_after` = the scheduled time). The job
 * handler runs the provider call and advances the publication + variant. NEVER auto-publishes —
 * scheduling is always an explicit admin action; even `fully_autonomous` still requires the click
 * for V1. Dry-run (the default, `social_settings.publish_dry_run`) records a publication without
 * calling any provider, so the whole path is exercisable with nothing going live.
 */

// V1 targets X + LinkedIn (matches the variant set the planner produces).
const PLATFORMS = ["x", "linkedin"];

export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
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
 * Run a scheduled publication. In dry-run, records success without calling any provider. Live,
 * resolves the Typefully credentials (or uses an injected provider in tests) and publishes. On
 * failure, marks the publication failed and rethrows so the M0 runner retries.
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

  await setPublicationState(db, teamId, publicationId, { status: "publishing" });
  await setVariantStatus(db, teamId, pub.variant_id, "publishing");

  try {
    let externalId = "dry-run";
    let url: string | null = null;

    if (!pub.dry_run) {
      let provider = opts.provider;
      let socialSetId = "";
      if (!provider) {
        const creds = await getTypefullyCredentials(db, teamId);
        if (!creds) throw new PublishError("Typefully is not connected — add a key in Admin → Social");
        if (!creds.socialSetId) throw new PublishError("no Typefully social set configured");
        provider = typefullyProvider(creds.key);
        socialSetId = creds.socialSetId;
      }
      const res = await provider.publish({ text: variant.body, platforms: PLATFORMS, scheduleAt: pub.scheduled_at, socialSetId });
      externalId = res.externalId;
      url = res.url;
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
    await setPublicationState(db, teamId, publicationId, { status: "failed", last_error: msg.slice(0, 2000) });
    await setVariantStatus(db, teamId, pub.variant_id, "failed");
    throw new Error(`publish failed: ${msg}`); // rethrow → M0 retries with backoff
  }
}

/** The `publish` job handler (M0's first real handler). Registered at module load. */
const publishJobHandler: JobHandler = async (job, db) => {
  const publicationId = String((job.payload as { publicationId?: string }).publicationId ?? "");
  if (!publicationId) throw new Error("publish job missing publicationId");
  await runPublication(db, job.team_id, publicationId, {});
};

registerJobHandler("publish", publishJobHandler);
