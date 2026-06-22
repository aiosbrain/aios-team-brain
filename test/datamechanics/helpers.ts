import { randomUUID, createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "@/lib/supabase/admin";
import { ingestItem } from "@/lib/ingest";
import type { ItemPayload } from "@/lib/api/schemas";

// In DB_BACKEND=postgres (set by the data-mechanics config) adminClient() is the
// pg adapter over the real test Postgres — so the real app code runs unchanged.
export function db(): SupabaseClient {
  return adminClient();
}

export function sha(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export type Seed = { teamId: string; teamSlug: string; memberId: string };

/** Seed a real team + active member (FK targets the ingest/read paths require). */
export async function seedTeam(): Promise<Seed> {
  const admin = db();
  const slug = `team-${randomUUID().slice(0, 8)}`;
  const { data: team, error: tErr } = await admin
    .from("teams")
    .insert({ slug, name: "Test Team" })
    .select("id")
    .single();
  if (tErr || !team) throw new Error(`seed team failed: ${tErr?.message}`);

  const { data: member, error: mErr } = await admin
    .from("members")
    .insert({
      team_id: team.id,
      email: `${randomUUID()}@test.local`,
      display_name: "Tester",
      actor_handle: `actor-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: "active",
    })
    .select("id")
    .single();
  if (mErr || !member) throw new Error(`seed member failed: ${mErr?.message}`);

  return { teamId: team.id, teamSlug: slug, memberId: member.id };
}

/** Ingest one item through the real lib/ingest path against the real DB. */
export async function ingest(
  seed: Seed,
  over: Partial<ItemPayload> & { body: string; path: string; access: "team" | "external" }
): Promise<{ status: string; id: string; projectId?: string; changedTaskRowKeys?: string[] }> {
  const payload: ItemPayload = {
    project: "acme",
    kind: "deliverable",
    actor: "tester",
    frontmatter: {},
    content_sha256: sha(over.body),
    ...over,
  } as ItemPayload;
  return ingestItem(
    db(),
    { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
    payload,
    over.access
  );
}
