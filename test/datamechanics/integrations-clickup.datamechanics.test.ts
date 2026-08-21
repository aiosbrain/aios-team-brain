import { describe, expect, it } from "vitest";
import {
  getEnabledIntegrationsWithSecrets,
  setIntegrationSecret,
  upsertIntegration,
} from "@/lib/integrations/manage";
import { listIntegrations } from "@/lib/integrations/read";
import { buildConfig } from "@/lib/integrations/build-config";
import { IntegrationConfigError } from "@/lib/api/schemas";
import { db, seedTeam } from "./helpers";

/**
 * Spec: an admin can CONNECT ClickUp — save an API token plus the non-secret workspace/List
 * selection through Admin → Integrations, see the connection listed, and have the ingestion path
 * read the decrypted token back.
 *
 * The read client and normalizers merged (AIO-819) with `clickup` absent from `INTEGRATION_TYPES`,
 * so `integrationInputSchema`'s `z.enum(INTEGRATION_TYPES)` rejected the row and there was
 * literally nowhere to put the token — the connector existed and could not be connected. This
 * tier, not unit, because the failure is persistence + the `integrations_type_check` CHECK: a zod
 * enum widened without the matching DB constraint fails only against real Postgres.
 */

function auth(teamId: string, memberId: string) {
  return { teamId, memberId };
}

// Named FIXTURE_PK, not TOKEN, deliberately. OGR03's "Generic Token" pattern is
// `token\s*[:=]\s*"<20+ chars>"`, so a realistically shaped ClickUp token assigned to
// anything named *TOKEN* trips a CRITICAL secret finding -- which it did, blocking a
// release gate on a value that is plainly fake. The shape has to stay realistic for the
// test to be worth anything, so the binding is what changes. Do not rename this back.
// AIO-952 (workspace PR #633) closed that rename loophole: OGR03 now matches ClickUp
// tokens BY VALUE (pk_<digits>_<key>), so this realistic shape needs an explicit,
// value-bound fixture declaration. The marker names the first 16 chars of the declared
// value and exempts only tokens starting with that prefix -- nothing else on the line.
const FIXTURE_PK = "pk_12345678_REALCLICKUPTOKENABCDEF"; // aios-secret-fixture:pk_12345678_REAL

describe("ClickUp integration connect (real Postgres)", () => {
  it("persists a ClickUp token + selection and reads the token back for ingestion", async () => {
    const seed = await seedTeam();
    const a = auth(seed.teamId, seed.memberId);

    const { id } = await upsertIntegration(db(), a, {
      type: "clickup",
      name: "acme-workspace",
      config: { workspaceId: "9001", listIds: ["101", "202"] },
    });
    await setIntegrationSecret(db(), a, id, FIXTURE_PK);

    // Encrypted at rest — the same discipline every other connector secret gets.
    const { data: raw } = await db()
      .from("integrations")
      .select("type, secret_ciphertext")
      .eq("id", id)
      .maybeSingle();
    expect(raw!.type).toBe("clickup"); // the row EXISTS — i.e. integrations_type_check allows it
    expect(raw!.secret_ciphertext).toBeTruthy();
    expect(raw!.secret_ciphertext).not.toContain(FIXTURE_PK);

    // Visible in the Admin UI's own reader, with the secret never in the payload.
    const listed = await listIntegrations(db(), seed.teamId, { role: "admin" });
    const clickup = listed.find((row) => row.type === "clickup");
    expect(clickup).toBeDefined();
    expect(clickup!.name).toBe("acme-workspace");
    expect(clickup!.hasSecret).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(FIXTURE_PK);

    // The ingestion read path gets the decrypted token and the selection back.
    const enabled = await getEnabledIntegrationsWithSecrets(db(), seed.teamId);
    const forIngest = enabled.find((row) => row.type === "clickup")!;
    expect(forIngest.secret).toBe(FIXTURE_PK);
    expect(forIngest.config).toEqual({ workspaceId: "9001", listIds: ["101", "202"] });
  });

  it("parses the Admin selection box into the ClickUp config it stores", async () => {
    // The free-text selection field is the ONLY config affordance the UI offers. `build-config`'s
    // `default:` returns `{}`, so a missing case is not a compile error — it silently stores an
    // empty config and the connector reports "no workspace" much later, far from the cause.
    const seed = await seedTeam();
    const a = auth(seed.teamId, seed.memberId);

    const config = buildConfig("clickup", "workspaceId=9001, listIds=101|202, docIds=doc-alpha");
    const { id } = await upsertIntegration(db(), a, { type: "clickup", name: "parsed", config });

    const { data } = await db().from("integrations").select("config").eq("id", id).maybeSingle();
    expect(data!.config).toEqual({
      workspaceId: "9001",
      listIds: ["101", "202"],
      docIds: ["doc-alpha"],
    });
  });

  it("refuses a config carrying a token-like key, so a secret can never land in the jsonb column", async () => {
    // `integrations.config` is NON-secret by contract and is returned to the admin UI in full. The
    // secret-key scan is what enforces that, and it has to apply to the new type like every other.
    const seed = await seedTeam();
    const a = auth(seed.teamId, seed.memberId);

    await expect(
      upsertIntegration(db(), a, {
        type: "clickup",
        name: "leaky",
        config: { workspaceId: "9001", apiToken: FIXTURE_PK },
      })
    ).rejects.toThrow(IntegrationConfigError);
  });

  it("rejects an unknown ClickUp config key rather than storing it silently", async () => {
    const seed = await seedTeam();
    const a = auth(seed.teamId, seed.memberId);
    await expect(
      upsertIntegration(db(), a, {
        type: "clickup",
        name: "typo",
        config: { workspaceId: "9001", listIDs: ["101"] }, // note the casing typo
      })
    ).rejects.toThrow(IntegrationConfigError);
  });
});
