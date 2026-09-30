import "server-only";

import { withTransaction } from "@/lib/db/pg/tx";
import type { SqlExecutor } from "@/lib/db/types";
import {
  readSlackEvidenceSnapshotInSession,
  type SlackEvidenceSnapshot,
  type SlackEvidenceSnapshotOptions,
} from "./slack-evidence-snapshot";
import { SLACK_CREDIT_READ_PAGE_SIZE } from "./slack-item-credit-ledger-read";
import { validateSlackMessageReadWindow } from "./slack-message-read";
import {
  readSlackSourcePageInSession,
  validateSlackSourcePageRequest,
  type SlackSourcePage,
  type SlackSourcePageRequest,
} from "./slack-source-page-read";

export interface SlackSourceEvidencePage extends SlackSourcePage {
  /** Evidence for exactly itemIds, captured with discovery in one database snapshot. */
  evidence: SlackEvidenceSnapshot;
}

export interface SlackSourceEvidencePageOptions extends SlackEvidenceSnapshotOptions {
  /** Test seam after discovery and before any evidence read, on the same transaction. */
  afterDiscovery?: (query: SqlExecutor) => Promise<void>;
}

/**
 * Inactive page reader. The caller supplies the complete currently authorized visible-item set.
 * It must recheck access and generations before using or publishing a page and bind a future
 * continuation to the relevant generations. A failure rejects the whole page.
 */
export async function readSlackSourceEvidencePage(
  input: SlackSourcePageRequest,
  options: SlackSourceEvidencePageOptions = {}
): Promise<SlackSourceEvidencePage> {
  // All caller-owned mutable data is validated and copied before the first await. The discovered
  // page is at most 512 IDs, so the existing credit reader's requested-ID bound is satisfied.
  const source = validateSlackSourcePageRequest(input);
  const creditPageSize = options.creditPageSize === undefined
    ? SLACK_CREDIT_READ_PAGE_SIZE : options.creditPageSize;
  if (!Number.isSafeInteger(creditPageSize) || creditPageSize < 1 ||
      creditPageSize > SLACK_CREDIT_READ_PAGE_SIZE) {
    throw new RangeError("slack source evidence page: invalid credit page size");
  }
  const messagePageSize = validateSlackMessageReadWindow(
    source.teamId, source.since, source.asOf, options.messagePageSize
  );

  return withTransaction(async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const query: SqlExecutor = async <T>(sql: string, params: unknown[] = []) => {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    };
    const page = await readSlackSourcePageInSession(query, source);
    await options.afterDiscovery?.(query);
    const evidence = await readSlackEvidenceSnapshotInSession(query, {
      teamId: source.teamId,
      itemIds: page.itemIds,
      since: source.since,
      asOf: source.asOf,
      creditPageSize,
      messagePageSize,
    }, options.afterPage);
    return { ...page, evidence };
  });
}
