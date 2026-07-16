import { describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import { selectLlmBackend } from "@/lib/query/llm-backend";

// Spec (two-model config, real Postgres): a team's reasoning_model round-trips through
// resolveAnsweringKeys and drives selectLlmBackend's reasoning-role model — so arc synthesis uses it
// while the query role keeps the answering model.

describe("reasoning model config (data-mechanics)", () => {
  it("null by default; reasoning role falls back to the query model", async () => {
    const seed = await seedTeam();
    const keys = await resolveAnsweringKeys(db(), seed.teamId);
    expect(keys.reasoningModel).toBeNull();
    // With an OpenRouter key + model, reasoning role reuses the query model when none is set.
    const withOr = { ...keys, openrouterKey: "or", openrouterModel: "openai/gpt-4o-mini", activeProvider: "openrouter" as const };
    expect(selectLlmBackend({}, withOr, { role: "reasoning" }).model).toBe("openai/gpt-4o-mini");
  });

  it("a saved reasoning_model round-trips and drives the reasoning-role model", async () => {
    const seed = await seedTeam();
    await db().from("teams").update({ reasoning_model: "qwen/qwen3.7-plus" }).eq("id", seed.teamId);

    const keys = await resolveAnsweringKeys(db(), seed.teamId);
    expect(keys.reasoningModel).toBe("qwen/qwen3.7-plus");

    const withOr = { ...keys, openrouterKey: "or", openrouterModel: "openai/gpt-4o-mini", activeProvider: "openrouter" as const };
    expect(selectLlmBackend({}, withOr, { role: "query" }).model).toBe("openai/gpt-4o-mini"); // extraction
    expect(selectLlmBackend({}, withOr, { role: "reasoning" }).model).toBe("qwen/qwen3.7-plus"); // arcs
  });
});
