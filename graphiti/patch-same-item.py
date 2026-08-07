import sys, ast
F = sys.argv[1]
src = open(F).read().split("\n")
anchor = "                    else await EpisodicNode.get_by_uuids(self.driver, previous_episode_uuids)"
hits = [i for i, l in enumerate(src) if l == anchor]
assert len(hits) == 1, f"expected 1 anchor, got {len(hits)}"
i = hits[0]
assert src[i + 1] == "                )", f"unexpected line after anchor: {src[i+1]!r}"
ins = (
    "                # PIPEFF-2: carry only the SAME ITEM's prior chunks. Episode names are\n"
    "                # `items:<id>` / `items:<id>#k`, so the pre-# prefix identifies the document.\n"
    "                # A single-chunk item gets ZERO predecessors; a multi-chunk item keeps all of\n"
    "                # its own. Unrelated predecessors were pure billed context.\n"
    "                #\n"
    "                # Guarded on the SAME condition as the retrieval above: when a caller passes\n"
    "                # previous_episode_uuids it chose those episodes deliberately, and filtering\n"
    "                # them would silently discard an explicit instruction. The REST server never\n"
    "                # passes them, so this branch is the only live one — but the guard costs\n"
    "                # nothing and keeps the patch honest against the library's own contract.\n"
    "                if previous_episode_uuids is None:\n"
    "                    _own = (name or '').split('#')[0]\n"
    "                    previous_episodes = [\n"
    "                        _ep\n"
    "                        for _ep in previous_episodes\n"
    "                        if (_ep.name or '').split('#')[0] == _own\n"
    "                    ]"
)
src.insert(i + 2, ins)
out = "\n".join(src)
ast.parse(out)
open(F, "w").write(out)
print("patched + parses")
