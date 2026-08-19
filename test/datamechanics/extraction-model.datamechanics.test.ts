import { afterEach, describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import { selectLlmBackend } from "@/lib/query/llm-backend";
import { isRefusal, resolveGraphChatTarget } from "@/lib/llm/graph-proxy";

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

  /**
   * THE WIRING PIN. Everything above proves the columns persist and that `selectLlmBackend` honours
   * them — and every one of those tests stays green if `resolveGraphChatTarget` stops asking for the
   * extraction role, because they call the selector directly. That one argument IS the feature: without
   * it the admin's cheap-model pick applies to nothing, the graph silently goes back to billing the
   * answering model, and the only symptom is next month's invoice. "A cost setting that reverts unseen
   * is a surprise bill" is this change's own argument, so it needs a test that fails when it reverts.
   *
   * Driven through the `local` backend so no provider key has to be decrypted — the assertion is about
   * WHICH MODEL the graph leg resolves, which is backend-independent.
   */
  describe("the graph leg actually asks for the extraction role", () => {
    const prevBase = process.env.LLM_BASE_URL;
    const prevModel = process.env.LLM_MODEL;
    afterEach(() => {
      process.env.LLM_BASE_URL = prevBase;
      process.env.LLM_MODEL = prevModel;
    });

    async function graphModelFor(teamId: string): Promise<string> {
      process.env.LLM_BASE_URL = "http://local.test/v1";
      process.env.LLM_MODEL = "answering-model";
      const target = await resolveGraphChatTarget(db(), teamId);
      if (isRefusal(target)) throw new Error(`refused: ${target.code}`);
      return target.model;
    }

    it("sends the EXTRACTION model to Graphiti when one is set", async () => {
      const seed = await seedTeam();
      await db().from("teams").update({ answering_provider: "local" }).eq("id", seed.teamId);
      // Columns null: the graph runs the answering model — every install's behaviour today.
      expect(await graphModelFor(seed.teamId)).toBe("answering-model");

      await db().from("teams").update({ extraction_model: "cheap-extraction-model" }).eq("id", seed.teamId);
      // …and the moment an admin picks one, that is what the graph bills.
      expect(await graphModelFor(seed.teamId)).toBe("cheap-extraction-model");
    });
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

  it("atomically stamps every small-model value change and not unrelated updates", async () => {
    const seed = await seedTeam();
    const readBoundary = async () => {
      const { data, error } = await db()
        .from("teams")
        .select("extraction_small_model_set_at")
        .eq("id", seed.teamId)
        .single();
      expect(error).toBeFalsy();
      return data?.extraction_small_model_set_at as string | null;
    };

    expect(await readBoundary()).toBeNull();
    await db().from("teams").update({ extraction_small_model: "small-a" }).eq("id", seed.teamId);
    const first = await readBoundary();
    expect(first).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 5));
    await db().from("teams").update({ extraction_model: "strong-b" }).eq("id", seed.teamId);
    expect(await readBoundary()).toBe(first);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await db().from("teams").update({ extraction_small_model: "small-c" }).eq("id", seed.teamId);
    expect(await readBoundary()).not.toBe(first);
  });
});
