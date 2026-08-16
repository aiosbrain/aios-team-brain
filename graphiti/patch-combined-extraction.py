import sys, ast

F = sys.argv[1]
src = open(F).read().split("\n")

MARKER = "PIPEFF-5: one extraction call"
if any(MARKER in l for l in src):
    print("already patched (idempotent no-op)")
    sys.exit(0)


def one(pred, what):
    hits = [i for i, l in enumerate(src) if pred(l, i)]
    assert len(hits) == 1, f"expected 1 anchor for {what}, got {len(hits)}"
    return hits[0]


sig = one(
    lambda l, i: l == "        custom_extraction_instructions: str | None = None,"
    and i + 1 < len(src)
    and src[i + 1] == "    ) -> tuple[list[EntityEdge], list[EntityEdge], list[EntityEdge]]:",
    "_extract_and_resolve_edges signature",
)
src.insert(
    sig + 1,
    "        # PIPEFF-5: accept edges already extracted by the combined call. None keeps the\n"
    "        # separate-extraction behaviour byte-for-byte, so the unpatched path is untouched.\n"
    "        pre_extracted_edges: list[EntityEdge] | None = None,",
)

call = one(lambda l, i: l == "        extracted_edges = await extract_edges(", "extract_edges call")
close = next(i for i in range(call, len(src)) if src[i] == "        )")
body = src[call : close + 1]
src[call : close + 1] = (
    [
        "        # PIPEFF-5: one extraction call instead of two. When the caller has already",
        "        # extracted edges (the combined path), skip the second read of the same episode;",
        "        # everything below this block is unchanged, so resolution is identical either way.",
        "        if pre_extracted_edges is not None:",
        "            extracted_edges = pre_extracted_edges",
        "        else:",
    ]
    + ["    " + l for l in body]
)

ext = one(
    lambda l, i: l == "                extracted_nodes, node_episode_index_map = await extract_nodes(",
    "add_episode extract_nodes call",
)
close2 = next(i for i in range(ext, len(src)) if src[i] == "                )")
src[ext : close2 + 1] = [
    "                # PIPEFF-5: one extraction call instead of two. `extract_nodes_and_edges`",
    "                # reads the episode once and returns BOTH nodes and edges, so the separate",
    "                # `extract_edges` read below is skipped via `pre_extracted_edges`.",
    "                #",
    "                # Imported at the call site, not module scope: one anchor instead of two, and",
    "                # the import block is the part most likely to move on a library bump.",
    "                from graphiti_core.utils.maintenance.combined_extraction import (",
    "                    extract_nodes_and_edges as _combined_extract,",
    "                )",
    "",
    "                (",
    "                    extracted_nodes,",
    "                    _pipeff5_edges,",
    "                    node_episode_index_map,",
    "                ) = await _combined_extract(",
    "                    self.clients,",
    "                    episode,",
    "                    previous_episodes,",
    "                    entity_types,",
    "                    excluded_entity_types,",
    "                    edge_type_map or edge_type_map_default,",
    "                    edge_types,",
    "                    custom_extraction_instructions,",
    "                )",
]

thread = one(
    lambda l, i: l == "                    custom_extraction_instructions,"
    and i + 1 < len(src)
    and src[i + 1] == "                )"
    and any("_extract_and_resolve_edges(" in src[j] for j in range(max(0, i - 12), i)),
    "_extract_and_resolve_edges call site",
)
src.insert(thread + 1, "                    _pipeff5_edges,")

out = "\n".join(src)
ast.parse(out)
open(F, "w").write(out)
print("patched + parses")
