import { Bot, Lock } from "lucide-react";

/**
 * Stub for the spec's "permissioned agents claim tasks from the board" pillar.
 * No spawn logic yet — this keeps the information architecture visible so the
 * capability has a home when the agent-run data model lands.
 */
export function AgentsPlaceholder() {
  return (
    <section className="prism-card flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <div className="bg-gradient-prism rounded-xl p-[1px]">
          <div className="rounded-xl bg-surface-inset p-2.5">
            <Bot className="size-5 text-violet" strokeWidth={1.5} />
          </div>
        </div>
        <div>
          <h2 className="font-display text-base text-ink">Agent workstations</h2>
          <p className="mt-0.5 max-w-md text-sm text-ink-secondary">
            Spawn permissioned agents to claim tasks from the board and act under your team&apos;s
            policy. Coming soon.
          </p>
        </div>
      </div>
      <button
        type="button"
        disabled
        className="btn-prism shrink-0 cursor-not-allowed opacity-50"
        title="Agent spawning is not available yet"
      >
        <Lock className="size-4" />
        Spawn an agent
      </button>
    </section>
  );
}
