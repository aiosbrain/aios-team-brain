import "server-only";
import type { DbClient } from "@/lib/db/types";
import { enqueueJob, registerJobHandler, type JobHandler } from "@/lib/jobs";
import { getTypefullyCredentials } from "@/lib/integrations/typefully";
import { getPublication } from "./publications";
import { upsertAnalytics } from "./analytics";
import { typefullyProvider } from "./providers/typefully";
import type { SocialPublishingProvider } from "./providers/types";

/**
 * Analytics collection (Social Brain M6). After a publication is published, a delayed
 * `collect_analytics` job (M0 runner) fetches normalized metrics from the provider and upserts one
 * snapshot per publication. Store-and-display only. Dry-run publications record a zeroed snapshot
 * (no real post) so the pipeline is exercisable end-to-end without a live provider. The provider
 * call is injectable so the data-mechanics tier stubs it.
 */

export async function runCollectAnalytics(
  db: DbClient,
  teamId: string,
  publicationId: string,
  opts: { provider?: SocialPublishingProvider } = {}
): Promise<void> {
  const pub = await getPublication(db, teamId, publicationId);
  if (!pub) throw new Error(`runCollectAnalytics: publication ${publicationId} not found for team`);
  if (pub.status !== "published") return; // nothing to collect yet

  // Dry-run posts have no real analytics — record an empty snapshot so the UI shows the row.
  if (pub.dry_run) {
    await upsertAnalytics(db, teamId, { publicationId, access: pub.access, provider: pub.provider, metrics: { raw: { dryRun: true } } });
    return;
  }

  let provider = opts.provider;
  let socialSetId = "";
  if (!provider) {
    const creds = await getTypefullyCredentials(db, teamId);
    if (!creds || !creds.socialSetId) return; // can't collect without creds — leave uncollected
    provider = typefullyProvider(creds.key);
    socialSetId = creds.socialSetId;
  }
  if (!provider.getAnalytics) return; // provider doesn't expose analytics

  const metrics = await provider.getAnalytics({ externalId: pub.external_id ?? "", socialSetId });
  if (!metrics) return; // nothing available yet (post too new / not matched)
  await upsertAnalytics(db, teamId, { publicationId, access: pub.access, provider: pub.provider, metrics });
}

/** Enqueue a delayed analytics collection for a published publication (idempotent by publication). */
export async function scheduleAnalyticsCollection(db: DbClient, teamId: string, publicationId: string): Promise<void> {
  const delayHours = Number(process.env.SOCIAL_ANALYTICS_DELAY_HOURS ?? 6);
  await enqueueJob(db, {
    teamId,
    kind: "collect_analytics",
    payload: { publicationId },
    runAfter: new Date(Date.now() + delayHours * 3_600_000),
    dedupKey: `analytics:${publicationId}`,
  });
}

const collectAnalyticsHandler: JobHandler = async (job, db) => {
  const publicationId = String((job.payload as { publicationId?: string }).publicationId ?? "");
  if (!publicationId) throw new Error("collect_analytics job missing publicationId");
  await runCollectAnalytics(db, job.team_id, publicationId, {});
};

registerJobHandler("collect_analytics", collectAnalyticsHandler);
