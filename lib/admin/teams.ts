import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/api/audit";
import type { ActorContext } from "./members";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface TeamInput {
  slug: string;
  name: string;
}

/**
 * Create a team — the no-SQL bootstrap primitive for a fresh instance. Pairs with
 * `createMember({ role: "admin" })` to stand up the first team + admin without
 * hand-written SQL (AIOS is self-hosted per organization; this is NOT a public
 * signup path — see CLAUDE.md §5). Idempotent: an existing slug returns that row
 * rather than erroring, so a bootstrap script can be re-run safely.
 */
export async function createTeam(
  admin: SupabaseClient,
  input: TeamInput,
  opts: { actor?: ActorContext } = {}
): Promise<{ id: string; slug: string; name: string }> {
  const slug = input.slug.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw new Error(`invalid slug '${slug}' (need ^[a-z0-9][a-z0-9-]*$)`);
  const name = input.name.trim();
  if (!name) throw new Error("name is required");

  const { data: existing } = await admin
    .from("teams")
    .select("id, slug, name")
    .eq("slug", slug)
    .maybeSingle();
  if (existing) return existing as { id: string; slug: string; name: string };

  const { data, error } = await admin
    .from("teams")
    .insert({ slug, name })
    .select("id, slug, name")
    .single();
  if (error || !data) throw new Error(`create team failed: ${error?.message}`);
  const team = data as { id: string; slug: string; name: string };

  await audit(admin, {
    team_id: team.id,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "team.created",
    target_type: "team",
    target_id: team.id,
    meta: { slug, name },
  });
  return team;
}

/**
 * Rename a team's slug and/or display name. Idempotent (setting the slug/name it
 * already has is a no-op, not an error). The slug must be route-safe and unique.
 * Audited. team_id is stable, so existing data/keys/sessions survive a slug change.
 */
export async function renameTeam(
  admin: SupabaseClient,
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
