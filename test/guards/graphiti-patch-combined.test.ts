import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * GUARD: the combined-extraction patch (PIPEFF-5 / AIO-868) — the script, and the SEMANTICS of the
 * code it inserts.
 *
 * Built the same way as `graphiti-patch-same-item.test.ts`, and for the same reason: the behaviour
 * under test is Python running inside a vendored library in another container, so a TypeScript
 * paraphrase of it could silently diverge from the shipped file. This suite does not paraphrase — it
 * RUNS the committed script (the same invocation `graphiti/Dockerfile` makes) against a synthetic
 * host that reproduces `graphiti.py`'s anchor context at the same indentation, then EXECUTES the
 * patched result in python3 and asserts on real output.
 *
 * WHAT IS DELIBERATELY NOT PINNED HERE. Unlike PATCH 3, this script carries a header-free sha claim
 * nowhere: PATCH 3's sha exists because its spec's one provable claim was "the shipped script is the
 * script the measured arm ran". PIPEFF-5's battery has not run yet, so there is no measured artifact
 * to checksum against. AC1 (build-time byte-identity against the measured file) is a Dockerfile gate
 * that becomes meaningful only once the battery has run — claiming it here would be an attestation
 * for a measurement that does not exist.
 *
 * python3 is a HARD requirement, not a skip. A suite that quietly skips itself on a machine without
 * python3 is a guard that disarms without saying so.
 */

const REPO = process.cwd();
const SCRIPT = join(REPO, "graphiti/patch-combined-extraction.py");

/**
 * A synthetic `graphiti.py`. It reproduces the three anchors at their real indentation and is
 * EXECUTABLE, so the patched result can be run rather than read. The stubs record which extraction
 * calls happened, which is exactly what AC5/AC6 need to assert.
 */
const HOST = `import asyncio

CALLS = []


class EntityEdge:
    """Stub. The real graphiti.py has this in scope (it already annotates this very function's
    return type with it), and the patch's parameter annotation is EVALUATED at import — so a host
    without it would fail to import, which is itself the check that the name must be in scope."""


async def extract_edges(clients, episode, extracted_nodes, previous_episodes, edge_type_map, group_id, edge_types, custom_extraction_instructions):
    CALLS.append("extract_edges")
    return ["edge_from_separate_call"]


async def extract_nodes(clients, episode, previous_episodes, entity_types, excluded_entity_types, custom_extraction_instructions):
    CALLS.append("extract_nodes")
    return (["node_from_separate_call"], {"m": [0]})


def resolve_edge_pointers(edges, uuid_map):
    return edges


async def resolve_extracted_edges(clients, edges, primary_episode, nodes, edge_types, edge_type_map):
    return (edges, [], [])


class Graphiti:
    def __init__(self):
        self.clients = None

    async def _extract_and_resolve_edges(
        self,
        episode,
        extracted_nodes,
        previous_episodes,
        edge_type_map,
        group_id,
        edge_types,
        nodes,
        uuid_map,
        custom_extraction_instructions: str | None = None,
    ) -> tuple[list[EntityEdge], list[EntityEdge], list[EntityEdge]]:
        """Extract edges from episode(s) and resolve against existing graph."""
        episodes = episode if isinstance(episode, list) else [episode]
        primary_episode = episodes[0]

        extracted_edges = await extract_edges(
            self.clients,
            episode,
            extracted_nodes,
            previous_episodes,
            edge_type_map,
            group_id,
            edge_types,
            custom_extraction_instructions,
        )

        edges = resolve_edge_pointers(extracted_edges, uuid_map)

        resolved_edges, invalidated_edges, new_edges = await resolve_extracted_edges(
            self.clients,
            edges,
            primary_episode,
            nodes,
            edge_types or {},
            edge_type_map,
        )

        return resolved_edges, invalidated_edges, new_edges

    async def add_episode(self, episode, previous_episodes, entity_types=None, excluded_entity_types=None, edge_type_map=None, edge_types=None, custom_extraction_instructions=None, group_id="g"):
                edge_type_map_default = (
                    {('Entity', 'Entity'): list(edge_types.keys())}
                    if edge_types is not None
                    else {('Entity', 'Entity'): []}
                )

                # Extract and resolve nodes
                extracted_nodes, node_episode_index_map = await extract_nodes(
                    self.clients,
                    episode,
                    previous_episodes,
                    entity_types,
                    excluded_entity_types,
                    custom_extraction_instructions,
                )

                nodes, uuid_map = extracted_nodes, {}

                (
                    resolved_edges,
                    invalidated_edges,
                    new_edges,
                ) = await self._extract_and_resolve_edges(
                    episode,
                    extracted_nodes,
                    previous_episodes,
                    edge_type_map or edge_type_map_default,
                    group_id,
                    edge_types,
                    nodes,
                    uuid_map,
                    custom_extraction_instructions,
                )

                return extracted_nodes, resolved_edges, node_episode_index_map
`;

/** The combined extractor the patch imports. Injected as a real module so the import resolves. */
const COMBINED_MODULE = `PREV_SEEN = []
ARGS_SEEN = []


async def extract_nodes_and_edges(clients, episode, previous_episodes, entity_types=None, excluded_entity_types=None, edge_type_map=None, edge_types=None, custom_extraction_instructions=None):
    import graphiti
    graphiti.CALLS.append("extract_nodes_and_edges")
    PREV_SEEN.append(list(previous_episodes))
    # Echo EVERY positional back, so a swapped pair is visible rather than silently accepted.
    ARGS_SEEN.append({
        "episode": episode,
        "previous_episodes": list(previous_episodes),
        "entity_types": entity_types,
        "excluded_entity_types": excluded_entity_types,
        "edge_type_map": edge_type_map,
        "edge_types": edge_types,
        "custom_extraction_instructions": custom_extraction_instructions,
    })
    return (["node_from_combined"], ["edge_from_combined"], {"m": [0]})
`;

interface Applied {
  dir: string;
  hostPath: string;
  patched: string;
  stdout: string;
}

function applyPatch(host = HOST): Applied {
  const dir = mkdtempSync(join(tmpdir(), "pipeff5-"));
  const hostPath = join(dir, "graphiti.py");
  writeFileSync(hostPath, host);
  const r = spawnSync("python3", [SCRIPT, hostPath], { encoding: "utf8" });
  if (r.status !== 0) {
    const msg = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`patch failed: ${msg}`);
  }
  return { dir, hostPath, patched: readFileSync(hostPath, "utf8"), stdout: r.stdout ?? "" };
}

/** Run the patched host with a driver, returning parsed JSON from its stdout. */
function runPatched(a: Applied, driver: string): Record<string, unknown> {
  const pkgDir = join(a.dir, "graphiti_core", "utils", "maintenance");
  spawnSync("mkdir", ["-p", pkgDir]);
  for (const p of ["graphiti_core", "graphiti_core/utils", "graphiti_core/utils/maintenance"]) {
    writeFileSync(join(a.dir, p, "__init__.py"), "");
  }
  writeFileSync(join(pkgDir, "combined_extraction.py"), COMBINED_MODULE);
  const driverPath = join(a.dir, "driver.py");
  writeFileSync(driverPath, driver);
  const r = spawnSync("python3", [driverPath], { encoding: "utf8", cwd: a.dir });
  expect(r.stderr, `python stderr:\n${r.stderr}`).not.toMatch(/Traceback/);
  return JSON.parse(r.stdout.trim().split("\n").pop() as string);
}

describe("PIPEFF-5 patch script — mechanics", () => {
  it("AC2: applying twice is a no-op — the second run detects the marker and exits clean", () => {
    const a = applyPatch();
    try {
      expect(a.stdout).toContain("patched + parses");
      const second = spawnSync("python3", [SCRIPT, a.hostPath], { encoding: "utf8" });
      expect(second.status).toBe(0);
      expect(second.stdout).toContain("already patched");
      // and it did not patch a second time
      expect(readFileSync(a.hostPath, "utf8")).toBe(a.patched);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  });

  it("AC2: a MISSING anchor fails loudly rather than silently skipping", () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeff5-bad-"));
    try {
      const p = join(dir, "graphiti.py");
      // A host with the signature anchor removed — the silent-no-op hazard a vendored patch has.
      writeFileSync(p, HOST.replace("        custom_extraction_instructions: str | None = None,\n", ""));
      const r = spawnSync("python3", [SCRIPT, p], { encoding: "utf8" });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/expected 1 anchor/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AC3: the patched file parses under `ast`", () => {
    const a = applyPatch();
    try {
      const r = spawnSync(
        "python3",
        ["-c", `import ast,sys; ast.parse(open(sys.argv[1]).read()); print("ok")`, a.hostPath],
        { encoding: "utf8" }
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("ok");
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  });
});

describe("PIPEFF-5 patch script — semantics, by executing the patched code", () => {
  const DRIVER = `import asyncio, json, sys
sys.path.insert(0, ".")
import graphiti as g

async def main():
    inst = g.Graphiti()
    g.CALLS.clear()
    nodes, edges, _ = await inst.add_episode("ep", ["prev1", "prev2"])
    from graphiti_core.utils.maintenance import combined_extraction as ce
    print(json.dumps({"calls": g.CALLS, "nodes": nodes, "edges": edges, "prev_seen": ce.PREV_SEEN}))

asyncio.run(main())
`;

  it("AC5: the combined call replaces BOTH reads — extract_nodes and extract_edges are not called", () => {
    const a = applyPatch();
    try {
      const out = runPatched(a, DRIVER) as { calls: string[]; nodes: string[]; edges: string[] };
      expect(out.calls).toEqual(["extract_nodes_and_edges"]);
      expect(out.calls).not.toContain("extract_nodes");
      expect(out.calls).not.toContain("extract_edges");
      // and the combined call's OUTPUT is what flows downstream, not a stale separate-call value
      expect(out.nodes).toEqual(["node_from_combined"]);
      expect(out.edges).toEqual(["edge_from_combined"]);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  });

  it("AC5: every positional lands on the parameter it is meant for — a swap must not pass", () => {
    // The gap the SECOND (cold) review found: the stub recorded only `previous_episodes`, so a
    // revision swapping entity_types/excluded_entity_types, or passing edge_types where
    // edge_type_map belongs, would pass all seven guard tests, `ast.parse` and every Dockerfile
    // gate — and in prod silently mis-key entity classification and exclusion. Distinct sentinels
    // per position are what make that visible.
    const a = applyPatch();
    try {
      const driver = `import asyncio, json, sys
sys.path.insert(0, ".")
import graphiti as g

async def main():
    inst = g.Graphiti()
    g.CALLS.clear()
    await inst.add_episode(
        "EP", ["PREV"],
        entity_types="ENTITY_TYPES",
        excluded_entity_types="EXCLUDED",
        edge_type_map="EDGE_TYPE_MAP",
        edge_types={"EDGE_TYPES": 1},
        custom_extraction_instructions="CUSTOM",
    )
    from graphiti_core.utils.maintenance import combined_extraction as ce
    print(json.dumps(ce.ARGS_SEEN))

asyncio.run(main())
`;
      const seen = runPatched(a, driver) as unknown as Array<Record<string, unknown>>;
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({
        episode: "EP",
        previous_episodes: ["PREV"],
        entity_types: "ENTITY_TYPES",
        excluded_entity_types: "EXCLUDED",
        edge_type_map: "EDGE_TYPE_MAP",
        edge_types: { EDGE_TYPES: 1 },
        custom_extraction_instructions: "CUSTOM",
      });
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  });

  it("AC4: `previous_episodes` reaches the combined call unchanged — PATCH 3's filter stays upstream", () => {
    const a = applyPatch();
    try {
      const out = runPatched(a, DRIVER) as { prev_seen: string[][] };
      // What THIS test pins is pass-through: the patch still hands `previous_episodes` to the
      // combined call rather than rebuilding, reordering or dropping it.
      //
      // It does NOT pin that PATCH 3's filter runs first — nothing below in this file does, and an
      // earlier version of this comment said "asserted structurally below", pointing at an assertion
      // that does not exist. The ordering property holds COMPOSITIONALLY: the filter's semantics are
      // pinned by `graphiti-patch-same-item.test.ts`, its position upstream of this call site is
      // enforced by the Dockerfile applying PATCH 3 before PATCH 4 against the same file, and this
      // test pins that the list survives the hand-off. No single test composes all three.
      expect(out.prev_seen).toEqual([["prev1", "prev2"]]);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  });

  it("AC6: with `pre_extracted_edges=None` the separate path is byte-for-byte unchanged", () => {
    const a = applyPatch();
    try {
      const driver = `import asyncio, json, sys
sys.path.insert(0, ".")
import graphiti as g

async def main():
    inst = g.Graphiti()
    g.CALLS.clear()
    # Call the edge helper DIRECTLY with the default (None) — the unpatched path.
    resolved, inval, new = await inst._extract_and_resolve_edges(
        "ep", ["n"], ["prev"], {}, "grp", None, ["n"], {}, None
    )
    print(json.dumps({"calls": g.CALLS, "resolved": resolved}))

asyncio.run(main())
`;
      const out = runPatched(a, driver) as { calls: string[]; resolved: string[] };
      expect(out.calls).toEqual(["extract_edges"]);
      expect(out.resolved).toEqual(["edge_from_separate_call"]);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  });

  it("AC6: an explicitly passed edge list is used INSTEAD of a second read", () => {
    const a = applyPatch();
    try {
      const driver = `import asyncio, json, sys
sys.path.insert(0, ".")
import graphiti as g

async def main():
    inst = g.Graphiti()
    g.CALLS.clear()
    resolved, inval, new = await inst._extract_and_resolve_edges(
        "ep", ["n"], ["prev"], {}, "grp", None, ["n"], {}, None, ["injected"]
    )
    print(json.dumps({"calls": g.CALLS, "resolved": resolved}))

asyncio.run(main())
`;
      const out = runPatched(a, driver) as { calls: string[]; resolved: string[] };
      expect(out.calls).toEqual([]);
      expect(out.resolved).toEqual(["injected"]);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  });
});
