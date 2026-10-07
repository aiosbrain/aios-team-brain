/**
 * The payload half of the Admin identity row (`ProviderIdentityLink`), kept pure so it is testable
 * without rendering: what the row sends when the admin saves, and which remap offer still stands.
 *
 * Two identities are in play and they are never mixed. The row DISPLAYS one (its id and that id's
 * mapping revision); the admin REQUESTS one (whatever is typed). The displayed pair travels only as
 * `observed.original`. A revision for the requested id travels only as `observed.remap`, and only
 * when the admin has confirmed an offer the action made for that exact id.
 */

export type IdentityProvider = "slack" | "linear" | "plane" | "gdrive";

/** What the row displays. `externalId` is null for a blank "Link" row, whose revision means nothing. */
export interface DisplayedIdentityRow {
  provider: IdentityProvider;
  externalId: string | null;
  revision: number;
}

/** A remap the action reported and did not make: the requested id, its revision, and its holder. */
export interface IdentityRemapOffer {
  externalId: string;
  revision: number;
  linkedTo: string;
}

export interface IdentityLinkRequest {
  provider: IdentityProvider;
  /** The REQUESTED id. */
  externalId: string;
  observed: {
    /** The DISPLAYED identity at its displayed revision; null when the row displayed none. */
    original: { externalId: string; revision: number } | null;
    /** The requested id's revision as the admin was shown it — present only on a confirmation. */
    remap?: { revision: number };
  };
}

/**
 * An offer stands only for the exact id it named. Applied on every edit of the input, so an offer
 * is discarded the moment a different id is requested and does not come back if the old id is
 * typed again: that id has to be offered afresh, at whatever revision it has by then.
 */
export function standingRemapOffer(offer: IdentityRemapOffer | null, requested: string): IdentityRemapOffer | null {
  return offer && offer.externalId === requested.trim() ? offer : null;
}

/** What one save sends. `confirmRemap` is the explicit "Remap" click, never the ordinary save. */
export function identityLinkRequest(
  row: DisplayedIdentityRow,
  requested: string,
  offer: IdentityRemapOffer | null,
  confirmRemap: boolean,
): IdentityLinkRequest {
  const externalId = requested.trim();
  const standing = confirmRemap ? standingRemapOffer(offer, externalId) : null;
  return {
    provider: row.provider,
    externalId,
    observed: {
      original: row.externalId ? { externalId: row.externalId, revision: row.revision } : null,
      ...(standing ? { remap: { revision: standing.revision } } : {}),
    },
  };
}
