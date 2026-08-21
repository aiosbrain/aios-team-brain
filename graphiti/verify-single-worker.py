"""Prove the SHIPPED ingest router is ONE queue: one AsyncWorker singleton, one worker task, one
unbounded asyncio.Queue, one queued job per message.

GRAPHSAT-2's landed-watermark rule in the brain (lib/graph/reconcile.ts) rests on this shape: with
one serial FIFO consumer that drops failing jobs and never re-queues, an episode accepted BEFORE one
that has since landed is landed or gone — never still queued — so the brain may re-push it without
duplicating queued work. A base-image bump that adds a second worker, a second queue, a bounded
queue, or batches a request into one job would silently break that proof. So the build asserts it
against the bytes that ship, the way verify-small-model-default.py does for PATCH 1.

Invoked from the Dockerfile with the target file as argv[1] (after the resilient-worker patch has
been applied — the patched shape is the shipped shape); exits non-zero with the failing case named.
Also run by the brain's unit guard against a committed fixture copy of upstream's file and against
mutated copies, so the verifier itself is proven to discriminate.
"""

import ast
import sys


def fail(msg: str) -> None:
    print(f"verify-single-worker: {msg}", file=sys.stderr)
    sys.exit(1)


def check(path: str) -> None:
    tree = ast.parse(open(path, encoding="utf-8").read(), filename=path)

    worker_classes = [n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == "AsyncWorker"]
    if len(worker_classes) != 1:
        fail(f"expected exactly one AsyncWorker class, found {len(worker_classes)}")

    # Module-level singleton: exactly one `<name> = AsyncWorker()` at module scope.
    singletons = [
        n for n in tree.body
        if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call)
        and isinstance(n.value.func, ast.Name) and n.value.func.id == "AsyncWorker"
    ]
    instantiations = [
        n for n in ast.walk(tree)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "AsyncWorker"
    ]
    if len(singletons) != 1 or len(instantiations) != 1:
        fail(f"expected exactly one module-level AsyncWorker() singleton, found {len(singletons)} module-level / {len(instantiations)} total instantiations")

    # Exactly one asyncio.Queue(), unbounded (no maxsize argument).
    queues = [
        n for n in ast.walk(tree)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "Queue"
        and isinstance(n.func.value, ast.Name) and n.func.value.id == "asyncio"
    ]
    if len(queues) != 1:
        fail(f"expected exactly one asyncio.Queue(), found {len(queues)}")
    if queues[0].args or queues[0].keywords:
        fail("the queue must be unbounded (asyncio.Queue() with no maxsize) — a bounded queue blocks the accept path and breaks accept-order = projected_at order")

    # Exactly one asyncio.create_task(...) in the whole file (the single worker task).
    tasks = [
        n for n in ast.walk(tree)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "create_task"
    ]
    if len(tasks) != 1:
        fail(f"expected exactly one asyncio.create_task (one worker task), found {len(tasks)}")

    # The /messages handler enqueues ONE job PER MESSAGE: a `queue.put(` inside a `for ... in
    # request.messages` loop, and no `queue.put(` outside such a loop.
    puts = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "put"]
    if len(puts) != 1:
        fail(f"expected exactly one queue.put call site, found {len(puts)}")
    in_loop = False
    for node in ast.walk(tree):
        if isinstance(node, (ast.For, ast.AsyncFor)):
            it = node.iter
            iter_ok = isinstance(it, ast.Attribute) and it.attr == "messages"
            if iter_ok and any(n is puts[0] for n in ast.walk(node)):
                in_loop = True
    if not in_loop:
        fail("queue.put must be inside `for m in request.messages` — one queued job per message, not one per request")

    print("verify-single-worker: one AsyncWorker singleton, one task, one unbounded queue, one job per message")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        fail("usage: verify-single-worker.py <path to graph_service/routers/ingest.py>")
    check(sys.argv[1])
