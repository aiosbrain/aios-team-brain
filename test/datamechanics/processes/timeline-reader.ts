/**
 * A SEPARATE application process for the multi-process revocation test (AIO-1167 R44 T1).
 *
 * It is the second app instance sharing the test PostgreSQL: it serves the Timeline through the real
 * `getCachedWorkTimeline` (process memory + persisted variants), so its memory cache is genuinely
 * independent of the test worker's. Driven over stdin, one JSON command per line; one JSON reply per
 * command on stdout:
 *   {"op":"read","teamId","memberId"}             → {"ok":true,"payload":"<serialized days>"} | {"ok":false,"error"}
 *   {"op":"hold","teamId","memberId"}             → {"held":true} once a COLD build is parked before
 *                                                   its publication, then the read reply after "release"
 *   {"op":"release"}                              → (releases a parked hold)
 *   {"op":"exit"}
 * Run with: node --conditions=react-server --import tsx test/datamechanics/processes/timeline-reader.ts
 */
import { createInterface } from "node:readline";

import { adminClient } from "@/lib/db/admin";
import { getCachedWorkTimeline, settleTimelineRefreshes } from "@/lib/dashboard/timeline-cache";

const reply = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let release: (() => void) | null = null;

async function read(teamId: string, memberId: string, hold: boolean) {
  try {
    let parked = false;
    const result = await getCachedWorkTimeline(adminClient(), teamId, "team", memberId, hold ? {
      beforeColdPublish: async () => {
        if (parked) return; // only the first attempt parks; a retry runs straight through
        parked = true;
        reply({ held: true });
        await new Promise<void>((resolve) => { release = resolve; });
      },
    } : {});
    await settleTimelineRefreshes();
    reply({ ok: true, payload: JSON.stringify(result.days) });
  } catch (error) {
    reply({ ok: false, error: error instanceof Error ? error.name : String(error) });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const command = JSON.parse(line) as { op: string; teamId?: string; memberId?: string };
  if (command.op === "release") {
    release?.();
    release = null;
  } else if (command.op === "exit") {
    lines.close();
    process.exit(0);
  } else {
    void read(command.teamId!, command.memberId!, command.op === "hold");
  }
});
reply({ ready: true });
