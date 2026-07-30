/**
 * prompt.mjs — terminal input that survives `curl … | sh`.
 *
 * THE PROBLEM THIS EXISTS FOR
 *
 * `curl -fsSL …/install.sh | sh` makes the SCRIPT the shell's stdin. So anything downstream
 * that reads stdin reads leftover script bytes, not the user — prompts either return garbage
 * or return EOF instantly and the whole interview silently answers itself with defaults. It is
 * the single most common way a piped installer breaks, and it breaks quietly.
 *
 * The fix is to talk to the terminal directly: open `/dev/tty`, which is the controlling
 * terminal regardless of what stdin has been redirected to.
 *
 * And when there is no terminal at all — CI, a cron job, `| sh` inside a pipeline — we must
 * NOT invent answers. An installer that defaults its way through an interview produces a
 * misconfigured instance and reports success. `resolveInputSource` returns "none" and the
 * caller is expected to stop and print the flag-driven equivalent.
 */
import { openSync } from "node:fs";
import { createInterface } from "node:readline";
import { ReadStream as TtyReadStream } from "node:tty";

/**
 * Where to read answers from. Pure so the three cases are testable without a terminal.
 *
 * @param {{stdinIsTty: boolean, devTtyOpens: boolean}} env
 * @returns {"stdin"|"dev-tty"|"none"}
 */
export function resolveInputSource({ stdinIsTty, devTtyOpens }) {
  if (stdinIsTty) return "stdin"; // normal `npm run setup`
  if (devTtyOpens) return "dev-tty"; // piped script, real terminal behind it (curl | sh)
  return "none"; // no human present — refuse rather than default
}

/** Probe whether /dev/tty is actually openable. Windows and some CI images have no such file. */
export function devTtyOpens(open = openSync) {
  try {
    const fd = open("/dev/tty", "r");
    return { ok: true, fd };
  } catch {
    return { ok: false, fd: null };
  }
}

export class NoTerminalError extends Error {
  constructor(message) {
    super(message);
    this.name = "NoTerminalError";
  }
}

/**
 * Open a reader for the resolved source. Returns null for "none" so the caller decides how to
 * fail — this module does not get to exit the process.
 */
export function openReader({ stdinIsTty = process.stdin.isTTY, open = openSync } = {}) {
  const probe = stdinIsTty ? { ok: false, fd: null } : devTtyOpens(open);
  // Routed through the same pure decision the tests pin, so the two cannot disagree.
  const source = resolveInputSource({ stdinIsTty: Boolean(stdinIsTty), devTtyOpens: probe.ok });

  if (source === "stdin") return { source, stream: process.stdin, close: () => {} };
  if (source === "none") return null;

  // A tty.ReadStream, NOT fs.createReadStream. Only the former carries `setRawMode`, which is what
  // readline uses to turn OFF the terminal's own echo — with an fs stream the tty stays in canonical
  // mode and the kernel echoes every keystroke, so a pasted API key appears in cleartext no matter
  // what this module does about readline's echo.
  const stream = new TtyReadStream(probe.fd);
  return { source, stream, close: () => stream.destroy() };
}

/**
 * An interactive prompter.
 *
 * `secret: true` suppresses echo — API keys otherwise land in terminal scrollback and in any
 * session recording, which for a tool whose pitch is "private by default" is the wrong default.
 */
export function createPrompter({ reader, out = process.stdout } = {}) {
  if (!reader) {
    throw new NoTerminalError(
      "no terminal available for input. Re-run attached to a terminal, or use the flag-driven form " +
        "(`node scripts/setup-wizard.mjs --help`). Piping a script into `sh` without a tty cannot answer prompts."
    );
  }

  const rl = createInterface({ input: reader.stream, output: out, terminal: true });
  let muted = false;
  // readline's own echo is the only thing that writes the typed characters; overriding this is
  // the supported way to mask input without hand-rolling raw mode.
  const write = rl._writeToOutput?.bind(rl);
  rl._writeToOutput = (chunk) => {
    if (!muted) return write?.(chunk);
    // Keep the prompt itself visible; replace only what the user types.
    if (chunk.includes("\n")) return write?.("\n");
    return write?.("*");
  };

  async function ask(question, { secret = false } = {}) {
    // Write the question OURSELVES first, then mute. readline renders its prompt through the same
    // `_writeToOutput` hook we override, so muting before `rl.question(...)` collapsed the entire
    // question to a single "*" — the user saw an asterisk and a cursor with no idea what was being
    // asked. Question via `out`, empty prompt to readline.
    out.write(question);
    muted = secret;
    try {
      const answer = await new Promise((resolve) => rl.question("", resolve));
      return answer.trim();
    } finally {
      muted = false;
      if (secret) out.write("\n");
    }
  }

  return {
    source: reader.source,
    /** Free text, with an optional default and a validator that returns null or a complaint. */
    async text(question, { def = "", secret = false, validate = () => null } = {}) {
      for (;;) {
        const shown = def ? `${question} [${def}] ` : `${question} `;
        const raw = await ask(shown, { secret });
        const value = raw || def;
        const complaint = validate(value);
        if (!complaint) return value;
        out.write(`  ✗ ${complaint}\n`);
      }
    },
    async confirm(question, { def = true } = {}) {
      const hint = def ? "Y/n" : "y/N";
      for (;;) {
        const raw = (await ask(`${question} [${hint}] `)).toLowerCase();
        if (!raw) return def;
        if (["y", "yes"].includes(raw)) return true;
        if (["n", "no"].includes(raw)) return false;
        out.write("  ✗ answer y or n\n");
      }
    },
    /** Numbered choice. Returns the chosen option's `value`. */
    async choose(question, options, { def = 0 } = {}) {
      out.write(`${question}\n`);
      options.forEach((o, i) => {
        out.write(`  ${i + 1}) ${o.label}\n`);
        if (o.detail) out.write(`     ${o.detail}\n`);
      });
      for (;;) {
        const raw = await ask(`  choose 1-${options.length} [${def + 1}] `);
        const idx = raw ? Number(raw) - 1 : def;
        if (Number.isInteger(idx) && idx >= 0 && idx < options.length) return options[idx].value;
        out.write(`  ✗ enter a number between 1 and ${options.length}\n`);
      }
    },
    close: () => {
      rl.close();
      reader.close();
    },
  };
}
