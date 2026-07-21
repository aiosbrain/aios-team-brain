"use client";

import { useMemo, useState, useTransition } from "react";
import { UserPlus, Copy, Check, Dices, CircleSlash, Link2, AlertCircle } from "lucide-react";
import { inviteMember, type InviteMemberResult } from "@/app/t/[team]/admin/actions";
import type { ProvisioningAvailability } from "@/app/t/[team]/admin/actions";
import type { ProvisioningResult, ProvisioningTool } from "@/lib/provisioning/types";

type Issued = Extract<InviteMemberResult, { ok: true }>;

const TOOL_LABEL: Record<ProvisioningTool, string> = {
  linear: "Linear",
  slack: "Slack",
  github: "GitHub",
};

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-2 rounded-lg border border-border-default px-3 py-2 text-sm text-ink-secondary hover:text-ink"
    >
      {copied ? <Check className="size-4 text-violet" /> : <Copy className="size-4" />}
      {copied ? "Copied" : label}
    </button>
  );
}

function ProvisioningBadge({ status }: { status: ProvisioningResult["status"] }) {
  if (status === "sent") return <Check className="size-4 shrink-0 text-emerald-600" />;
  if (status === "link_provided") return <Link2 className="size-4 shrink-0 text-violet" />;
  if (status === "failed") return <AlertCircle className="size-4 shrink-0 text-red-600" />;
  return <CircleSlash className="size-4 shrink-0 text-ink-tertiary" />;
}

/** The per-tool provisioning outcomes, rendered under a success card. */
function ProvisioningResults({ results }: { results: ProvisioningResult[] }) {
  if (results.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">Team tools</p>
      {results.map((r) => (
        <div key={r.tool} className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-sm text-ink">
            <ProvisioningBadge status={r.status} />
            <span className="font-medium">{TOOL_LABEL[r.tool]}</span>
            <span className="text-ink-secondary">— {r.detail}</span>
          </div>
          {r.status === "link_provided" && r.inviteLink && (
            <div className="flex flex-wrap items-center gap-2 pl-6">
              <pre className="whitespace-pre-wrap break-all rounded-lg bg-surface-overlay px-3 py-2 font-mono text-xs text-ink">
                {r.inviteLink}
              </pre>
              <CopyButton text={r.inviteLink} label="Copy join link" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function InviteMember({
  teamSlug,
  provisioningAvailability = [],
}: {
  teamSlug: string;
  provisioningAvailability?: ProvisioningAvailability;
}) {
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [pending, startTransition] = useTransition();

  // Only configured tools default to checked; an unconfigured tool renders disabled with its reason.
  const configuredTools = useMemo(
    () => provisioningAvailability.filter((a) => a.configured).map((a) => a.tool),
    [provisioningAvailability]
  );
  const [selected, setSelected] = useState<Set<ProvisioningTool>>(() => new Set(configuredTools));

  function toggle(tool: ProvisioningTool) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tool)) next.delete(tool);
      else next.add(tool);
      return next;
    });
  }

  function reset() {
    setIssued(null);
    setOpen(false);
    setManual(false);
    setPassword("");
    setSelected(new Set(configuredTools));
  }

  if (issued?.mode === "magic-link") {
    return (
      <div className="prism-card flex flex-col gap-3 border border-violet/40 p-4">
        <p className="text-sm font-medium text-ink">
          {issued.emailDelivered
            ? `Invite email sent to ${issued.email} with a one-time sign-in link (valid 14 days).`
            : `Member created for ${issued.email}, but we couldn't confirm the invite email was delivered.`}
        </p>
        {!issued.emailDelivered && issued.loginUrl && (
          <>
            <pre className="whitespace-pre-wrap break-all rounded-lg bg-surface-overlay px-3 py-2 font-mono text-xs text-ink">
              {issued.loginUrl}
            </pre>
            <div className="flex gap-2">
              <CopyButton text={issued.loginUrl} label="Copy sign-in link" />
            </div>
            <p className="text-xs text-ink-tertiary">
              Email delivery failed — share this sign-in link directly, or re-invite with a manual
              password.
            </p>
          </>
        )}
        <ProvisioningResults results={issued.provisioning} />
        <button
          onClick={reset}
          className="self-start rounded-lg bg-violet px-4 py-2 text-sm font-medium text-white"
        >
          Done
        </button>
      </div>
    );
  }

  if (issued?.mode === "manual") {
    const intro =
      issued.reason === "admin-choice"
        ? `Share this message with ${issued.email} directly (Slack, DM, etc). It's shown exactly once; only the password's hash is stored.`
        : `Email delivery isn't configured for this deployment — share this message with ${issued.email} directly (Slack, DM, etc). It's shown exactly once; only the password's hash is stored.`;
    return (
      <div className="prism-card flex flex-col gap-3 border border-violet/40 p-4">
        <p className="text-sm font-medium text-ink">{intro}</p>
        <pre className="whitespace-pre-wrap rounded-lg bg-surface-overlay px-3 py-2 font-mono text-xs text-ink">
          {issued.inviteMessage}
        </pre>
        <div className="flex gap-2">
          <CopyButton text={issued.inviteMessage} label="Copy message" />
          <CopyButton text={issued.password} label="Copy password only" />
        </div>
        <ProvisioningResults results={issued.provisioning} />
        <button
          onClick={reset}
          className="self-start rounded-lg bg-violet px-4 py-2 text-sm font-medium text-white"
        >
          Done — I shared it
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-violet px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
      >
        <UserPlus className="size-4" strokeWidth={1.75} />
        Invite member
      </button>
    );
  }

  return (
    <form
      className="prism-card flex flex-col gap-3 p-4"
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const res = await inviteMember(teamSlug, {
            email: String(formData.get("email") ?? ""),
            displayName: String(formData.get("displayName") ?? ""),
            actorHandle: String(formData.get("actorHandle") ?? ""),
            role: (String(formData.get("role")) as "admin" | "lead" | "member") || "member",
            manualInvite: manual,
            password: manual ? password || undefined : undefined,
            tools: selected.size === 0 ? "none" : Array.from(selected),
          });
          if (!res.ok) setError(res.error);
          else setIssued(res);
        });
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <input name="email" type="email" required placeholder="email"
          className="rounded-lg border border-border-default bg-surface-base px-3 py-2 text-sm text-ink outline-none focus:border-violet" />
        <input name="displayName" required placeholder="display name"
          className="rounded-lg border border-border-default bg-surface-base px-3 py-2 text-sm text-ink outline-none focus:border-violet" />
        <input name="actorHandle" required placeholder="actor handle (e.g. alex — matches aios pushes)"
          className="rounded-lg border border-border-default bg-surface-base px-3 py-2 text-sm text-ink outline-none focus:border-violet" />
        <select name="role" defaultValue="member"
          className="rounded-lg border border-border-default bg-surface-base px-3 py-2 text-sm text-ink outline-none focus:border-violet">
          <option value="member">member</option>
          <option value="lead">lead</option>
          <option value="admin">admin</option>
        </select>
      </div>

      {provisioningAvailability.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-border-subtle p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
            Provision into team tools
          </p>
          <div className="flex flex-wrap gap-4">
            {provisioningAvailability.map((a) => (
              <label
                key={a.tool}
                title={a.configured ? undefined : a.reason}
                className={`flex items-center gap-2 text-sm ${a.configured ? "text-ink" : "cursor-not-allowed text-ink-tertiary"}`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(a.tool)}
                  disabled={!a.configured}
                  onChange={() => toggle(a.tool)}
                  className="size-4 accent-violet disabled:opacity-50"
                />
                {TOOL_LABEL[a.tool]}
                {!a.configured && a.reason ? (
                  <span className="text-xs text-ink-tertiary">({a.reason})</span>
                ) : null}
              </label>
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setManual((m) => !m)}
        className="self-start text-xs text-ink-tertiary underline"
      >
        {manual ? "Use a magic sign-in link instead" : "Set a password manually instead"}
      </button>

      {manual && (
        <div className="flex items-center gap-2">
          <input
            name="password"
            type="text"
            placeholder="initial password (blank = generate a strong one)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="flex-1 rounded-lg border border-border-default bg-surface-base px-3 py-2 font-mono text-sm text-ink outline-none focus:border-violet"
          />
          <button
            type="button"
            onClick={() => setPassword(crypto.randomUUID().replace(/-/g, "").slice(0, 16))}
            className="rounded-lg border border-border-default p-2 text-ink-secondary hover:text-ink"
            aria-label="Generate a password"
            title="Generate a password"
          >
            <Dices className="size-4" />
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={pending}
          className="rounded-lg bg-violet px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {pending ? "Inviting…" : "Invite"}
        </button>
        <button type="button" onClick={() => setOpen(false)}
          className="rounded-lg border border-border-default px-4 py-2 text-sm text-ink-secondary">
          Cancel
        </button>
      </div>
      <p className="text-xs text-ink-tertiary">
        {manual
          ? "The member signs in with this email + password. Share the password with them out-of-band (Slack, in person) — it's never emailed."
          : "The member gets a one-click sign-in link by email. If this deployment has no mail provider configured, you'll get a ready-to-share invite instead."}
      </p>
    </form>
  );
}
