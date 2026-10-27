/**
 * AIO-1167 R43 F3 — the Google grant each Drive consent mode may hold (AC-01: least privilege for
 * the selected mode).
 *
 *   · `files`   — per-file consent: `drive.file` only (Picker-granted documents).
 *   · `folders` — explicit discovery consent: `drive.readonly` (and the narrower `drive.file`).
 *
 * Both modes also carry the OpenID identity scopes the callback uses to learn the account. The
 * mode is chosen at OAuth start, signed into the one-use state, re-checked against the scopes
 * Google actually granted before anything is published, recorded with the credential, and enforced
 * again on every broker refresh. A grant broader than the mode allows is REFUSED, never relabelled:
 * filtering the unexpected scope out of the list would hide authority the credential still has.
 *
 * Pure: no I/O, so the rules are unit-tested directly.
 */

export type GdriveGrantMode = "files" | "folders";

export const GDRIVE_GRANT_MODES: readonly GdriveGrantMode[] = ["files", "folders"];

const GOOGLE = "https://www.googleapis.com/auth/";
export const DRIVE_FILE_SCOPE = `${GOOGLE}drive.file`;
export const DRIVE_READONLY_SCOPE = `${GOOGLE}drive.readonly`;

/** OpenID identity scopes, in both spellings Google returns them. Not Drive authority. */
const IDENTITY_SCOPES = new Map<string, string>([
  ["openid", "openid"],
  ["email", "email"],
  [`${GOOGLE}userinfo.email`, "email"],
  ["profile", "profile"],
  [`${GOOGLE}userinfo.profile`, "profile"],
]);

const IDENTITY_REQUEST = ["openid", "email", "profile"];

const POLICY: Record<GdriveGrantMode, { request: string[]; required: string; allowed: ReadonlySet<string> }> = {
  files: {
    request: [...IDENTITY_REQUEST, DRIVE_FILE_SCOPE],
    required: DRIVE_FILE_SCOPE,
    allowed: new Set([DRIVE_FILE_SCOPE]),
  },
  folders: {
    request: [...IDENTITY_REQUEST, DRIVE_READONLY_SCOPE],
    required: DRIVE_READONLY_SCOPE,
    allowed: new Set([DRIVE_READONLY_SCOPE, DRIVE_FILE_SCOPE]),
  },
};

export function isGdriveGrantMode(value: unknown): value is GdriveGrantMode {
  return value === "files" || value === "folders";
}

/** The scopes OAuth start requests for a mode — exactly these, never a union with earlier grants. */
export function gdriveRequestScopes(mode: GdriveGrantMode): string[] {
  return [...POLICY[mode].request];
}

/** Split Google's space-delimited `scope` value; `null` when it is absent or not a string. */
export function parseGrantedScopes(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  const scopes = value.split(/\s+/).filter(Boolean);
  return scopes.length > 0 ? [...new Set(scopes)] : null;
}

export type GdriveGrantVerdict =
  | { ok: true; scopes: string[] }
  /** No grant evidence at all. */
  | { ok: false; reason: "missing" }
  /** The mode's Drive scope was not granted. */
  | { ok: false; reason: "insufficient" }
  /** A scope outside the mode's ceiling was granted (listed, so it can be reported, never hidden). */
  | { ok: false; reason: "broader"; unexpected: string[] };

/**
 * Judge a granted scope list against a mode. The full granted list is returned on success — it is
 * what gets recorded, so nothing the credential holds goes unrecorded.
 */
export function evaluateGdriveGrant(mode: GdriveGrantMode, granted: readonly unknown[] | null | undefined): GdriveGrantVerdict {
  if (!Array.isArray(granted) || granted.length === 0) return { ok: false, reason: "missing" };
  // A recorded list can hold anything (it is read back from storage); only non-empty strings count.
  const scopes = [...new Set(granted.filter((s): s is string => typeof s === "string" && s.length > 0))];
  if (scopes.length === 0) return { ok: false, reason: "missing" };
  const policy = POLICY[mode];
  const unexpected = scopes.filter((scope) => !IDENTITY_SCOPES.has(scope) && !policy.allowed.has(scope));
  if (unexpected.length > 0) return { ok: false, reason: "broader", unexpected };
  if (!scopes.includes(policy.required)) return { ok: false, reason: "insufficient" };
  return { ok: true, scopes };
}
