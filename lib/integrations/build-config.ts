import type { IntegrationType } from "@/lib/api/schemas";

// Map the admin form's single free-text "selection" field to the per-type NON-SECRET config shape
// stored in `integrations.config` (validated downstream by `validateIntegrationConfig`). Extracted
// from the admin server action so the parsing is unit-testable (a server-action module is
// "use server" and can only export async actions).

/** Split a free-text field on commas/newlines into trimmed, non-empty tokens. */
export function toList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toKeyValues(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of toList(raw)) {
    const m = part.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Non-selection options threaded from dedicated form controls (not the free-text field). */
export interface BuildConfigOptions {
  /** Linear only: per-team opt-in to inbound apply (Linear→brain). Off unless explicitly true —
   *  the field is omitted when false so the gate (`config.inboundApply === true`) stays default-off. */
  inboundApply?: boolean;
}

export function buildConfig(
  type: IntegrationType,
  selection: string,
  opts: BuildConfigOptions = {}
): Record<string, unknown> {
  const list = toList(selection);
  const kv = toKeyValues(selection);
  switch (type) {
    case "slack":
      return { channelIds: list };
    case "github":
      return { repos: list };
    case "granola":
      return { matchKeywords: list };
    case "wise":
      return list[0] ? { profileId: list[0] } : {};
    case "linear": {
      const base = Object.keys(kv).length
        ? { teamId: kv.teamId, projectId: kv.projectId, doneStateName: kv.doneStateName }
        : list[0]
          ? { projectId: list[0] }
          : {};
      return opts.inboundApply ? { ...base, inboundApply: true } : base;
    }
    case "plane":
      return Object.keys(kv).length
        ? {
            baseUrl: kv.baseUrl,
            workspaceSlug: kv.workspaceSlug,
            projectId: kv.projectId,
            doneStateName: kv.doneStateName,
            externalSource: kv.externalSource,
          }
        : list[0]
          ? { projectId: list[0] }
          : {};
    default:
      return {};
  }
}
