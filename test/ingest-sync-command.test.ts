import { describe, expect, it } from "vitest";
import { isSyncCommand } from "@/lib/ingest/manual-sync";

/**
 * Spec for the query-box scrape trigger: a sync COMMAND runs ingestion; a real QUESTION must not.
 * The risk is false positives — a question that merely mentions "sync"/"scrape" should still go to
 * the brain, not silently kick off a connector pull. Derived from that intent, not the impl.
 */

describe("isSyncCommand", () => {
  it("recognizes explicit slash + whole-message commands", () => {
    for (const cmd of ["/sync", "/scrape", "/refresh", "sync now", "scrape now", "refresh data", "pull latest", "Sync", "SCRAPE NOW", "  /sync  ", "sync!", "scrape."]) {
      expect(isSyncCommand(cmd), `expected sync for "${cmd}"`).toBe(true);
    }
  });

  it("does NOT trigger on real questions that mention sync/scrape", () => {
    for (const q of [
      "what got synced from Slack today?",
      "how do I sync Linear?",
      "did the scrape run last night?",
      "who set up the GitHub sync?",
      "refresh my memory on the Q3 decision",
      "what is the team working on right now?",
      "",
    ]) {
      expect(isSyncCommand(q), `expected NOT sync for "${q}"`).toBe(false);
    }
  });
});
