"use server";

import { revalidatePath } from "next/cache";
import { serverClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth/session";
import {
  createConnection,
  updateConnection,
  deleteConnection,
} from "@/lib/connections";

/** Verify the caller is an active admin of the team; returns ids or null. */
async function requireAdmin(teamSlug: string) {
  const supabase = await serverClient();
  const user = await getSessionUser();
  if (!user) return null;
  const { data: team } = await supabase.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;
  const { data: me } = await supabase
    .from("members")
    .select("id, role")
    .eq("team_id", team.id)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (me?.role !== "admin") return null;
  return { teamId: team.id, myMemberId: me.id };
}

/** Split a comma/newline-separated list into trimmed non-empty tokens. */
function toList(raw: string): string[] {
  return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

export async function addConnection(
  teamSlug: string,
  form: { source: string; name: string; channels: string; secret: string }
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const name = form.name.trim();
  if (!name) return { ok: false, error: "name is required" };
  const config: Record<string, unknown> = {};
  const channels = toList(form.channels);
  if (channels.length) config.channel_ids = channels;
  try {
    // Service-role client: writes the encrypted secret column (revoked from clients in
    // supabase mode; no RLS in postgres mode). lib/connections encrypts before insert.
    await createConnection(adminClient(), {
      teamId: ctx.teamId,
      source: form.source,
      name,
      config,
      secret: form.secret || null,
      createdBy: ctx.myMemberId,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not save connection" };
  }
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}

export async function setConnectionEnabled(
  teamSlug: string,
  id: string,
  enabled: boolean
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await updateConnection(adminClient(), { teamId: ctx.teamId, id, enabled });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not update" };
  }
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}

export async function rotateConnectionSecret(
  teamSlug: string,
  id: string,
  secret: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  if (!secret) return { ok: false, error: "secret is required" };
  try {
    await updateConnection(adminClient(), { teamId: ctx.teamId, id, secret });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not rotate" };
  }
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}

export async function removeConnection(
  teamSlug: string,
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await deleteConnection(adminClient(), ctx.teamId, id);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not delete" };
  }
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}
