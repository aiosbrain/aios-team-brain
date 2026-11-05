import "server-only";

import { lockedRevocationEpoch, revocationEpoch } from "@/lib/access/authorization-epoch";
import { withTransaction } from "@/lib/db/pg/pool";
import type { DbClient } from "@/lib/db/types";

/**
 * AIO-1167 R95 — a DIRECT content read (`GET /api/v1/items`, `GET /api/v1/items/<id>`) bound to ONE
 * revocation epoch, so a principal whose scope is revoked mid-request is never served the content its
 * old scope authorized.
 *
 * One attempt is: capture the team's revocation epoch FIRST, then resolve the principal's scope (member
 * oracle or agent effective set), its visible item ids or by-id admission, and read the rows. Content is
 * published only through the short locked check below — the epoch share-locked in its own transaction
 * (the `withOutputPublication` pattern) and compared with the captured one:
 *   · unchanged → the response is linearized BEFORE any revocation: a revocation that tries to advance
 *     the epoch now waits for this check, and every later read sees it;
 *   · changed → a revocation committed after the scope was read: the candidate is discarded and the
 *     WHOLE attempt runs again (scope, ids, admission, rows, cursor), at most `DIRECT_READ_ATTEMPTS`
 *     times, then the read fails closed as `DirectReadUnavailableError` (a retryable 503).
 * The lock is taken after every read of the attempt and nothing is written under it, so no writer's
 * lock order is inverted. An outcome that carries nothing the scope protects (an empty page, an absent
 * or invisible id, a read error) is returned as is: serving it after a revocation discloses nothing.
 * An unreadable or unlockable epoch fails closed.
 */
export const DIRECT_READ_ATTEMPTS = 2;

export class DirectReadUnavailableError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "DirectReadUnavailableError";
  }
}

/** What one attempt produced: authorized `content` (published only through the barrier), or a `final`
 *  answer that carries nothing the principal's scope protects. */
export type DirectReadOutcome<T> = { kind: "content"; value: T } | { kind: "final"; value: T };

export const directReadContent = <T>(value: T): DirectReadOutcome<T> => ({ kind: "content", value });
export const directReadFinal = <T>(value: T): DirectReadOutcome<T> => ({ kind: "final", value });

/** Pure unit DbClient fakes predate the epoch table; the real-Postgres tier exercises this barrier
 *  (the same convention as `revocationEpoch` / `withLockedAuthorizationEpoch`). */
const unitFakeMode = () => process.env.NODE_ENV === "test" && !process.env.DATABASE_URL;

async function capturedEpoch(db: DbClient, teamId: string): Promise<number> {
  let epoch: number;
  try {
    epoch = await revocationEpoch(db, teamId);
  } catch {
    throw new DirectReadUnavailableError("authorization epoch is unreadable");
  }
  if (!Number.isSafeInteger(epoch) && !unitFakeMode()) {
    throw new DirectReadUnavailableError("authorization epoch is unreadable");
  }
  return epoch;
}

/** The short locked check: true only while the epoch still equals the one the attempt was read under. */
async function publicationCurrent(teamId: string, expected: number): Promise<boolean> {
  if (unitFakeMode()) return true;
  try {
    return await withTransaction(async () => (await lockedRevocationEpoch(teamId)) === expected);
  } catch {
    throw new DirectReadUnavailableError("authorization epoch could not be locked for publication");
  }
}

export async function withEpochBoundDirectRead<T>(
  db: DbClient,
  teamId: string,
  attempt: () => Promise<DirectReadOutcome<T>>,
): Promise<T> {
  for (let number = 0; number < DIRECT_READ_ATTEMPTS; number += 1) {
    const epoch = await capturedEpoch(db, teamId);
    const outcome = await attempt();
    if (outcome.kind === "final") return outcome.value;
    if (await publicationCurrent(teamId, epoch)) return outcome.value;
  }
  throw new DirectReadUnavailableError("authorization changed repeatedly during the read");
}
