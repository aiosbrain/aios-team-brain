import "server-only";
import type { GovernedConsumer } from "../index";
import { operationKey } from "../contract";
import { DomainFailure } from "../errors";
import { appendGovernedItem } from "@/lib/ingest/governed-item";

/** The service owns validation, live authorization, execution claims and audit. */
export const noteConsumer: GovernedConsumer = {
  type: "note.append",
  async execute(ctx, request) {
    if (request.type !== "note.append") throw new DomainFailure("execution_failed");
    const { itemId, revision } = await appendGovernedItem(ctx, {
      kind: "note",
      title: request.params.title,
      body: request.params.body,
      identityKey: operationKey(request, ctx.memberId, ctx.teamId, ctx.projectId),
    });
    return {
      entity: { kind: "note", id: itemId, revision },
      sync: { state: "not_applicable", providers: [] },
    };
  },
};
