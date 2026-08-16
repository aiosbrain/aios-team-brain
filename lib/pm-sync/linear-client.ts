import "server-only";

import { PmSyncError } from "@/lib/pm-sync/provider";

/**
 * Low-level Linear GraphQL client shared by the OUTBOUND pm-sync projection
 * (`lib/pm-sync/linear.ts`) and the INBOUND ingestion source
 * (`lib/ingest/sources/linear.ts`). Connection-only: POST + auth + error mapping.
 */

export type LinearGraphqlResponse<T> = { data?: T; errors?: { message: string }[] };

/**
 * Does this document ask Linear to CHANGE something?
 *
 * GraphQL's default operation type is `query`, so an anonymous `{ … }` document cannot mutate; only an
 * explicit `mutation` operation can. The check therefore keys on the one token that decides it, after
 * comments are stripped so a `# mutation` in prose is not an accusation.
 */
const MUTATION_DOC = /(^|\})\s*mutation\b/;
const stripGraphqlComments = (doc: string): string => doc.replace(/#[^\n]*/g, "");
export const isMutationDocument = (doc: string): boolean => MUTATION_DOC.test(stripGraphqlComments(doc));

/**
 * Module-private, and that is the whole design. `linearMutation` raises it for exactly one call; nothing
 * outside this file can set it, so there is no way to send a mutation through the raw transport.
 */
let insideVerifiedMutation = false;

/**
 * THE RAW TRANSPORT — reads only. Connection, auth, error mapping.
 *
 * ⚠️ A `mutation` document sent through here is REFUSED AT RUNTIME (PMSUCCESS-1). Route every write
 * through `linearMutation`, which checks that Linear actually did the thing.
 *
 * WHY A RUNTIME TERM AND NOT A LINT. Two static designs were specced and both were broken in review
 * before any code existed:
 *
 *   • scanning `lib/pm-sync/*.ts` for mutation documents — defeated by a hoisted const passed as a
 *     variable (the shape `lib/provisioning/linear.ts` already used), by string concatenation, by moving
 *     the document to another file, and by any call site outside the glob;
 *   • an import allowlist on this function, modelled on `test/guards/llm-single-caller.test.ts` — which
 *     skips allowlisted files WHOLESALE. `lib/pm-sync/linear.ts` must be allowlisted for its read-only
 *     queries, and it is also the file holding every projection mutation, so a new mutation added there
 *     introduces no new import and reddens nothing.
 *
 * This check sees the post-concatenation string actually being sent, so const-hoisting, concatenation,
 * re-export, namespace import, `await import()` and `require` all fail at once — none of them can change
 * what the document says. The import allowlist survives as a SECOND layer with a different property
 * (who may reach the transport at all); neither is allowed to stand in for the other.
 */
export async function linearGraphql<T>(
  fetchImpl: typeof fetch,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  if (!insideVerifiedMutation && isMutationDocument(query)) {
    throw new PmSyncError(
      "Linear mutation sent through the raw transport — use linearMutation, which verifies the provider accepted the write (PMSUCCESS-1)"
    );
  }
  const res = await fetchImpl("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json().catch(() => null)) as LinearGraphqlResponse<T> | null;
  if (!res.ok || json?.errors?.length || !json?.data) {
    const message = json?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new PmSyncError(`Linear GraphQL failed: ${message}`);
  }
  return json.data;
}

/**
 * What a caller must name so the answer can be checked rather than assumed.
 *
 * `success` is checked for EVERY caller with no opt-out — that is the defect this exists for. The entity
 * is a second net, and omitting it costs you a written reason rather than a silent default: the type
 * forces `entityless` to carry prose, so "I did not check" can never be the thing you get by forgetting.
 * A guard test additionally requires every `lib/pm-sync` call site to name an entity, so the relaxation
 * cannot spread into the projection path it was built for.
 */
export type LinearMutationExpect =
  | {
      /** The payload key inside `data`, e.g. `issueCreate`. */
      readonly payload: string;
      /** The entity key inside the payload, e.g. `issue`. */
      readonly entity: string;
    }
  | {
      readonly payload: string;
      /** Why this payload has no entity worth checking. Required prose — see `linearMutation`. */
      readonly entityless: string;
    };

/**
 * A Linear mutation, verified against what Linear says it did — the single writer for "did the write
 * happen" (PMSUCCESS-1).
 *
 * Linear's mutations return their own `success: Boolean!` INSIDE `data`, so a well-formed 200 carrying
 * `{ success: false, issue: null }` passes every check `linearGraphql` makes. Five of six call sites
 * requested that field and none read it, so `aios push` could print `N synced · 0 errors` having changed
 * nothing — and worse, a refused UPDATE latched the row as skipped forever, while a refused STATUS write
 * was reverted in the brain on the next inbound pass.
 *
 * `success` is REQUIRED, with no opt-out. A draft of this carried a `successNotReturned` escape hatch;
 * every one of the six sites requests the field, so nothing needed it — and an unused escape hatch is a
 * hole waiting for someone to reach for it to make a test green.
 */
export async function linearMutation<T>(
  fetchImpl: typeof fetch,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  expect: LinearMutationExpect
): Promise<T> {
  if (!isMutationDocument(query)) {
    throw new PmSyncError(`linearMutation called with a non-mutation document (${expect.payload})`);
  }
  insideVerifiedMutation = true;
  let data: Record<string, unknown>;
  try {
    data = await linearGraphql<Record<string, unknown>>(fetchImpl, apiKey, query, variables);
  } finally {
    // `finally`, not after the await: a throw from the transport must not leave the flag raised for
    // whatever this process does next.
    insideVerifiedMutation = false;
  }

  const payload = data?.[expect.payload] as Record<string, unknown> | null | undefined;
  if (payload === null || payload === undefined) {
    throw new PmSyncError(`Linear ${expect.payload} returned no payload — the write was not confirmed`);
  }
  if (payload.success !== true) {
    throw new PmSyncError(
      `Linear ${expect.payload} reported success=${JSON.stringify(payload.success)} — the write did not happen`
    );
  }
  if ("entityless" in expect) return data as T; // `success` was still required above
  const entity = payload[expect.entity] as { id?: unknown } | null | undefined;
  if (entity === null || entity === undefined) {
    throw new PmSyncError(`Linear ${expect.payload} returned success with no ${expect.entity}`);
  }
  if (typeof entity.id !== "string" || entity.id === "") {
    // The id is what every caller uses downstream; without it a "success" is unusable, and an
    // `undefined` id is what poisoned the caches and wrote a NULL provider_resource_id.
    throw new PmSyncError(`Linear ${expect.payload} returned a ${expect.entity} with no id`);
  }
  return data as T;
}

// ── Idempotency footer marker (shared by outbound projection + inbound import dedupe) ──
// Brain-projected Linear issues carry this footer in their description. The importer uses it to
// recognize round-trippers (issues the brain itself created) and skip re-importing them.
export const EXT_RE = /aios-ext:\s*([A-Za-z0-9._-]+)\s*[·•]\s*source:\s*([A-Za-z0-9._-]+)/;

export const extMarker = (rowKey: string, source: string) => `aios-ext: ${rowKey} · source: ${source}`;

/** The brain row_key carried by a projected issue's footer, or null if not brain-originated. */
export function parseExt(description: string | null | undefined): string | null {
  const m = String(description ?? "").match(EXT_RE);
  return m ? m[1] : null;
}

export function withFooter(body: string, rowKey: string, source: string): string {
  const text = (body ?? "").trim();
  return `${text}\n\n${extMarker(rowKey, source)}`;
}

export function stripFooter(description: string | null | undefined): string {
  return String(description ?? "").replace(EXT_RE, "").trim();
}
