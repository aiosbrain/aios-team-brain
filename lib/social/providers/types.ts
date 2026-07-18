/**
 * Provider-neutral social publishing interface (Social Brain M5). AIOS owns this capability;
 * providers (Typefully first) are adapters behind it (mirrors the pm-sync adapter seam). Kept
 * minimal for V1 — a single `publish` that creates/schedules a post; capability discovery,
 * analytics, and engagement are later additions.
 */

export interface PublishRequest {
  text: string;
  /** Target platforms, e.g. ['x', 'linkedin']. */
  platforms: string[];
  /** ISO time to schedule for; null/undefined = publish/queue now. */
  scheduleAt?: string | null;
  /** Provider-specific destination (e.g. the Typefully social-set id). */
  socialSetId: string;
  /**
   * Stable per-publication idempotency token (audit #2). A provider that honors it dedupes a retried
   * POST server-side, so a crash after the provider accepted but before we persisted its id can't
   * create a SECOND live post. Sent as an `Idempotency-Key` header where supported; best-effort.
   */
  idempotencyKey?: string;
}

export interface PublishResult {
  externalId: string;
  url: string | null;
  status: string;
}

/** Normalized engagement metrics across providers (nullable — not every provider reports each). */
export interface NormalizedMetrics {
  impressions?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  clicks?: number | null;
  /** The provider's raw payload, for debugging + fields we don't normalize yet. */
  raw?: Record<string, unknown>;
}

export interface AnalyticsRequest {
  /** The provider post/draft id from the publish result. */
  externalId: string;
  socialSetId: string;
}

export interface SocialPublishingProvider {
  readonly name: string;
  publish(req: PublishRequest): Promise<PublishResult>;
  /** Optional — providers that expose analytics implement this (Typefully: X-only). */
  getAnalytics?(req: AnalyticsRequest): Promise<NormalizedMetrics | null>;
}
