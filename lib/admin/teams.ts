import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import type { ActorContext } from "./members";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Rename a team's slug and/or display name. Idempotent (setting the slug/name it
 * already has is a no-op, not an error). The slug must be route-safe and unique.
 * Audited. team_id is stable, so existing data/keys/sessions survive a slug change.
 */
export async function renameTeam(
  admin: DbClient,
  teamId: string,
  fields: { slug?: string; name?: string },
  opts: { actor?: ActorContext } = {}
): Promise<{ slug: string; name: string }> {
  const { data: cur } = await admin
    .from("teams")
    .select("slug, name")
    .eq("id", teamId)
    .maybeSingle();
  if (!cur) throw new Error(`no team ${teamId}`);
  const current = cur as { slug: string; name: string };

  const update: { slug?: string; name?: string } = {};
  if (fields.slug !== undefined && fields.slug !== current.slug) {
    const slug = fields.slug.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) throw new Error(`invalid slug '${slug}' (need ^[a-z0-9][a-z0-9-]*$)`);
    const { data: clash } = await admin
      .from("teams")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (clash && (clash as { id: string }).id !== teamId) throw new Error(`slug '${slug}' already in use`);
    update.slug = slug;
  }
  if (fields.name !== undefined && fields.name !== current.name) update.name = fields.name.trim();

  if (Object.keys(update).length === 0) return current; // idempotent no-op

  const { data, error } = await admin
    .from("teams")
    .update(update)
    .eq("id", teamId)
    .select("slug, name")
    .single();
  if (error || !data) throw new Error(`rename team failed: ${error?.message}`);

  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "team.renamed",
    target_type: "team",
    target_id: teamId,
    meta: { from: current, to: data },
  });
  return data as { slug: string; name: string };
}
