import { describe, it, expect, vi, afterEach } from "vitest";
import { pollRun } from "@/components/query-chat";

// Spec: docs/design/query-background-stream.md — R2 (visible on return). These pin the two reattach
// defects review found: a run that settles in the gap before the first poll must still be reported as
// having an answer, and a DIFFERENT run taking over must not have its text adopted by this poll.

type RunBody = {
  id?: string;
  status?: string;
  partial?: string;
  error?: string | null;
  final_message_id?: string | null;
};

/** Serves the given run states in order; the last one repeats. */
function serveRuns(states: (RunBody | null)[]) {
  let i = 0;
  return vi.fn(async () => {
    const run = states[Math.min(i, states.length - 1)];
    i += 1;
    return { ok: true, json: async () => ({ run }) } as unknown as Response;
  });
}

const noSleep = async () => {};

afterEach(() => vi.unstubAllGlobals());

describe("pollRun — reattach to an in-flight turn", () => {
  it("streams partials until the run settles, then reports the answer", async () => {
    vi.stubGlobal(
      "fetch",
      serveRuns([
        { id: "r1", status: "streaming", partial: "half" },
        { id: "r1", status: "streaming", partial: "half an ans" },
        { id: "r1", status: "done", final_message_id: "m1" },
      ])
    );
    const seen: string[] = [];
    const out = await pollRun("team", "c1", (p) => seen.push(p), { sleep: noSleep });
    expect(seen).toEqual(["half", "half an ans"]);
    expect(out).toEqual({ status: "done", error: null, hasAnswer: true });
  });

  it("reports hasAnswer for a run that settled BEFORE the first poll (the settle-window hole)", async () => {
    // The turn finished in the ~1s between the page fetching the thread and this first poll. It was
    // never observed streaming — but its answer is exactly what the caller is missing. Keying off
    // "was it live while I watched" left the user with a permanently blank answer bubble.
    vi.stubGlobal("fetch", serveRuns([{ id: "r1", status: "done", final_message_id: "m1" }]));
    const out = await pollRun("team", "c1", () => {}, { sleep: noSleep });
    expect(out).toEqual({ status: "done", error: null, hasAnswer: true });
  });

  it("reports a failed run with its sanitized message, and no answer to fetch", async () => {
    vi.stubGlobal(
      "fetch",
      serveRuns([{ id: "r1", status: "error", error: "The model was busy. Please try again in a moment." }])
    );
    const out = await pollRun("team", "c1", () => {}, { sleep: noSleep });
    expect(out?.status).toBe("error");
    expect(out?.hasAnswer).toBe(false);
    expect(out?.error).toMatch(/busy/i);
  });

  it("STOPS when a different run takes over — one turn's text must never land in another's bubble", async () => {
    // The endpoint reports the thread's LATEST run, so a new question mid-poll switches the id.
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      serveRuns([
        { id: "r1", status: "streaming", partial: "old turn" },
        { id: "r2", status: "streaming", partial: "NEW turn text" },
      ])
    );
    const out = await pollRun("team", "c1", (p) => seen.push(p), { sleep: noSleep });
    expect(seen).toEqual(["old turn"]); // the new run's text was never adopted
    expect(out).toBeNull();
  });

  it("stops immediately when aborted, and when the thread has no run", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const fetchMock = serveRuns([{ id: "r1", status: "streaming" }]);
    vi.stubGlobal("fetch", fetchMock);
    expect(await pollRun("team", "c1", () => {}, { signal: ctl.signal, sleep: noSleep })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubGlobal("fetch", serveRuns([null]));
    expect(await pollRun("team", "c1", () => {}, { sleep: noSleep })).toBeNull();
  });

  it("gives up quietly when the endpoint errors or the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response));
    expect(await pollRun("team", "c1", () => {}, { sleep: noSleep })).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await pollRun("team", "c1", () => {}, { sleep: noSleep })).toBeNull();
  });

  it("does not claim an answer for a done run with no persisted message", async () => {
    vi.stubGlobal("fetch", serveRuns([{ id: "r1", status: "done", final_message_id: null }]));
    const out = await pollRun("team", "c1", () => {}, { sleep: noSleep });
    expect(out).toEqual({ status: "done", error: null, hasAnswer: false });
  });
});
