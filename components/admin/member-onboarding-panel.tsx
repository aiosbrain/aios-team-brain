"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, Save } from "lucide-react";
import { saveProvisioningSettings } from "@/app/t/[team]/admin/integrations/actions";

export interface MemberOnboardingValues {
  linearTeamIds: string;
  linearRole: string;
  slackInviteLink: string;
  githubOrg: string;
}

interface MemberOnboardingPanelProps {
  teamSlug: string;
  values: MemberOnboardingValues;
}

/**
 * Admin → Integrations · Member onboarding. Sets the NON-SECRET invite hints the provisioning
 * cascade (lib/provisioning) uses when a member is onboarded: which Linear team(s) + role, the Slack
 * standing join link, and the GitHub org. Writes go through the admin-gated `saveProvisioningSettings`
 * server action, which merges only these keys into each tool's existing integration row.
 */
export function MemberOnboardingPanel({ teamSlug, values }: MemberOnboardingPanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState<MemberOnboardingValues>(values);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function set<K extends keyof MemberOnboardingValues>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await saveProvisioningSettings(teamSlug, form);
      if (!res.ok) setError(res.error ?? "could not save");
      else {
        setSaved(true);
        router.refresh();
      }
    });
  }

  return (
    <div className="prism-card flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <UserPlus className="size-4 text-violet" /> Member onboarding
        </p>
        <span className="text-xs text-ink-tertiary">tool invites sent when a member is added</span>
      </div>
      <p className="text-xs text-ink-secondary">
        When a member is provisioned, the brain invites them into these tools. Linear and GitHub send
        an invite email; Slack (Free/Pro has no invite API) surfaces a standing join link the member
        opens themselves. These are non-secret hints — each tool&apos;s token is connected separately.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-secondary">Linear invite team IDs</span>
          <input
            className="prism-input"
            placeholder="comma-separated Linear team ids"
            value={form.linearTeamIds}
            onChange={(e) => set("linearTeamIds", e.target.value)}
            aria-label="Linear invite team IDs"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-secondary">Linear invite role</span>
          <select
            className="prism-input"
            value={form.linearRole}
            onChange={(e) => set("linearRole", e.target.value)}
            aria-label="Linear invite role"
          >
            <option value="">Default (guest for external, else user)</option>
            <option value="user">User</option>
            <option value="admin">Admin</option>
            <option value="guest">Guest</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-secondary">Slack invite link</span>
          <input
            className="prism-input"
            type="url"
            placeholder="https://join.slack.com/t/…"
            value={form.slackInviteLink}
            onChange={(e) => set("slackInviteLink", e.target.value)}
            aria-label="Slack invite link"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-secondary">GitHub org</span>
          <input
            className="prism-input"
            placeholder="org login (e.g. acme)"
            value={form.githubOrg}
            onChange={(e) => set("githubOrg", e.target.value)}
            aria-label="GitHub org"
          />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={pending} className="btn-prism justify-center">
          <Save className="size-4" /> Save
        </button>
        {saved ? <span className="text-sm text-emerald-700">Saved.</span> : null}
        {error ? <span className="text-sm text-red">{error}</span> : null}
      </div>
    </div>
  );
}
