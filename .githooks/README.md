# .githooks — tracked hooks + the machine-local chain convention

This repo activates this directory with `core.hooksPath=.githooks` (set by the
package.json `"prepare"` script on every `npm install`). That has one critical
consequence: **git ignores `.git/hooks/` entirely** — any hook installed there
(by the NDA leak-gate installers, `aios worktree install-hook`, etc.) never
runs on its own.

## The convention

Two layers, one chain:

| Layer | Location | Contents | Who runs it |
|---|---|---|---|
| **Repo policy (tracked)** | `.githooks/<hook>` | version-controlled, same for everyone: primary-commit guard, docs-drift guard, skill-sync guard | git, via `core.hooksPath` — in the primary AND every linked worktree (each worktree executes its own checked-out copy) |
| **Machine-local (untracked)** | `$(git rev-parse --git-common-dir)/hooks/<hook>` i.e. the primary's `.git/hooks/<hook>` | per-machine, never committed: the NDA leak-gate shims (`~/.config/aios-nda/nda-leak-gate.sh`), worktree auto-hydration | **only** the tracked hook, which chains it explicitly |

Every tracked hook here ends by exec'ing/running the machine-local hook of the
same name from the **git common dir** (shared by all worktrees, so one local
install covers every worktree). Rules baked into each tracked hook:

- **Resolve via `git rev-parse --git-common-dir`, never
  `--git-path hooks/...`** — `--git-path` honors `core.hooksPath` and resolves
  straight back into `.githooks/` (self-recursion or a dead
  `.githooks/<hook>.chained` target — the bug this convention fixed).
- **Skip** a chain target that is missing, non-executable, or contains the
  `aios-tracked-hook` marker (recursion belt-and-braces). Missing is normal for
  contributors without the private NDA config; the NDA gate itself fails
  closed once installed.
- **Gate hooks chain unconditionally on the success path.** In particular the
  pre-commit chain runs in linked worktrees *and* under
  `AIOS_ALLOW_PRIMARY_COMMIT=1` — overriding the worktree guard never skips
  the NDA gate. The pre-push chain runs *before* the drift/skill guards so the
  confidentiality gate can't be masked by a drift failure.

## Current hooks

- `pre-commit` — blocks authored commits in the PRIMARY checkout (work belongs
  in `aios worktree add` worktrees; override: `AIOS_ALLOW_PRIMARY_COMMIT=1`),
  then chains the machine-local pre-commit (NDA leak gate, `staged` scan).
- `pre-push` — chains the machine-local pre-push (NDA leak gate, `tree` scan),
  then the docs-drift guard, then the skill-runtime-sync guard.
- `post-checkout` — chains the machine-local post-checkout (worktree
  auto-hydration); never blocks.

Guarded by `test/guards/githooks-chain.test.ts` (fixture-repo tests: primary
block, worktree pass-through, chain execution incl. under the override,
ff-only merge untouched, no recursion).

## Installer caveat

The aios-workspace installers (`install-primary-commit-guard.sh`,
`install-leak-gate-push-hook.sh`) resolve `core.hooksPath` and copy their hook
INTO this tracked directory, clobbering the tracked file with an untracked
variant whose chain resolution is broken here (see above). Until those
installers learn to leave hooksPath repos alone (machine-local hooks belong in
the common dir for this repo), a re-run will dirty `.githooks/pre-commit` —
restore with `git checkout -- .githooks/pre-commit`. The tracked hooks already
provide the guard, so the installers add nothing in this repo.
