"""One bad episode must not kill the whole ingestion queue.

`graph_service/routers/ingest.py`'s AsyncWorker catches only `asyncio.CancelledError`. Any other
exception from `job()` propagates out of `worker()`, the asyncio task ends, its exception is never
retrieved, and nothing is logged. `/messages` then keeps returning 202 forever while processing
nothing — the pipeline is dead and every observable surface says it is merely busy.

This wraps the loop body so a failing episode is logged with a traceback and the worker continues.
The `print` also moves AFTER `queue.get()`: printing before the await makes the log claim a job was
received while the worker is actually idle, which is precisely what makes a dead worker read as a
busy one.

Dropping the episode loses nothing permanently — the brain's reconcile pass notices it never landed
and re-pushes it.

Invoked from the Dockerfile with the target file as argv[1]; asserts its anchor and exits non-zero if
it is not found exactly once, so a base-image bump fails the BUILD rather than silently shipping an
unpatched image.
"""

import ast
import sys

OLD = """            try:
                print(f'Got a job: (size of remaining queue: {self.queue.qsize()})')
                job = await self.queue.get()
                await job()
            except asyncio.CancelledError:
                break
"""

NEW = """            try:
                job = await self.queue.get()
                print(f'Got a job: (size of remaining queue: {self.queue.qsize()})')
                await job()
            except asyncio.CancelledError:
                break
            except Exception:
                # PATCH-RESILIENT-WORKER: one bad episode must not kill the queue. See Dockerfile.
                import traceback

                print('Episode job FAILED; worker continuing:')
                traceback.print_exc()
"""


def main(path: str) -> None:
    with open(path, encoding="utf-8") as fh:
        src = fh.read()

    if "PATCH-RESILIENT-WORKER" in src:
        sys.exit("patch-resilient-worker: already applied")

    count = src.count(OLD)
    if count != 1:
        sys.exit(f"patch-resilient-worker: expected exactly 1 worker-loop anchor, found {count}")

    src = src.replace(OLD, NEW, 1)
    ast.parse(src)  # never ship a syntactically broken file

    with open(path, "w", encoding="utf-8") as fh:
        fh.write(src)

    print("patch-resilient-worker: applied")


if __name__ == "__main__":
    main(sys.argv[1])
