import "server-only";
import type { DbClient } from "@/lib/db/types";
import { issueLoginLink } from "@/lib/admin/login";
import { adminSetPassword } from "@/lib/auth/pg-login";
import { sendInviteEmail, buildManualInviteMessage } from "@/lib/auth/mailer";
import { runProvisioning } from "@/lib/provisioning/run";
import type { ProvisioningResult, ProvisioningTool } from "@/lib/provisioning/types";
import type { ActorContext } from "./members";

/**
 * The shared invite CORE reused by the two invite triggers — the admin server action
 * (`app/t/[team]/admin/actions.ts inviteMember`) and the REST endpoint
 * (`POST /api/v1/members/invite`). Given a member row that ALREADY exists (both callers own their own
 * create/idempotency + rollback policy — the divergent part), it grants sign-in access one of two
 * ways, runs the best-effort provisioning cascade, and (magic-link mode) folds the cascade's Slack
 * link / Linear+GitHub status into the invite email:
 *
 *  - **magic-link** (`manual === false`): issue a single-use sign-in link, provision, then email it.
 *  - **manual** (`manual === true`): set the given password directly, provision, and return a
 *    ready-to-paste invite message.
 *
 * Provisioning is best-effort and NEVER changes the outcome (it can't throw; a `failed` tool is just
 * a result row). The only hard failures are the sign-in issuance itself (no link, or the password
 * write erroring) — surfaced as `{ ok: false }` so the caller can roll back a just-created member.
 */

// Generous window for an admin-issued invite (vs. the 15-minute TTL for a self-service login link)
// — the invitee may not open their email right away. Bumped from 7 to 14 days (2026-07-21): a
// week was proving too short in practice for invitees who don't check email right after an invite.
export const INVITE_LINK_TTL_MINUTES = 14 * 24 * 60;

export interface IssueInviteMember {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "lead" | "member";
  tier: "team" | "external";
}

export interface IssueInviteInput {
  teamId: string;
  member: IssueInviteMember;
  teamName: string;
  inviterName: string;
  /** Where the sign-in link lands after confirm (magic-link mode). */
  nextPath: string;
  /** Base sign-in URL for the manual copy-paste message. */
  teamUrl: string;
  /** Which tools to provision. */
  tools: ProvisioningTool[] | "all" | "none";
  /** false → magic-link; true → set `password` directly. */
  manual: boolean;
  /** Required when `manual` is true (the caller has already strength-checked / generated it). */
  password?: string;
  actor: ActorContext;
}

export type IssueInviteResult =
  | {
      ok: true;
      mode: "magic-link";
      emailDelivered: boolean;
      /** Set ONLY when delivery failed — the already-issued link, so the caller has a fallback. */
      loginUrl?: string;
      provisioning: ProvisioningResult[];
    }
  | {
      ok: true;
      mode: "manual";
      password: string;
      inviteMessage: string;
      provisioning: ProvisioningResult[];
    }
  | { ok: false; error: string };

/**
 * Distil the provisioning results into the invite email's "Your team tools" section: the Slack
 * standing join link (only when `link_provided`) and whether Linear/GitHub actually `sent` an
 * invite. Anything skipped/failed is omitted — the email only mentions tools the invitee can act on.
 */
function emailInviteTools(
  results: ProvisioningResult[]
): { slackInviteLink?: string; linearInvited?: boolean; githubInvited?: boolean } | undefined {
  const slack = results.find((r) => r.tool === "slack" && r.status === "link_provided");
  const linear = results.find((r) => r.tool === "linear" && r.status === "sent");
  const github = results.find((r) => r.tool === "github" && r.status === "sent");
  const out: { slackInviteLink?: string; linearInvited?: boolean; githubInvited?: boolean } = {};
  if (slack?.inviteLink) out.slackInviteLink = slack.inviteLink;
  if (linear) out.linearInvited = true;
  if (github) out.githubInvited = true;
  return Object.keys(out).length ? out : undefined;
}

export async function issueMemberInvite(
  db: DbClient,
  input: IssueInviteInput
): Promise<IssueInviteResult> {
  const { teamId, member, teamName, inviterName, nextPath, teamUrl, tools, manual, password, actor } =
    input;

  if (!manual) {
    const { url } = await issueLoginLink(db, teamId, member.email, {
      nextPath,
      ttlMinutes: INVITE_LINK_TTL_MINUTES,
      baseUrl: process.env.APP_URL,
      actor,
    });
    if (!url) return { ok: false, error: "could not issue a sign-in link" };

    // Provision BEFORE the email so the Slack join link / Linear+GitHub status can ride along.
    const provisioning = await runProvisioning(db, teamId, member, tools);

    let emailDelivered = false;
    try {
      emailDelivered = await sendInviteEmail(member.email, {
        inviteeName: member.displayName,
        teamName,
        inviterName,
        loginUrl: url,
        tools: emailInviteTools(provisioning),
      });
    } catch (e) {
      console.error("[invite] email send failed:", e instanceof Error ? e.message : e);
    }

    return {
      ok: true,
      mode: "magic-link",
      emailDelivered,
      // Same admin, same screen, shown once — surfaced only when delivery failed.
      ...(emailDelivered ? {} : { loginUrl: url }),
      provisioning,
    };
  }

  const pw = password ?? "";
  try {
    await adminSetPassword(member.email, pw);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not set initial password" };
  }

  const provisioning = await runProvisioning(db, teamId, member, tools);
  const inviteMessage = buildManualInviteMessage({
    inviteeName: member.displayName,
    teamName,
    inviterName,
    teamUrl,
    email: member.email,
    password: pw,
  });

  return { ok: true, mode: "manual", password: pw, inviteMessage, provisioning };
}
