"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/api/audit";
import { currentMember } from "@/lib/auth/guard";
import {
  decideCodebaseFinding,
  findingDecisionSchema,
  type FindingDecision,
} from "@/lib/codebases/finding-ledger";
import { adminClient } from "@/lib/db/admin";
import { serverClient } from "@/lib/db/server";
import { getCodebaseIdentity } from "@/lib/metrics/codebases";

export async function recordFindingDecision(
  teamSlug: string,
  codebaseSlug: string,
  input: FindingDecision,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = findingDecisionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "invalid decision",
    };
  }

  const db = await serverClient();
  const { data: team } = await db
    .from("teams")
    .select("id")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return { ok: false, error: "team not found" };

  const me = await currentMember((team as { id: string }).id);
  if (
    !me ||
    me.tier !== "team" ||
    (me.role !== "admin" && me.role !== "lead")
  ) {
    return { ok: false, error: "team leads or admins only" };
  }

  const codebase = await getCodebaseIdentity(
    db,
    team.id,
    codebaseSlug,
    me.tier,
  );
  if (!codebase) return { ok: false, error: "codebase not found" };

  const writeDb = adminClient();
  try {
    const result = await decideCodebaseFinding(writeDb, {
      ...parsed.data,
      teamId: team.id,
      codebaseId: codebase.id,
      actorMemberId: me.id,
    });
    await audit(writeDb, {
      team_id: team.id,
      actor_kind: "member",
      member_id: me.id,
      action: "codebase_finding.decision",
      target_type: "codebase_finding",
      target_id: result.findingId,
      meta: {
        status: result.status,
        owner_member_id: parsed.data.ownerMemberId,
        expires_at: parsed.data.expiresAt,
      },
    });
    revalidatePath(`/t/${teamSlug}/codebases/${codebaseSlug}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "could not record finding decision",
    };
  }
}
