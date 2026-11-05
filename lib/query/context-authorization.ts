import "server-only";

import { revocationEpoch } from "@/lib/access/authorization-epoch";
import type { DbClient } from "@/lib/db/types";

/**
 * AIO-1167 R66 — the revocation epoch a query context was CAPTURED under, carried with it to every
 * dispatch of its text.
 *
 * Retrieval authorizes items, structured rows and graph facts against the reader's claims at read
 * time. A Drive claim retirement committed after that (another connection may still hold the
 * document, so it is not physically gone) must stop the captured text from reaching a model, the
 * client, citations or stored answers. The durable team epoch is the existing revocation counter
 * (`team_authorization_epochs`, advanced by every revocation publication); this module never writes
 * it and holds no lock — it only reads it twice: once BEFORE the reads it certifies, and again
 * immediately before each dispatch.
 *
 * Trust: an instance is created only by `capture` (the constructor is private), so a hand-built
 * `{ teamId, epoch }` literal — or text stamped with an epoch read after the fact — is not one, and
 * `requireContextAuthorization` rejects it as inconsistent.
 */
export class ContextAuthorization {
  private constructor(
    readonly teamId: string,
    readonly epoch: number,
    private readonly db: DbClient,
  ) {
    Object.freeze(this);
  }

  /** Read the team's current revocation epoch. Call BEFORE the first read the context will carry. */
  static async capture(db: DbClient, teamId: string): Promise<ContextAuthorization> {
    return new ContextAuthorization(teamId, await readEpoch(db, teamId), db);
  }

  /** Throws `QueryContextAuthorizationChangedError` unless the epoch is unchanged and readable now. */
  async assertCurrent(): Promise<void> {
    const current = await readEpoch(this.db, this.teamId);
    if (current !== this.epoch) throw new QueryContextAuthorizationChangedError("changed");
  }

  /** Whether a read certified under `epoch` belongs to this capture (graph facts, R66). */
  certifies(epoch: number | null | undefined): boolean {
    return epoch === this.epoch;
  }
}

async function readEpoch(db: DbClient, teamId: string): Promise<number> {
  try {
    return await revocationEpoch(db, teamId);
  } catch {
    throw new QueryContextAuthorizationChangedError("unreadable");
  }
}

/**
 * The captured context's authorization changed, could not be read, or was never established by
 * `capture`. Sanitized: the message names no item, source or epoch. Retryable for the CLIENT (ask
 * again: a fresh retrieval re-authorizes), but deliberately NOT a transient answer-stream error — it
 * has no status and no transport wording, so the stream retry owner never re-dispatches it.
 */
export class QueryContextAuthorizationChangedError extends Error {
  readonly retryable = true;
  constructor(readonly reason: "changed" | "unreadable" | "inconsistent") {
    super("query context authorization changed before the answer could be produced");
    this.name = "QueryContextAuthorizationChangedError";
  }
}

/** The sanitized, retryable message a client sees for this refusal (one text, owned by stream-retry). */
export { CONTEXT_AUTHORIZATION_CLIENT_MESSAGE } from "./stream-retry";

/** The context's own authorization — or a fail-closed refusal when it was not established by `capture`. */
export function requireContextAuthorization(
  ctx: { authorization?: unknown },
  teamId?: string,
): ContextAuthorization {
  const authorization = ctx.authorization;
  if (!(authorization instanceof ContextAuthorization)) {
    throw new QueryContextAuthorizationChangedError("inconsistent");
  }
  if (teamId !== undefined && authorization.teamId !== teamId) {
    throw new QueryContextAuthorizationChangedError("inconsistent");
  }
  return authorization;
}
