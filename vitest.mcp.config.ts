import { mergeConfig } from "vitest/config";
import httpConfig from "./vitest.http.config";

// Opt-in only: normal HTTP and offline suites remain independent of Workspace.
export default mergeConfig(httpConfig, {
  test: { include: ["test/http/mcp-tier-safety.acceptance.ts"] },
});
