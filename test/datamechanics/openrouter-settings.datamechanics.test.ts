import { describe, expect, it } from "vitest";
import {
  upsertIntegration,
  setIntegrationSecret,
  setIntegrationStatus,
  getOpenrouterSettings,
} from "@/lib/integrations/manage";
import { saveOpenrouterSettings } from "@/lib/integrations/openrouter";
import { db, seedTeam } from "./helpers";

/**
 * Spec (real Postgres): the query LLM resolves a team's OpenRouter backend from the integrations
 * store — the decrypted key PLUS the chosen model slug (`config.model`) in one read. A disabled or
 * absent openrouter integration yields nulls so selection falls through to the next backend.
 */

describe("getOpenrouterSettings (real Postgres)", () => {
  it("returns the decrypted key + model when enabled", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId };
    const { id } = await upsertIntegration(db(), auth, {
      type: "openrouter",
      name: "openrouter",
      config: { model: "anthropic/claude-sonnet-4" },
      status: "enabled",
    });
    await setIntegrationSecret(db(), auth, id, "sk-or-v1-secret");

    expect(await getOpenrouterSettings(db(), seed.teamId)).toEqual({
      key: "sk-or-v1-secret",
      model: "anthropic/claude-sonnet-4",
    });
  });

  it("returns nulls when the integration is disabled (falls through to the next backend)", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId };
    const { id } = await upsertIntegration(db(), auth, {
      type: "openrouter",
      name: "openrouter",
      config: { model: "openai/gpt-4o-mini" },
      status: "enabled",
    });
    await setIntegrationSecret(db(), auth, id, "sk-or-v1-secret");
    await setIntegrationStatus(db(), auth, id, "disabled");

    expect(await getOpenrouterSettings(db(), seed.teamId)).toEqual({ key: null, model: null });
  });

  it("returns nulls when no openrouter integration exists", async () => {
    const seed = await seedTeam();
    expect(await getOpenrouterSettings(db(), seed.teamId)).toEqual({ key: null, model: null });
  });

  it("saveOpenrouterSettings merges: a key-only save preserves the model, a model-only save preserves the key", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId };

    // First save: model + key together (creates the row).
    await saveOpenrouterSettings(db(), auth, { key: "sk-or-1", model: "openai/gpt-4o-mini" });
    expect(await getOpenrouterSettings(db(), seed.teamId)).toEqual({ key: "sk-or-1", model: "openai/gpt-4o-mini" });

    // Model-only save: key preserved.
    await saveOpenrouterSettings(db(), auth, { model: "anthropic/claude-sonnet-4" });
    expect(await getOpenrouterSettings(db(), seed.teamId)).toEqual({
      key: "sk-or-1",
      model: "anthropic/claude-sonnet-4",
    });

    // Key-only save: model preserved.
    await saveOpenrouterSettings(db(), auth, { key: "sk-or-2" });
    expect(await getOpenrouterSettings(db(), seed.teamId)).toEqual({
      key: "sk-or-2",
      model: "anthropic/claude-sonnet-4",
    });
  });
});
