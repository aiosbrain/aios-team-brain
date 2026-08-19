"""Make OpenAIGenericClient's json_schema response_format acceptable to STRICT providers.

`_build_response_format` sends `response_model.model_json_schema()` verbatim, with `"strict": true`
deliberately omitted (see its own comment). That bets on every OpenAI-compatible provider validating
a non-strict json_schema leniently. OpenAI and Azure do not always: routed through OpenRouter they
intermittently reject it with

    Invalid schema for response_format 'SummarizedEntities': In context=(),
    'additionalProperties' is required to be supplied and to be false.

"Intermittently" is the whole problem — OpenRouter picks a provider per request, so the same schema
succeeds on one call and 400s on the next, and the failure is not reproducible on demand.

The fix is to satisfy the strict validator's one structural demand up front: every object node in the
schema (including `$defs` and nested arrays' `items`) carries `additionalProperties: false`. This is a
NO-OP for lenient providers — they ignore it — so it cannot regress the working path; it only removes
the way the strict path fails.

What this deliberately does NOT do: it does not add every property to `required`, which full strict
mode also wants. That change alters extraction SEMANTICS (a genuinely optional field would have to be
emitted anyway, as a nullable), and it is not needed for the error actually observed. Widening it is a
separate, measured decision.

Invoked from the Dockerfile with the target file as argv[1]; asserts its anchors and exits non-zero
with the failing anchor named, so a library bump that moves them fails the BUILD rather than silently
shipping an unpatched image that looks patched.
"""

import ast
import sys

HELPER = '''

def _harden_schema_for_strict_providers(node):
    """Recursively set additionalProperties=False on every object node. See patch-strict-schema.py."""
    if isinstance(node, dict):
        # A DICT-valued additionalProperties is a real sub-schema (pydantic's Dict[str, X] emits
        # {'type': 'object', 'additionalProperties': {<X>}} with no 'properties'). Overwriting it
        # with False would change validation semantics for LENIENT providers too — breaking the
        # "cannot regress the working path" property this patch rests on — and would discard the
        # value schema before the recursion below ever visits it. Harden only where the slot is
        # free. No current graphiti prompt model uses such a field; this keeps a library bump from
        # shipping the regression silently, which the build asserts (one schema) would not catch.
        if (node.get('type') == 'object' or 'properties' in node) and not isinstance(
            node.get('additionalProperties'), dict
        ):
            node['additionalProperties'] = False
        for _v in node.values():
            _harden_schema_for_strict_providers(_v)
    elif isinstance(node, list):
        for _v in node:
            _harden_schema_for_strict_providers(_v)
    return node

'''

CALL_ANCHOR = "                'schema': response_model.model_json_schema(),\n"
CALL_REPLACEMENT = (
    "                # PATCH-STRICT: harden for strict providers (patch-strict-schema.py).\n"
    "                'schema': _harden_schema_for_strict_providers(response_model.model_json_schema()),\n"
)

# Insert the helper immediately before the class that uses it, so it is defined at import time
# regardless of where the class body sits.
CLASS_ANCHOR = "class OpenAIGenericClient(LLMClient):\n"


def main(path: str) -> None:
    with open(path, encoding="utf-8") as fh:
        src = fh.read()

    for anchor, label in ((CALL_ANCHOR, "schema call site"), (CLASS_ANCHOR, "class definition")):
        count = src.count(anchor)
        if count != 1:
            sys.exit(f"patch-strict-schema: expected exactly 1 {label} anchor, found {count}")

    if "_harden_schema_for_strict_providers" in src:
        sys.exit("patch-strict-schema: already applied")

    src = src.replace(CLASS_ANCHOR, HELPER.lstrip("\n") + "\n" + CLASS_ANCHOR, 1)
    src = src.replace(CALL_ANCHOR, CALL_REPLACEMENT, 1)

    ast.parse(src)  # never ship a syntactically broken file

    with open(path, "w", encoding="utf-8") as fh:
        fh.write(src)

    print("patch-strict-schema: applied")


if __name__ == "__main__":
    main(sys.argv[1])
