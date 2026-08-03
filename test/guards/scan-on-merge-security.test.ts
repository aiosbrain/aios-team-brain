import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  join(process.cwd(), ".github", "workflows", "scan-on-merge.yml"),
  "utf8",
);
const requirements = readFileSync(
  join(process.cwd(), ".github", "scripts", "brain-scanner-requirements.txt"),
  "utf8",
);

describe("guard: scan-on-merge dependency and coverage isolation", () => {
  it("keeps optional coverage installation fail-open", () => {
    expect(workflow).toMatch(
      /if npm ci --ignore-scripts; then[\s\S]*?npm run coverage \|\| true/,
    );
    expect(workflow).toMatch(
      /else\n\s+echo "dependency install failed — continuing without a coverage report\."/,
    );
  });

  it("uses only hash-locked binary scanner dependencies without a package build", () => {
    expect(workflow).toMatch(
      /python -m pip install --only-binary=:all: --require-hashes/,
    );
    expect(workflow).toMatch(/PYTHONPATH: ingestion/);
    expect(workflow).toMatch(/python -m aios_ingest\.cli scan/);
    expect(workflow).not.toMatch(/pip install -e|pip install ingestion/);
    const pinned = requirements.split("\n").filter((line) => /^[a-z]/.test(line));
    expect(pinned.length).toBeGreaterThan(0);
    for (const line of pinned) expect(line).toMatch(/^[a-z][a-z0-9-]*==[^ ]+ \\$/);
    expect(requirements.match(/--hash=sha256:[0-9a-f]{64}/g)?.length).toBe(pinned.length);
  });
});
