/** Boolean names are per CLI; value-taking flags retain the legacy tokenizer contract. */
export const ADMIN_BOOLEAN_FLAGS = ["help", "upsert", "hard", "force", "confirm", "dry-run", "confirm-production"] as const;
export const TASK_BOOLEAN_FLAGS = ["help", "clear-sprint", "dry-run", "project-to-linear"] as const;
export type Flags = Record<string, string | boolean>;
type ParsedArgs = { cmd: string; positionals: string[]; flags: Flags };
export type AdminArgsResult = ({ ok: true } & ParsedArgs) | { ok: false; error: string };

/** An importable CLI reports an exit to its entry point instead of terminating its caller. */
export class CliExitError extends Error {
  constructor(message: string, public readonly exitCode = 1) {
    super(message);
    this.name = "CliExitError";
  }
}

/** Validate every raw occurrence before last-wins tokenization can erase malformed input. */
export function parseAdminArgs(argv: string[], registry: readonly string[]): AdminArgsResult {
  const booleans = new Set(registry);
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).split("=", 1)[0];
    if (!booleans.has(key)) continue;
    const next = argv[i + 1];
    if (token.includes("=") || (next !== undefined && !next.startsWith("--"))) {
      // Never echo the adjacent value: it may be a password.
      return { ok: false, error: `--${key} takes no value; pass it bare as --${key}, or omit it.` };
    }
  }
  return { ok: true, ...parseArgs(argv) };
}

// Extracted unchanged from the original CLI tokenizer.
function parseArgs(argv: string[]): { cmd: string; positionals: string[]; flags: Flags } {
  const [cmd = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positionals.push(a);
  }
  return { cmd, positionals, flags };
}
