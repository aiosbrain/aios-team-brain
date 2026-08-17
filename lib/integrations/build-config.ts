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

/** Split ONE `key=value`'s value into multiple entries. `|` because `,` is the outer separator. */
function subList(raw: string): string[] {
  return raw
    .split("|")
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
    case "notion":
      // `databaseId=<id>` selects a whole database; otherwise the entries are page ids.
      return kv.databaseId ? { databaseId: kv.databaseId } : { pageIds: list };
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
    case "clickup": {
      // `toList` already consumed commas/newlines as the OUTER separator, so a multi-value field
      // needs an inner one: `workspaceId=9001, listIds=101|202, docIds=doc-alpha|doc-beta`.
      // Keys are dropped when absent rather than set to `undefined` — `config` is stored as jsonb
      // and a re-save must not add null-ish keys the `.strict()` allowlist then has to tolerate.
      const out: Record<string, unknown> = {};
      // A lone bare token is the workspace id — the hint shows `workspaceId=…`, but an admin who
      // types just `9001` would otherwise have it silently dropped and save an empty config with no
      // complaint. linear/plane already fall back this way for `projectId`; matching that.
      const bare = list.filter((entry) => !entry.includes("="));
      if (kv.workspaceId) out.workspaceId = kv.workspaceId;
      else if (bare.length === 1) out.workspaceId = bare[0];
      out.listIds = kv.listIds ? subList(kv.listIds) : [];
      if (kv.docIds) out.docIds = subList(kv.docIds);
      if (kv.docParentType) out.docParentType = kv.docParentType.toUpperCase();
      if (kv.docParentId) out.docParentId = kv.docParentId;
      return out;
    }
    default:
      return {};
  }
}
