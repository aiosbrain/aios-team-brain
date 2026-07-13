import "server-only";
import type { AnalyticsRequest, NormalizedMetrics, PublishRequest, PublishResult, SocialPublishingProvider } from "./types";

/**
 * Typefully v2 publishing adapter. Base `https://api.typefully.com/v2`, Bearer key (per the
 * provider spike). Creates a draft in the team's social set with `publish_at` = the scheduled time
 * (or "now"). `fetchImpl` is injectable for tests.
 *
 * ⚠ The exact v2 draft request/response shape is only partially documented (spike flagged it as
 * verify-at-build). This is the best-effort shaping; confirm against a live account before enabling
 * live publishing. Until then dry-run mode (the default) never calls this.
 */

const BASE_URL = "https://api.typefully.com/v2";
type Fetch = typeof fetch;

export function typefullyProvider(apiKey: string, fetchImpl: Fetch = fetch): SocialPublishingProvider {
  return {
    name: "typefully",
    async publish(req: PublishRequest): Promise<PublishResult> {
      if (!req.socialSetId) throw new Error("typefully: no social-set id configured");
      const platforms: Record<string, unknown> = {};
      for (const p of req.platforms) platforms[p] = {};

      const res = await fetchImpl(`${BASE_URL}/social-sets/${req.socialSetId}/drafts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          scratchpad_text: req.text,
          platforms,
          publish_at: req.scheduleAt ?? "now",
          share: false,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        throw new Error(`typefully draft ${res.status}: ${await res.text().catch(() => "")}`);
      }
      const j = (await res.json().catch(() => ({}))) as {
        id?: string | number;
        status?: string;
        preview?: string;
      };
      return {
        externalId: j.id != null ? String(j.id) : "",
        url: j.preview ?? null,
        status: j.status ?? "scheduled",
      };
    },

    // X-only analytics (Typefully exposes engagement for X posts). Best-effort + verify-at-build:
    // the exact response shape and how a draft id maps to its published X post are only partially
    // documented (spike). Returns null when nothing matches, so a collect run just records no data.
    async getAnalytics(req: AnalyticsRequest): Promise<NormalizedMetrics | null> {
      const res = await fetchImpl(`${BASE_URL}/analytics/x/posts?social_set_id=${encodeURIComponent(req.socialSetId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`typefully analytics ${res.status}: ${await res.text().catch(() => "")}`);
      const j = (await res.json().catch(() => ({}))) as { posts?: Record<string, unknown>[] };
      const post = (j.posts ?? []).find((p) => String(p.draft_id ?? p.id ?? "") === req.externalId);
      if (!post) return null;
      const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
      return {
        impressions: num(post.impressions),
        likes: num(post.likes),
        comments: num(post.comments),
        shares: num(post.reposts ?? post.shares),
        saves: num(post.saves ?? post.bookmarks),
        clicks: num(post.link_clicks ?? post.clicks),
        raw: post,
      };
    },
  };
}
