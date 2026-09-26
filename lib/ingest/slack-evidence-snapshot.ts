import "server-only";

import { withTransaction } from "@/lib/db/pg/tx";
import type { SqlExecutor } from "@/lib/db/types";
import {
  readSlackCreditInputSnapshotInSession,
  type SlackCreditInputSnapshot,
} from "./slack-credit-input-snapshot";
import { validateSlackItemCreditRequest } from "./slack-item-credit-ledger-read";
import {
  readVisibleSlackMessagesInSession,
  validateSlackMessageReadWindow,
  type VisibleSlackMessage,
} from "./slack-message-read";

export interface SlackEvidenceSnapshot extends SlackCreditInputSnapshot {
  /** Eligible, nondeleted messages in the inclusive UTC window for the requested item IDs. */
  messages: VisibleSlackMessage[];
}

export interface SlackEvidenceSnapshotRequest {
  teamId: string;
  /** IDs already authorized by the current item-visibility oracle. */
  itemIds: readonly string[] | ReadonlySet<string>;
  since: Date;
  asOf: Date;
}

export type SlackEvidencePagePart =
  | "creditMessages" | "identities" | "members" | "creditInputs" | "visibleMessages";

export interface SlackEvidenceSnapshotOptions {
  creditPageSize?: number;
  messagePageSize?: number;
  /** Test seam only. creditInputs/0 runs after all credit inputs and before visible messages. */
  afterPage?: (part: SlackEvidencePagePart, pageNumber: number, query: SqlExecutor) => Promise<void>;
}

/** Inputs here have been validated and captured by the transaction owner. */
export interface SlackEvidenceSessionRequest {
  teamId: string;
  itemIds: readonly string[];
  since: Date;
  asOf: Date;
  creditPageSize: number;
  messagePageSize: number;
}

/** Read all evidence through the caller's read-only repeatable-read executor. */
export async function readSlackEvidenceSnapshotInSession(
  query: SqlExecutor,
  input: SlackEvidenceSessionRequest,
  afterPage?: SlackEvidenceSnapshotOptions["afterPage"]
): Promise<SlackEvidenceSnapshot> {
  const { teamId, itemIds, since, asOf, creditPageSize, messagePageSize } = input;
  const credit = await readSlackCreditInputSnapshotInSession(
    query, teamId, itemIds, creditPageSize,
    (part, page, sql) => afterPage?.(
      part === "messages" ? "creditMessages" : part, page, sql
    ) ?? Promise.resolve()
  );
  await afterPage?.("creditInputs", 0, query);
  const messages = await readVisibleSlackMessagesInSession(query, {
    teamId, itemIds, since, asOf,
  }, messagePageSize, (page, sql) => afterPage?.("visibleMessages", page, sql) ?? Promise.resolve());
  return { ...credit, messages };
}

/**
 * Inactive evidence read. The caller must authorize the supplied IDs before the read, then
 * reauthorize visibility and revalidate generations before publication. No access or credit
 * decision is made here. Any failed page rejects the entire snapshot.
 */
export async function readSlackEvidenceSnapshot(
  input: SlackEvidenceSnapshotRequest,
  options: SlackEvidenceSnapshotOptions = {}
): Promise<SlackEvidenceSnapshot> {
  // Validate all caller-controlled bounds before acquiring the single transaction.
  const { requested, pageSize: creditPageSize } = validateSlackItemCreditRequest(
    input.teamId, input.itemIds, options.creditPageSize
  );
  const teamId = input.teamId;
  const messagePageSize = validateSlackMessageReadWindow(
    teamId, input.since, input.asOf, options.messagePageSize
  );
  // Date is mutable: capture the validated instants once for every message page.
  const since = new Date(input.since.getTime());
  const asOf = new Date(input.asOf.getTime());

  return withTransaction(async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const query: SqlExecutor = async <T>(sql: string, params: unknown[] = []) => {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    };
    return readSlackEvidenceSnapshotInSession(query, {
      teamId, itemIds: requested, since, asOf, creditPageSize, messagePageSize,
    }, options.afterPage);
  });
}
