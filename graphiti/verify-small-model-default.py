"""Prove the SHIPPED small-model expression behaves, not merely that the text is present.

PATCH 1 decides what `small_model` graphiti sends, and that decision is now three-way: an explicit
`GRAPHITI_SMALL_MODEL` wins; otherwise the brain's proxy in `OPENAI_BASE_URL` selects the sentinel
`aios-small`; otherwise the historical real-model default. Getting that wrong is not loud — the
wrong branch means every cheap call is either mislabelled (no sentinel where one was due) or 400s
against a provider (a sentinel where none was due), and neither shows up at build time.

A `grep -q` proves a string is in the file. It cannot prove the branch selects correctly, and the
whole reason these patches carry asserts is that an unanchored vendored edit becomes a silent no-op
on the next base-image bump. So this EXTRACTS the expression from the patched file and evaluates
it — the bytes that ship are the bytes under test.

Invoked from the Dockerfile with the target file as argv[1]; exits non-zero with the failing case
named, so a base-image bump or a bad edit fails the BUILD.
"""

import os
import re
import sys

ANCHOR = 'small_model='


def extract(path: str) -> str:
    """The `small_model=` argument's expression, by balanced parentheses from the anchor.

    Not string-literal aware: a future expression carrying a `,` or `)` inside a string at depth 0
    would truncate here. That fails CLOSED — the truncated expression either does not parse or
    misses a case, and the build stops with the case named — so it is safe, but read a failure as
    "the scanner needs widening" before concluding the branch logic is wrong.
    """
    src = open(path, encoding="utf-8").read()
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
     "an explicit setting wins over everything — the escape hatch"),
    ("", "https://brain.example.com/api/internal/llm/v1", "aios-small",
     "the brain's proxy is in the path, so the sentinel is safe and drift-free"),
    ("", "https://openrouter.ai/api/v1", "gpt-4.1-nano",
     "talking to a provider DIRECTLY: a sentinel would 400, so the real-model default is preserved"),
    ("", "", "gpt-4.1-nano",
     "unset base url is the direct case too — never assume a proxy"),
]


def main(path: str) -> None:
    expr = extract(path)
    for small, base, expected, why in CASES:
        env = dict(os.environ)
        env.pop("GRAPHITI_SMALL_MODEL", None)
        env.pop("OPENAI_BASE_URL", None)
        if small:
            env["GRAPHITI_SMALL_MODEL"] = small
        if base:
            env["OPENAI_BASE_URL"] = base
        got = eval(expr, {"os": type("os", (), {"environ": env})})  # noqa: S307 — our own extracted expr
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
