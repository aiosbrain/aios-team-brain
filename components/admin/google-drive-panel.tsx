import { KeyRound, Plug, RefreshCw } from "lucide-react";

import type { IntegrationRow } from "@/components/admin/integrations-manager";
import { type DriveSelection } from "@/lib/integrations/gdrive-admin-selection";
import { describeGdriveCoordinator, type GdriveRunStatus } from "@/lib/integrations/gdrive-run-status";

/**
 * The Admin Google Drive panel (AIO-1167): authorization, coordinator status and the Drive-specific
 * actions for ONE selected named connection (`lib/integrations/gdrive-admin-selection`).
 *
 * Deliberately hook-free and stateless: the parent owns the selection, the transition and every
 * per-connection result; this renders them and hands each action the exact connection it was
 * clicked for. That is what makes "every status line and action binds to the selected connection's
 * immutable id" checkable without a browser (`test/google-drive-panel.test.ts`).
 */
export interface GoogleDrivePanelProps {
  teamSlug: string;
  connections: IntegrationRow[];
  selection: DriveSelection<IntegrationRow>;
  gdriveStatus: Record<string, GdriveRunStatus>;
  pickerConfigured: boolean;
  pending: boolean;
  /** Already narrowed to the selected connection by the parent (`valueFor`). */
  testMessage: string | null;
  previewContinuation: number | null;
  connectorKey: string | null;
  summarize: (config: Record<string, unknown>) => string;
  onSelect: (connectionId: string) => void;
  onChooseFiles: (connection: IntegrationRow) => void;
  onRun: (connection: IntegrationRow, trigger: "manual" | "retry") => void;
  onTest: (connection: IntegrationRow, continuation: number) => void;
  onProvision: (connection: IntegrationRow) => void;
}

const MISSING_LINE = "The selected Google Drive connection is no longer listed. Choose a connection to see its status and actions.";

function describeAuthorization(drive: IntegrationRow, summarize: GoogleDrivePanelProps["summarize"]): string {
  if (drive.config.authMode === "service_account") {
    return `Service-account mode: ${String(drive.config.serviceAccountStatus ?? "pending")} ${drive.config.serviceAccountIdentity ? `(${String(drive.config.serviceAccountIdentity)})` : ""}. Credentials remain local to the sidecar. ${summarize(drive.config)}.`;
  }
  return `${drive.hasSecret ? `Connected as ${String(drive.config.authenticatedAccount ?? "an unverified account")}` : "Reconnect required"}. ${drive.status === "disabled" ? "Paused or disconnected. " : ""}${summarize(drive.config)}. Shared-login member credit is managed under Members → Identities.`;
}

export function GoogleDrivePanel(props: GoogleDrivePanelProps) {
  const { teamSlug, connections, selection, pending } = props;
  const drive = selection.kind === "selected" ? selection.connection : null;
  const missing = selection.kind === "missing";
  // Current state first, then history: latest attempt, latest progress, latest proven success —
  // always the SELECTED connection's own status, read by its immutable id.
  const statusLines = missing
    ? [MISSING_LINE]
    : describeGdriveCoordinator({
        integrationStatus: drive?.status ?? null,
        status: drive ? props.gdriveStatus[drive.id] ?? null : null,
      });
  const runnable = drive !== null && drive.status === "enabled"
    && (drive.config.authMode === "service_account" || drive.hasSecret);
  // A new connection is only offered when none exists; reconnecting always names the selected one.
  const authName = drive?.name ?? "google-drive";

  return (
    <section className="prism-card flex flex-col gap-3 p-4" aria-labelledby="google-drive-heading">
      <div>
        <p id="google-drive-heading" className="flex items-center gap-2 text-sm font-medium text-ink">
          <Plug className="size-4 text-violet" /> Google Drive authorization
        </p>
        {connections.length > 1 || missing ? (
          <label className="mt-2 flex items-center gap-2 text-xs text-ink-secondary" htmlFor="google-drive-connection">
            Connection
            <select
              id="google-drive-connection"
              className="prism-input text-xs"
              value={drive?.id ?? ""}
              disabled={pending}
              onChange={(event) => { if (event.target.value) props.onSelect(event.target.value); }}
            >
              {missing ? <option value="">Choose a connection…</option> : null}
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name}{connection.status === "enabled" ? "" : " (paused)"}
                </option>
              ))}
            </select>
          </label>
        ) : drive ? (
          <p className="mt-2 text-xs text-ink-secondary">Connection: <span className="font-medium text-ink">{drive.name}</span></p>
        ) : null}
        <p className="mt-1 text-xs text-ink-secondary">
          {drive
            ? describeAuthorization(drive, props.summarize)
            : missing ? MISSING_LINE : "No Google Drive account is connected yet."}
        </p>
      </div>
      {missing ? null : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-border-default p-3">
              <p className="text-xs font-medium text-ink">Individual files</p>
              <p className="mt-1 text-xs text-ink-secondary">
                Uses Google&apos;s per-file <code>drive.file</code> scope. It cannot discover every child
                of a folder unless those files were individually authorized.
              </p>
              {drive && props.pickerConfigured ? (
                <button
                  type="button"
                  onClick={() => props.onChooseFiles(drive)}
                  disabled={pending}
                  className="mt-3 inline-flex rounded-lg border border-violet/40 bg-violet/10 px-3 py-1.5 text-xs font-medium text-violet disabled:opacity-50"
                >
                  Choose Google Docs
                </button>
              ) : (
                <a
                  className="mt-3 inline-flex rounded-lg border border-violet/40 bg-violet/10 px-3 py-1.5 text-xs font-medium text-violet"
                  href={`/api/auth/gdrive/start?team=${encodeURIComponent(teamSlug)}&name=${encodeURIComponent(authName)}&mode=files`}
                >
                  {drive ? "Reconnect file access" : "Connect selected files"}
                </a>
              )}
              {drive && !props.pickerConfigured ? (
                <p className="mt-2 text-xs text-amber-700">Picker is not configured on this instance; reconnect remains available.</p>
              ) : null}
            </div>
            <div className="rounded-lg border border-border-default p-3">
              <p className="text-xs font-medium text-ink">Folders or Shared Drives</p>
              <p className="mt-1 text-xs text-ink-secondary">
                Folder discovery needs broader read-only Drive access. Consent allows discovery, but
                the saved selection below still limits what the connector imports.
              </p>
              <a
                className="mt-3 inline-flex rounded-lg border border-violet/40 bg-violet/10 px-3 py-1.5 text-xs font-medium text-violet"
                href={`/api/auth/gdrive/start?team=${encodeURIComponent(teamSlug)}&name=${encodeURIComponent(authName)}&mode=folders`}
              >
                {drive ? "Reconnect folder access" : "Connect folders"}
              </a>
            </div>
          </div>
          <p className="text-xs text-ink-tertiary">
            Reconnecting replaces credentials for this named connection without expanding its saved
            file, folder, Shared Drive, project, or audience selection.
          </p>
        </>
      )}
      <div className="rounded-lg border border-border-default p-3" aria-live="polite">
        <p className="text-xs font-medium text-ink">Coordinator status</p>
        {statusLines.map((line) => (
          <p key={line} className="mt-1 text-xs text-ink-secondary">{line}</p>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => { if (drive) props.onRun(drive, "manual"); }}
          disabled={pending || !runnable}
          className="inline-flex items-center gap-1.5 rounded-lg border border-violet/40 bg-violet/10 px-3 py-1.5 text-xs font-medium text-violet disabled:opacity-50"
        >
          <RefreshCw className={`size-3.5 ${pending ? "animate-spin" : ""}`} /> Run now
        </button>
        <button
          type="button"
          onClick={() => { if (drive) props.onRun(drive, "retry"); }}
          disabled={pending || !runnable}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-xs font-medium text-ink-secondary disabled:opacity-50"
        >
          Retry pending work
        </button>
        <button
          type="button"
          onClick={() => { if (drive) props.onTest(drive, 0); }}
          disabled={pending || !drive}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-xs font-medium text-ink-secondary disabled:opacity-50"
        >
          <RefreshCw className={`size-3.5 ${pending ? "animate-spin" : ""}`} /> Test connection and preview scope
        </button>
        <span className="text-xs text-ink-tertiary">Tests only the exact saved roots; it never expands the selection.</span>
        {drive && props.previewContinuation !== null ? (
          <button
            type="button"
            onClick={() => props.onTest(drive, props.previewContinuation ?? 0)}
            disabled={pending}
            className="inline-flex items-center rounded-lg border border-border-default px-3 py-1.5 text-xs font-medium text-ink-secondary disabled:opacity-50"
          >
            Continue preview at {props.previewContinuation}
          </button>
        ) : null}
      </div>
      <div className="rounded-lg border border-border-default p-3">
        <p className="text-xs font-medium text-ink">Remote connector principal</p>
        <p className="mt-1 text-xs text-ink-secondary">
          Provision or rotate the dedicated sidecar key{drive ? <> for <span className="font-medium text-ink">{drive.name}</span></> : null}.
          Rotation immediately fences active workers; the key is shown once and is never stored in plaintext.
        </p>
        <button
          type="button"
          onClick={() => { if (drive) props.onProvision(drive); }}
          disabled={pending || !drive}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-xs font-medium text-ink-secondary disabled:opacity-50"
        >
          <KeyRound className="size-3.5" /> Provision / rotate connector key
        </button>
        {props.connectorKey ? (
          <div className="mt-3" role="status">
            <p className="text-xs font-medium text-amber-700">Copy this key now. It will not be shown again.</p>
            <input className="prism-input mt-1 w-full font-mono text-xs" readOnly value={props.connectorKey} aria-label="One-time Google Drive connector key" />
          </div>
        ) : null}
      </div>
      <p aria-live="polite" className="text-xs text-ink-secondary">
        {props.testMessage ?? "OAuth runs use short-lived server-brokered access; refresh credentials never leave the encrypted store."}
      </p>
    </section>
  );
}
