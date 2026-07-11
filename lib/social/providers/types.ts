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
}

export interface PublishResult {
  externalId: string;
  url: string | null;
  status: string;
}

export interface SocialPublishingProvider {
  readonly name: string;
  publish(req: PublishRequest): Promise<PublishResult>;
}
