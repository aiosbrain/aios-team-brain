import { describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import { selectLlmBackend } from "@/lib/query/llm-backend";

/**
 * Spec (real Postgres): the extraction role persists, and the DB itself refuses the one provider that
 * would break the graph.
 *
 * This tier is the one that can prove the migration + CHECK constraint actually exist in a
 * migrated-from-zero database — a unit test over `selectLlmBackend` cannot: it would pass just as
 * happily if `extraction_model` were never added to `teams`, or if the CHECK admitted `anthropic`.
 */

describe("extraction model config (data-mechanics)", () => {
  it("is null by default, so extraction resolves the answering model exactly as before", async () => {
    const seed = await seedTeam();
    const keys = await resolveAnsweringKeys(db(), seed.teamId);
    expect(keys.extractionModel).toBeNull();
    expect(keys.extractionProvider).toBeNull();

    const withOr = { ...keys, openrouterKey: "or", openrouterModel: "qwen/qwen3.7-max", activeProvider: "openrouter" as const };
    expect(selectLlmBackend({}, withOr, { role: "extraction" }).model).toBe("qwen/qwen3.7-max");
  });

  it("a saved extraction model round-trips and drives ONLY the extraction role", async () => {
    const seed = await seedTeam();
    await db()
      .from("teams")
      .update({ extraction_model: "qwen/qwen3.6-flash", extraction_provider: "openrouter" })
      .eq("id", seed.teamId);

    const keys = await resolveAnsweringKeys(db(), seed.teamId);
    expect(keys.extractionModel).toBe("qwen/qwen3.6-flash");
    expect(keys.extractionProvider).toBe("openrouter");

    const withOr = { ...keys, openrouterKey: "or", openrouterModel: "qwen/qwen3.7-max", activeProvider: "openrouter" as const };
    expect(selectLlmBackend({}, withOr, { role: "query" }).model).toBe("qwen/qwen3.7-max"); // the Query box
    expect(selectLlmBackend({}, withOr, { role: "extraction" }).model).toBe("qwen/qwen3.6-flash"); // the graph
  });

  it("the DB REFUSES extraction_provider='anthropic' — the graph can't speak it", async () => {
    // Not merely a UI rule. Graphiti extracts via OpenAI structured outputs, which `graphChatTarget`
    // refuses for Anthropic — so this value would 501 every extraction call while Graphiti kept
    // returning 202 to the projector: a silently empty graph. Enforced by
    // `teams_extraction_provider_check`, which is what this asserts exists.
    const seed = await seedTeam();
    const { error } = await db()
      .from("teams")
      .update({ extraction_model: "claude-opus-4-8", extraction_provider: "anthropic" })
      .eq("id", seed.teamId);
    expect(error).toBeTruthy();
    expect(String(error?.message)).toMatch(/teams_extraction_provider_check|violates check constraint/i);

    // …and the row is unchanged, so a rejected save can't leave a half-written role behind.
    const keys = await resolveAnsweringKeys(db(), seed.teamId);
    expect(keys.extractionModel).toBeNull();
    expect(keys.extractionProvider).toBeNull();
  });

  it("accepts every provider the graph CAN speak", async () => {
    const seed = await seedTeam();
    for (const provider of ["openai", "openrouter", "local"] as const) {
      const { error } = await db()
        .from("teams")
        .update({ extraction_model: "m", extraction_provider: provider })
        .eq("id", seed.teamId);
      expect(error, `provider ${provider} should be allowed`).toBeFalsy();
      expect((await resolveAnsweringKeys(db(), seed.teamId)).extractionProvider).toBe(provider);
    }
  });
});
