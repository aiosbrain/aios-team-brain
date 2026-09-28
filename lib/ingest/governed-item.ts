import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { GovernedContext } from "@/lib/actions/governed";
import { DomainFailure } from "@/lib/actions/governed/errors";
import { reconcileItemUnit } from "@/lib/projects/context/units";
import { ensureIncludeMembership, noWideningGate } from "@/lib/projects/context/memberships";
import { GOVERNED_ITEM_PREFIX } from "./governed-origin";

type GovernedItemInput =
  | { kind: "decision"; title: string; body: string; entityId: string; identityKey: string }
  | { kind: "note"; title: string; body: string; identityKey: string };

/** Create only, in the caller's fenced transaction. No authority writes or network effects. */
export async function appendGovernedItem(
  ctx: GovernedContext,
  input: GovernedItemInput,
): Promise<{ itemId: string; revision: string }> {
  const destination = await ctx.query<{ id: string; kind: string; slug: string; graph_group_id: string | null; general_ready: boolean }>(
    `select id,kind,slug,graph_group_id,
       exists(select 1 from projects g where g.team_id=$1 and g.kind='system'
         and g.slug='general' and nullif(g.graph_group_id,'') is not null) as general_ready
       from projects where team_id=$1 and id=$2`,
    [ctx.teamId, ctx.projectId],
  );
  const project = destination.rows[0];
  // The projector serves initialized General or initiative partitions. Its legacy
  // unbootstrapped fallback must never widen an explicitly placed governed item.
  if (!project?.graph_group_id || !project.general_ready ||
      !(project.kind === "initiative" || (project.kind === "system" && project.slug === "general")))
    throw new DomainFailure("forbidden", "denied");
  const gate = await noWideningGate(ctx.db, ctx.teamId, ctx.projectId, "team");
  if (!gate.ok) {
    if (gate.refused) throw new DomainFailure("forbidden", "denied");
    throw new Error("governed destination placement unavailable");
  }
  const itemId = randomUUID();
  const revision = randomUUID();
  const entityId = input.kind === "note" ? itemId : input.entityId;
  const path = `${GOVERNED_ITEM_PREFIX}${input.kind}/${itemId}.md`;
  const contentSha = createHash("sha256").update(input.body, "utf8").digest("hex");
  const frontmatter = {
    title: input.title, kind: input.kind, access: "team",
    source: "governed",
  };
  await ctx.query(
    `insert into items(id,team_id,project_id,path,kind,access,frontmatter,body,content_sha256,actor,member_id,member_id_locked,work_at_from_source)
     values($1,$2,$3,$4,$5,'team',$6,$7,$8,$9,$10,true,true)`,
    [itemId, ctx.teamId, ctx.projectId, path, input.kind, JSON.stringify(frontmatter), input.body,
      contentSha, ctx.principal.actor, ctx.memberId],
  );
  await ctx.query(
    "insert into item_versions(item_id,content_sha256,frontmatter,body,member_id) values($1,$2,$3,$4,$5)",
    [itemId, contentSha, JSON.stringify(frontmatter), input.body, ctx.memberId],
  );
  await ctx.query(
    `insert into governed_item_origins(item_id,team_id,member_id,project_id,kind,entity_id,identity_key,revision)
     values($1,$2,$3,$4,$5,$6,$7,$8)`,
    [itemId, ctx.teamId, ctx.memberId, ctx.projectId, input.kind, entityId, input.identityKey, revision],
  );
  const unit = await reconcileItemUnit(ctx.db, ctx.teamId, itemId, ctx.query);
  if (!unit.ok || !unit.unitId) throw new Error("governed context creation unavailable");
  const placed = await ensureIncludeMembership(ctx.db, ctx.teamId, {
    projectId: ctx.projectId, contextUnitId: unit.unitId, method: "explicit_ref", decidedBy: ctx.memberId,
  });
  if (!placed.ok) {
    if (placed.refused) throw new DomainFailure("forbidden", "denied");
    throw new Error("governed context placement unavailable");
  }
  return { itemId, revision };
}
