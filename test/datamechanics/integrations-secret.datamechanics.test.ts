import { describe, expect, it } from "vitest";
import {
  upsertIntegration,
  setIntegrationSecret,
  setIntegrationStatus,
  getEnabledIntegrationsWithSecrets,
  getProviderKey,
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

// Spec: LLM provider API keys round-trip through the same encrypted store; getProviderKey resolves
// the team's key for the query path and returns null (→ env fallback) when unset/disabled.
describe("provider keys (real Postgres)", () => {
  it("stores a provider key encrypted and resolves it by type", async () => {
    const seed = await seedTeam();
    const a = auth(seed.teamId, seed.memberId);
    const key = "sk-ant-REAL-anthropic-key-xyz";

    const { id } = await upsertIntegration(db(), a, { type: "anthropic", name: "anthropic", config: {} });
    await setIntegrationSecret(db(), a, id, key);

    expect(await getProviderKey(db(), seed.teamId, "anthropic")).toBe(key);
    // A provider with no integration row → null (caller falls back to the env key).
    expect(await getProviderKey(db(), seed.teamId, "openai")).toBeNull();
  });

  it("returns null for a disabled provider key (env fallback)", async () => {
    const seed = await seedTeam();
    const a = auth(seed.teamId, seed.memberId);
    const { id } = await upsertIntegration(db(), a, { type: "openai", name: "openai", config: {} });
    await setIntegrationSecret(db(), a, id, "sk-openai-x");
    await setIntegrationStatus(db(), a, id, "disabled");
    expect(await getProviderKey(db(), seed.teamId, "openai")).toBeNull();
  });
});
