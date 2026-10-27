import { describe, expect, it } from "vitest";

import {
  DRIVE_FILE_SCOPE,
  DRIVE_READONLY_SCOPE,
  evaluateGdriveGrant,
  gdriveRequestScopes,
  isGdriveGrantMode,
  parseGrantedScopes,
  storedGrantCeiling,
} from "@/lib/integrations/gdrive-grant-policy";

/**
 * AIO-1167 R43 F3 — least privilege for the chosen consent mode (AC-01). `files` holds `drive.file`
 * only; `folders` holds `drive.readonly` (plus the narrower `drive.file`); both carry the OpenID
 * identity scopes in either spelling. Broader authority is REFUSED and reported, never filtered out.
 */

const G = "https://www.googleapis.com/auth/";

describe("request scopes", () => {
  it("each mode requests exactly its own scopes", () => {
    expect(gdriveRequestScopes("files")).toEqual(["openid", "email", "profile", DRIVE_FILE_SCOPE]);
    expect(gdriveRequestScopes("folders")).toEqual(["openid", "email", "profile", DRIVE_READONLY_SCOPE]);
  });

  it("returns a copy the caller cannot use to change the policy", () => {
    gdriveRequestScopes("files").push(`${G}drive`);
    expect(gdriveRequestScopes("files")).not.toContain(`${G}drive`);
  });
});

describe("isGdriveGrantMode", () => {
  it.each([["files", true], ["folders", true], ["FILES", false], ["", false], [undefined, false], [1, false]])(
    "%s → %s", (value, expected) => expect(isGdriveGrantMode(value)).toBe(expected),
  );
});

describe("parseGrantedScopes", () => {
  it("splits on any whitespace and de-duplicates", () => {
    expect(parseGrantedScopes(`openid  ${DRIVE_FILE_SCOPE}\n${DRIVE_FILE_SCOPE}`)).toEqual(["openid", DRIVE_FILE_SCOPE]);
  });
  it.each([[undefined], [null], [""], ["   "], [["openid"]], [42]])("%s carries no grant evidence", (value) => {
    expect(parseGrantedScopes(value)).toBeNull();
  });
});

describe("evaluateGdriveGrant — files", () => {
  it("accepts drive.file with identity scopes in both spellings, returning the full list", () => {
    const granted = ["openid", `${G}userinfo.email`, `${G}userinfo.profile`, "email", DRIVE_FILE_SCOPE];
    expect(evaluateGdriveGrant("files", granted)).toEqual({ ok: true, scopes: granted });
  });

  it.each([
    [DRIVE_READONLY_SCOPE],
    [`${G}drive`],
    [`${G}drive.metadata.readonly`],
    [`${G}gmail.readonly`],
  ])("refuses an extra %s as broader, naming it", (extra) => {
    expect(evaluateGdriveGrant("files", ["openid", DRIVE_FILE_SCOPE, extra]))
      .toEqual({ ok: false, reason: "broader", unexpected: [extra] });
  });

  it("refuses identity-only as insufficient", () => {
    expect(evaluateGdriveGrant("files", ["openid", "email", "profile"])).toEqual({ ok: false, reason: "insufficient" });
  });

  it.each([[null], [undefined], [[]], [[""]], [[1, null]]])("%s is missing evidence", (granted) => {
    expect(evaluateGdriveGrant("files", granted as unknown[] | null | undefined)).toEqual({ ok: false, reason: "missing" });
  });

  it("broader wins over insufficient: an unrequested scope is always reported", () => {
    expect(evaluateGdriveGrant("files", ["openid", DRIVE_READONLY_SCOPE]))
      .toEqual({ ok: false, reason: "broader", unexpected: [DRIVE_READONLY_SCOPE] });
  });
});

describe("evaluateGdriveGrant — folders", () => {
  it("accepts drive.readonly, alone or with the narrower drive.file", () => {
    expect(evaluateGdriveGrant("folders", ["openid", DRIVE_READONLY_SCOPE]).ok).toBe(true);
    expect(evaluateGdriveGrant("folders", ["openid", DRIVE_READONLY_SCOPE, DRIVE_FILE_SCOPE]).ok).toBe(true);
  });

  it("drive.file alone does not satisfy discovery", () => {
    expect(evaluateGdriveGrant("folders", ["openid", DRIVE_FILE_SCOPE])).toEqual({ ok: false, reason: "insufficient" });
  });

  it("full drive access is beyond discovery", () => {
    expect(evaluateGdriveGrant("folders", [DRIVE_READONLY_SCOPE, `${G}drive`]))
      .toEqual({ ok: false, reason: "broader", unexpected: [`${G}drive`] });
  });
});

describe("storedGrantCeiling — the broker's ceiling for a stored credential (R44 C15)", () => {
  it("a recorded mode is the ceiling, whatever scopes were recorded", () => {
    expect(storedGrantCeiling("files", [DRIVE_FILE_SCOPE])).toBe("files");
    expect(storedGrantCeiling("folders", undefined)).toBe("folders");
  });

  it.each([["everything"], [1], [""], [{}]])("an invalid recorded mode %s has no ceiling", (mode) => {
    expect(storedGrantCeiling(mode, [DRIVE_FILE_SCOPE])).toBeNull();
  });

  it("a legacy credential is held to the NARROWEST mode its own recorded grant fits", () => {
    expect(storedGrantCeiling(undefined, ["openid", DRIVE_FILE_SCOPE])).toBe("files");
    expect(storedGrantCeiling(undefined, [DRIVE_READONLY_SCOPE])).toBe("folders");
    expect(storedGrantCeiling(null, [DRIVE_READONLY_SCOPE, DRIVE_FILE_SCOPE])).toBe("folders");
  });

  it.each([
    ["no recorded scopes", undefined],
    ["a non-array", "drive.file"],
    ["an empty list", []],
    ["identity only", ["openid", "email"]],
    ["full Drive", [`${G}drive`]],
  ])("a legacy credential with %s must reconnect", (_case, scopes) => {
    expect(storedGrantCeiling(undefined, scopes)).toBeNull();
  });
});
