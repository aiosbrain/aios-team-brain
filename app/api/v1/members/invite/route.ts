import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { audit } from "@/lib/api/audit";
import { errorResponse, memberInviteRequestSchema } from "@/lib/api/schemas";
import { createMember, rollbackMemberCreation, MemberExistsError } from "@/lib/admin/members";
import { syncMemberActor } from "@/lib/graph/company-actors";
import { magicLinkAvailable } from "@/lib/auth/mailer";
import { randomPassword } from "@/lib/auth/password";
import { issueMemberInvite } from "@/lib/admin/invite";

export const runtime = "nodejs";

/**
 * POST /api/v1/members/invite — invite a member and provision them into the team's tools (brain-api
 * v1.7). The API counterpart of the admin server-action invite trigger, sharing the same core
 * (`issueMemberInvite`) and primitives (createMember, issueLoginLink, adminSetPassword, provisioning).
 *
 * Auth: a team-tier, admin-role API key (else 403 `forbidden_role`). 10/min per key.
 *
 * Idempotent on (team_id, email): an existing NON-disabled member re-issues sign-in access and
 * re-runs provisioning (`created:false`); a disabled member is rejected 422 (re-enabling is an
 * explicit admin act, not an invite side effect). Provisioning is best-effort and never changes the
 * HTTP status. Magic-link vs manual is decided purely by `magicLinkAvailable()` — there is no
 * admin-choice over the API in v1.7.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  // Inviting a member is an admin, team-tier operation — an external-tier key or a non-admin role
  // gets 403 forbidden_role (never leaks whether the member/email exists).
  if (auth.memberTier !== "team" || auth.memberRole !== "admin") {
    return errorResponse("forbidden_role", "inviting members requires a team-tier admin key", 403);
  }

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:members-invite:post`, 10))) {
    return errorResponse("rate_limited", "10 invites/min per key", 429);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorResponse("invalid_payload", "body must be JSON", 422);
  }

  const parsed = memberInviteRequestSchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse("invalid_payload", parsed.error.issues[0]?.message ?? "invalid", 422);
  }
  const body = parsed.data;
  const email = body.email.trim().toLowerCase();

  const { data: teamRow } = await db
    .from("teams")
    .select("slug, name")
    .eq("id", auth.teamId)
    .maybeSingle();
  const team = teamRow as { slug: string; name: string } | null;
  const teamName = team?.name ?? "your team";
  const teamSlug = team?.slug ?? auth.teamId;

  // Idempotent lookup by (team_id, email). Only create when absent; a disabled member is a hard 422.
  const { data: existingRow } = await db
    .from("members")
    .select("id, status, role, tier, display_name")
    .eq("team_id", auth.teamId)
    .eq("email", email)
    .maybeSingle();
  const existing = existingRow as
    | { id: string; status: string; role: "admin" | "lead" | "member"; tier: "team" | "external"; display_name: string }
    | null;

  if (existing?.status === "disabled") {
    return errorResponse(
      "invalid_payload",
      "this member is disabled; re-enable them explicitly before re-inviting",
      422
    );
  }

  let memberId: string;
  let memberStatus: string;
  let created: boolean;
  let member: {
    id: string;
    email: string;
    displayName: string;
    role: "admin" | "lead" | "member";
    tier: "team" | "external";
  };

  if (existing) {
    created = false;
    memberId = existing.id;
    memberStatus = existing.status;
    // Re-invite uses the member's stored identity (role/tier/display_name), not the payload — the
    // invite re-issues access, it isn't a role/profile edit.
    member = {
      id: existing.id,
      email,
      displayName: existing.display_name,
      role: existing.role,
      tier: existing.tier,
    };
  } else {
    try {
      const c = await createMember(
        db,
        auth.teamId,
        {
          email: body.email,
          displayName: body.display_name,
          actorHandle: body.actor_handle,
          role: body.role,
        },
        { actor: { kind: "member", memberId: auth.memberId } }
      );
      memberId = c.id;
      memberStatus = c.status;
    } catch (e) {
      // A unique-constraint hit (e.g. actor_handle already taken, or an email race) is client input.
      if (e instanceof MemberExistsError) return errorResponse("invalid_payload", e.message, 422);
      return errorResponse("internal", e instanceof Error ? e.message : "create failed", 500);
    }
    created = true;
    member = {
      id: memberId,
      email,
      displayName: body.display_name,
      role: body.role,
      tier: "team",
    };
  }

  const manual = !magicLinkAvailable();
  const issued = await issueMemberInvite(db, {
    teamId: auth.teamId,
    member,
    teamName,
    inviterName: auth.displayName ?? "Your admin",
    nextPath: `/t/${teamSlug}`,
    teamUrl: (process.env.APP_URL ?? new URL(req.url).origin).replace(/\/$/, ""),
    tools: body.tools,
    manual,
    password: manual ? randomPassword() : undefined,
    actor: { kind: "member", memberId: auth.memberId },
  });

  if (!issued.ok) {
    // Sign-in issuance (not provisioning) failed. Roll back a member we just created so we don't
    // orphan an 'invited' row with no way to sign in; an existing member is left untouched.
    if (created && manual) {
      await rollbackMemberCreation(db, auth.teamId, memberId, {
        actor: { kind: "member", memberId: auth.memberId },
      });
    }
    return errorResponse("internal", issued.error, 500);
  }

  // Best-effort company-graph sync (never fails the invite), mirroring the server-action path.
  try {
    await syncMemberActor(db, auth.teamId, memberId);
  } catch (e) {
    console.error("[company-graph] actor sync failed on api invite:", e instanceof Error ? e.message : e);
  }

  await audit(db, {
    team_id: auth.teamId,
    actor_kind: "member",
    member_id: auth.memberId,
    api_key_id: auth.apiKeyId,
    action: "member.invited",
    target_type: "member",
    target_id: memberId,
    meta: { email, created, mode: issued.mode }, // no credentials/links
  });

  const invite =
    issued.mode === "magic-link"
      ? {
          mode: "magic-link" as const,
          email_delivered: issued.emailDelivered,
          ...(issued.loginUrl ? { login_url: issued.loginUrl } : {}),
        }
      : {
          mode: "manual" as const,
          password: issued.password,
          invite_message: issued.inviteMessage,
        };

  return Response.json(
    {
      member: { id: memberId, email, status: memberStatus, created },
      invite,
      provisioning: issued.provisioning.map((r) => ({
        tool: r.tool,
        status: r.status,
        detail: r.detail,
        ...(r.inviteLink ? { invite_link: r.inviteLink } : {}),
      })),
    },
    { status: 200 }
  );
}
