import { describe, expect, it } from "vitest";
import {
  upsertIntegration,
  setIntegrationSecret,
  setIntegrationStatus,
  getEnabledIntegrationsWithSecrets,
} from "@/lib/integrations/manage";
import { listIntegrations } from "@/lib/integrations/read";
import { db, seedTeam } from "./helpers";

// Spec (Option B): the connector secret is stored ENCRYPTED in `integrations.secret_ciphertext`,
// metadata reads never expose it, the sidecar read path decrypts it, and a config-only upsert
// must NOT wipe an existing secret. Verified to the observable outcome on real Postgres.

function auth(teamId: string, memberId: string) {
  return { teamId, memberId };
}

describe("integrations secret (real Postgres)", () => {
  it("encrypts the secret at rest; metadata never exposes it; sidecar read decrypts", async () => {
    const seed = await seedTeam();
    const a = auth(seed.teamId, seed.memberId);
    const token = "xoxb-REAL-slack-token-abc123";

    const { id } = await upsertIntegration(db(), a, {
      type: "slack", name: "eng-slack", config: { channelIds: ["C1", "C2"] },
    });
    await setIntegrationSecret(db(), a, id, token);

    // Raw row: ciphertext present and NOT the plaintext.
    const { data: raw } = await db()
      .from("integrations").select("secret_ciphertext").eq("id", id).maybeSingle();
    expect(raw!.secret_ciphertext).toBeTruthy();
    expect(raw!.secret_ciphertext).not.toContain(token);

    // Admin metadata list: hasSecret true, never the value.
    const list = await listIntegrations(db(), seed.teamId, { role: "admin" });
    expect(list[0].hasSecret).toBe(true);
    expect(JSON.stringify(list)).not.toContain(token);

    // Sidecar read path decrypts.
    const enabled = await getEnabledIntegrationsWithSecrets(db(), seed.teamId);
    expect(enabled[0].secret).toBe(token);
    expect(enabled[0].config).toEqual({ channelIds: ["C1", "C2"] });
  });

  it("a config-only upsert preserves the existing secret", async () => {
    const seed = await seedTeam();
    const a = auth(seed.teamId, seed.memberId);
    const { id } = await upsertIntegration(db(), a, { type: "slack", name: "s", config: { channelIds: ["C1"] } });
    await setIntegrationSecret(db(), a, id, "keep-me");

    // Re-upsert same (type,name) with new config, no secret touched.
    await upsertIntegration(db(), a, { type: "slack", name: "s", config: { channelIds: ["C1", "C9"] } });

    const enabled = await getEnabledIntegrationsWithSecrets(db(), seed.teamId);
    expect(enabled[0].secret).toBe("keep-me"); // not wiped by the config upsert
    expect(enabled[0].config).toEqual({ channelIds: ["C1", "C9"] });
  });

  it("disabled integrations are excluded from the sidecar read path", async () => {
    const seed = await seedTeam();
    const a = auth(seed.teamId, seed.memberId);
    const { id } = await upsertIntegration(db(), a, { type: "github", name: "g", config: { repos: ["o/r"] } });
    await setIntegrationSecret(db(), a, id, "ghp_x");
    await setIntegrationStatus(db(), a, id, "disabled");
    expect(await getEnabledIntegrationsWithSecrets(db(), seed.teamId)).toHaveLength(0);
  });
});
