"""Prove the SHIPPED small-model expression behaves, not merely that the text is present.

PATCH 1 decides what `small_model` graphiti sends, and that decision is now three-way: an explicit
real `GRAPHITI_SMALL_MODEL` wins; otherwise the canonical brain-proxy route in `OPENAI_BASE_URL`
selects the sentinel `aios-small`; otherwise the historical real-model default. An explicit
sentinel is ignored outside that proxy route. Getting that wrong is not loud — the
wrong branch means every cheap call is either mislabelled (no sentinel where one was due) or 400s
against a provider (a sentinel where none was due), and neither shows up at build time.

A `grep -q` proves a string is in the file. It cannot prove the branch selects correctly, and the
whole reason these patches carry asserts is that an unanchored vendored edit becomes a silent no-op
on the next base-image bump. So this EXTRACTS the expression from the patched file and evaluates
it — the bytes that ship are the bytes under test.

Invoked from the Dockerfile with the target file as argv[1]; exits non-zero with the failing case
named, so a base-image bump or a bad edit fails the BUILD.
"""

import ast
import re
import sys
from urllib.parse import urlsplit

ANCHOR = 'small_model='


def extract(path: str) -> str:
    """The `small_model=` argument's expression, by balanced parentheses from the anchor.

    Not string-literal aware: a future expression carrying a `,` or `)` inside a string at depth 0
    would truncate here. That fails CLOSED — the truncated expression either does not parse or
    misses a case, and the build stops with the case named — so it is safe, but read a failure as
    "the scanner needs widening" before concluding the branch logic is wrong.
    """
    with open(path, encoding="utf-8") as source:
        src = source.read()
    hits = [m.start() for m in re.finditer(re.escape(ANCHOR), src)]
    if len(hits) != 1:
        sys.exit(f"verify-small-model-default: expected exactly 1 `{ANCHOR}` anchor, found {len(hits)}")
    i = hits[0] + len(ANCHOR)
    depth, out = 0, []
    while i < len(src):
        c = src[i]
        if c in "([{":
            depth += 1
        elif c in ")]}":
            if depth == 0:
                break  # the closing paren of the enclosing call
            depth -= 1
        elif c == "," and depth == 0:
            break
        out.append(c)
        i += 1
    expr = "".join(out).strip()
    if not expr:
        sys.exit("verify-small-model-default: extracted an empty expression")
    return expr


CASES = [
    # (GRAPHITI_SMALL_MODEL, OPENAI_BASE_URL, expected, why)
    ("qwen/qwen3.7-flash", "https://brain/api/internal/llm/v1", "qwen/qwen3.7-flash",
     "an explicit real model wins over everything — the escape hatch"),
    ("", "https://brain.example.com/api/internal/llm/v1", "aios-small",
     "the brain's proxy is in the path, so the sentinel is safe and drift-free"),
    ("", "https://brain.example.com/api/internal/llm/v1/", "aios-small",
     "a trailing slash does not hide the canonical brain proxy path"),
    ("", "https://openrouter.ai/api/v1", "gpt-4.1-nano",
     "talking to a provider DIRECTLY: a sentinel would 400, so the real-model default is preserved"),
    ("", "https://provider.example/api/internal/llm-lookalike/v1", "gpt-4.1-nano",
     "a lookalike provider path must not be mistaken for the canonical brain proxy route"),
    ("", "https://provider.example/v1?next=/api/internal/llm/v1", "gpt-4.1-nano",
     "a query-string suffix must not masquerade as the proxy pathname"),
    ("", "https://provider.example/v1#/api/internal/llm/v1", "gpt-4.1-nano",
     "a fragment suffix must not masquerade as the proxy pathname"),
    ("aios-small", "https://openrouter.ai/api/v1", "gpt-4.1-nano",
     "an explicit sentinel is invalid without the proxy and must never reach a provider"),
    ("aios-small", "https://brain.example.com/api/internal/llm/v1", "aios-small",
     "an explicit sentinel remains valid when the canonical proxy path is selected"),
    ("", "", "gpt-4.1-nano",
     "unset base url is the direct case too — never assume a proxy"),
]


def evaluate_compare(node: ast.Compare, env: dict[str, str]) -> object:
    if len(node.ops) != 1 or len(node.comparators) != 1:
        raise ValueError("only one comparison is allowed")
    left = evaluate(node.left, env)
    right = evaluate(node.comparators[0], env)
    if isinstance(node.ops[0], ast.In):
        return left in right
    if isinstance(node.ops[0], ast.NotIn):
        return left not in right
    if isinstance(node.ops[0], ast.Eq):
        return left == right
    raise ValueError("unsupported comparison")


def environment_key(node: ast.Call, env: dict[str, str]) -> object:
    owner = node.func.value
    is_environment_get = (
        node.func.attr == "get"
        and isinstance(owner, ast.Attribute)
        and owner.attr == "environ"
        and isinstance(owner.value, ast.Name)
        and owner.value.id == "os"
        and len(node.args) == 1
    )
    if not is_environment_get:
        return None
    key = evaluate(node.args[0], env)
    return env.get(key) if isinstance(key, str) else None


def evaluate_named_call(node: ast.Call, env: dict[str, str]) -> object:
    if not isinstance(node.func, ast.Name) or node.func.id != "urlsplit" or len(node.args) != 1:
        raise ValueError("unsupported named call")
    value = evaluate(node.args[0], env)
    if not isinstance(value, str):
        raise ValueError("urlsplit string expected")
    return urlsplit(value)


def evaluate_attribute_call(node: ast.Call, env: dict[str, str]) -> object:
    if not isinstance(node.func, ast.Attribute):
        raise ValueError("attribute call expected")
    if node.func.attr == "get":
        return environment_key(node, env)
    receiver = evaluate(node.func.value, env)
    args = [evaluate(arg, env) for arg in node.args]
    if not isinstance(receiver, str) or not all(isinstance(arg, str) for arg in args):
        raise ValueError("string call expected")
    if node.func.attr == "rstrip" and len(args) == 1:
        return receiver.rstrip(args[0])
    if node.func.attr == "endswith" and len(args) == 1:
        return receiver.endswith(args[0])
    raise ValueError("unsupported string call")


def evaluate_call(node: ast.Call, env: dict[str, str]) -> object:
    if node.keywords:
        raise ValueError("unsupported call")
    if isinstance(node.func, ast.Name):
        return evaluate_named_call(node, env)
    return evaluate_attribute_call(node, env)


def evaluate_or(node: ast.BoolOp, env: dict[str, str]) -> object:
    value = None
    for child in node.values:
        value = evaluate(child, env)
        if value:
            break
    return value


def evaluate(node: ast.AST, env: dict[str, str]) -> object:
    """Interpret only the tiny expression language the Docker patch is allowed to ship."""
    if isinstance(node, ast.Expression):
        return evaluate(node.body, env)
    if isinstance(node, ast.Constant) and isinstance(node.value, (str, type(None))):
        return node.value
    if isinstance(node, ast.Tuple):
        return tuple(evaluate(item, env) for item in node.elts)
    if isinstance(node, ast.Attribute) and node.attr == "path":
        return evaluate(node.value, env).path
    if isinstance(node, ast.BoolOp) and isinstance(node.op, ast.Or):
        return evaluate_or(node, env)
    if isinstance(node, ast.IfExp):
        return evaluate(node.body if evaluate(node.test, env) else node.orelse, env)
    if isinstance(node, ast.Compare):
        return evaluate_compare(node, env)
    if isinstance(node, ast.Call):
        return evaluate_call(node, env)
    raise ValueError(f"unsupported expression node: {ast.dump(node, include_attributes=False)}")


def main(path: str) -> None:
    expr = extract(path)
    tree = ast.parse(expr, mode="eval")
    for small, base, expected, why in CASES:
        env: dict[str, str] = {}
        if small:
            env["GRAPHITI_SMALL_MODEL"] = small
        if base:
            env["OPENAI_BASE_URL"] = base
        got = evaluate(tree, env)
        if got != expected:
            sys.exit(
                f"verify-small-model-default: FAILED — {why}\n"
                f"  GRAPHITI_SMALL_MODEL={small!r} OPENAI_BASE_URL={base!r}\n"
                f"  expected {expected!r}, got {got!r}\n"
                f"  expression: {expr}"
            )
    print(f"verify-small-model-default: {len(CASES)} cases pass on the shipped expression")


if __name__ == "__main__":
    main(sys.argv[1])
