import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * PCCC-6 call-site guard (the pin-the-call-site class this repo's review lore names — module-level
 * dm tests prove the machinery; nothing else proves the surfaces actually CALL it). Each entry is a
 * load-bearing wiring whose deletion left every dm test green in review (Fable 6a Medium 9).
 */
const ROOT = join(import.meta.dirname, "..", "..");
const REQUIRED: { file: string; needle: string; why: string }[] = [
  {
    file: join("app", "api", "v1", "query", "route.ts"),
    needle: "graphProjectIds: projectIds",
    why: "the API query route must hand team members their partition set",
  },
  {
    file: join("app", "api", "dashboard", "query", "route.ts"),
    needle: "graphProjectIds: projectIds",
    why: "the dashboard chat is the members' primary surface — an unwired split here shipped once in review",
  },
  {
    file: join("lib", "query", "retrieve.ts"),
    needle: "selectEnforcedGraphPartitions(db, { teamId, visibleProjectIds: enforce.graphProjectIds })",
    why: "the enforced graph leg must resolve partitions, not recompute or omit",
  },
  {
    file: join("lib", "query", "retrieve.ts"),
    needle: "arm: false, k: Number.MAX_SAFE_INTEGER",
    why: "the permissive union is UNCAPPED and never arms — §2.2's coverage-equivalence co-land",
  },
  {
    file: join("lib", "query", "retrieve.ts"),
    needle: "graph expansion covered",
    why: "the covered/total disclosure (the spec's own-scope §5.7 exception) must reach the context",
  },
];

describe("PCCC-6 cutover call sites", () => {
  it("every load-bearing wiring exists", () => {
    for (const { file, needle, why } of REQUIRED) {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src.includes(needle), `${file}: missing "${needle}" — ${why}`).toBe(true);
    }
  });
});
