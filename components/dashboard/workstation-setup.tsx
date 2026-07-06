import { Rocket } from "lucide-react";
import { CopySnippet } from "@/components/copy-snippet";
import { MyApiKeys, type MyKeyRow } from "@/components/people/my-api-keys";

/**
 * First-screen for a brand-new member (see lib/dashboard/home-state.pickHomeState):
 * one CTA — a copy-paste prompt for whatever coding agent they use — plus inline
 * self-serve key generation, collapsed into a single screen instead of sending them
 * to hunt for their profile page first.
 */
export function WorkstationSetup({
  teamSlug,
  firstName,
  agentPrompt,
  keys,
}: {
  teamSlug: string;
  firstName: string;
  agentPrompt: string;
  keys: MyKeyRow[];
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="bg-gradient-prism rounded-2xl p-[1px]">
        <div className="rounded-2xl bg-surface-inset px-8 py-10">
          <div className="mb-4 flex items-center gap-3">
            <Rocket className="size-6 text-violet" strokeWidth={1.5} />
            <h2 className="text-xl font-semibold text-ink">Set up your AIOS workstation, {firstName}</h2>
          </div>
          <p className="mb-6 text-sm text-ink-secondary">
            One step: paste this into Claude Code, Claude Desktop, Cursor, Codex, or Opencode — it
            scaffolds your personal workspace and connects it to this team&apos;s brain.
          </p>
          <CopySnippet label="agent prompt" text={agentPrompt} />
        </div>
      </div>
      <MyApiKeys teamSlug={teamSlug} keys={keys} />
    </div>
  );
}
