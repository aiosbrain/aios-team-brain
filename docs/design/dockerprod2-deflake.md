# The runner stage stops reading the build context — DOCKERPROD-2

**Status:** spec, round 1 (both spec reviews folded). No code written.

**Build with:** opus / high — it changes the image production boots from. The blast radius is small
(one `COPY` deleted, one `ENTRYPOINT` changed, one build-time assertion added) but the failure mode is
a container that builds green and cannot start, and the only roll-forward from that is another deploy.

**Deps:** none. **Blocks:** DOCKERPROD-1, the standalone/production-image slice, which is deliberately
NOT this one.

---

## What and why

The repo-root `Dockerfile`'s runner stage re-reads the **build context** for a single file:

```dockerfile
FROM base AS runner
COPY --from=build /app ./                                        # line 34
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh           # line 35  ← reads the CONTEXT
RUN chmod +x /usr/local/bin/entrypoint.sh                        # line 36
```

**Line 35 copies a file the image already has.** The build stage's `COPY . .` (line 28) puts it at
`/app/docker/entrypoint.sh`, and the runner's `COPY --from=build /app ./` (line 34) brings that in.
That redundancy is the whole case for this slice, and it holds regardless of anything in §0b.

**The motivation** — not the argument — is that this same instruction failed two Railway production
builds, each time blocking a merged fix from reaching production for hours and each time needing a
human dashboard re-trigger:

| deployment | PR | date | failure |
|---|---|---|---|
| `4c842d11-3401-45da-ab28-6971c7e5d648` | #648 | 2026-08-23 | `lstat /docker/entrypoint.sh: no such file or directory` |
| `1a210d5b-469b-4725-b60c-c6865e5073ad` | #658 | 2026-08-26 14:53 UTC | same |

## 0. Terrain, measured before designing

### 0a. The file is already in the image — measured, not traced

I built a throwaway image over the real build context rather than reasoning about it:

```
$ docker build -f /tmp/probe/Dockerfile .      # FROM busybox; WORKDIR /app; COPY . .; RUN ls -l …
-rwxr-xr-x    1 root     root           665 Jul 30 01:48 /app/docker/entrypoint.sh
```

So the context COPY lands the file at exactly the path the new `ENTRYPOINT` will name, **with its
`100755` mode preserved**. Supporting reads:

| claim | how checked | result |
|---|---|---|
| `.dockerignore` does not exclude `docker/` | read the file | excludes `node_modules`, `.next`, `.git`, `.github`, env files, dev noise — **nothing under `docker/`** |
| the file is tracked, executable | `git ls-files -s docker/entrypoint.sh` | `100755 e940c8fa` |
| nothing else consumes `/usr/local/bin/entrypoint.sh` | `grep -rn` across the repo | only the `Dockerfile`'s own `COPY`/`chmod`/`ENTRYPOINT` triple; both reviews confirmed independently |
| the copy-through already works in production | `docker/entrypoint.sh:5` runs `node /app/docker/bootstrap.mjs` | the **sibling file** ships through this exact path today, and every compose boot proves it |

### 0b. Why the flake is MOTIVATION and not EVIDENCE — a claim I withdrew

Round 0 of this spec argued that the LATE context read is the vulnerable one, and offered the error's
leading slash (`lstat /docker/…`) as proof that the daemon resolved the path against `/` rather than
against the context. **Both reviewers rejected that, and they were right.** I tested it:

```
$ docker build .        # COPY definitely-not-here.sh /tmp/x   — a genuinely absent context file
ERROR: failed to calculate checksum of ref …: "/definitely-not-here.sh": not found
```

A plainly context-relative miss **also prints a leading slash**, because the context root IS `/`. The
slash discriminates nothing and that sentence is deleted. *(The message text does differ — `failed to
calculate checksum … not found` here vs `lstat … no such file or directory` on Railway — but I am not
going to build a second mechanism claim on one local buildkit version.)*

What survives as fact: two failures at the identical instruction; the file present at both commits;
`git diff` on `Dockerfile`, `.dockerignore` and `docker/` between the last success and the failure is
**empty**; and in the #648 failure `npm run build` demonstrably EXECUTED (its full route table is in
the build log), so the build stage was not a pure cache replay.

**What remains a hypothesis, explicitly:** that the late context read is more exposed than the early
one. ⚠️ **The honest no-improvement reading, which I accept:** if Railway/buildkit has an unreliable
context session, deleting line 35 may just move the next failure onto `COPY . .`, leaving the total
flake rate unchanged. **This slice does not promise a lower flake rate.** It removes an instruction
that copies a file the image already carries — which is worth doing on its own, and is why the design
does not rest on the mechanism at all.

### 0c. On the production path, the entrypoint never runs

`railway.json:5` sets `startCommand: "sh scripts/railway-start.sh"`, which replaces the image's
`ENTRYPOINT`; `scripts/railway-start.sh:4-5` says so in its own comment and duplicates the bootstrap
for that reason. So on Railway this file is **dead weight whose `COPY` can still fail the build**. Its
only consumer is the local `docker compose` stack (`compose.yml`'s `app` service — `build: .`, no
`entrypoint:` override).

### 0d. The header sentence that made this look harmless is false

```
# It is NOT wired into the Railway deploy path, which still builds from the repo via the
# GitHub integration
```

Railway's GitHub integration auto-detects a root `Dockerfile` and builds it — the build logs above are
of its stages, by name. That sentence is why a local-demo `COPY` sat unexamined on the production
critical path, so correcting it belongs to THIS slice: leaving a sentence I have just proven false, in
the file I am editing, for the reason I am editing it, is its own defect. **Both reviewers agreed this
is not DOCKERPROD-1 scope creep.**

## 1. The rule

> **The runner stage builds from earlier stages of this same Dockerfile and from nothing else — no
> context, no named context, no external image. Anything it needs is already in the image, and it
> asserts at BUILD time that what it points at is there.**

## 2. The design

### 2a. Delete the redundant copy; assert what replaces it; point `ENTRYPOINT` at it

```dockerfile
FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app ./
RUN test -r /app/docker/entrypoint.sh          # ← fail CLOSED at build time
...
ENTRYPOINT ["/bin/sh", "/app/docker/entrypoint.sh"]
```

⚠️ **The `RUN test -r` is not belt-and-braces — it repairs a fail-open the deletion would otherwise
introduce, and it is the sharpest thing either review found.** Today, if the file were ever absent
from the build stage, line 35 **fails the build**. Delete line 35 and that same absence becomes:
`COPY --from=build /app ./` succeeds, `next build` succeeds, the image is green, and the *container*
dies at boot — a defect moved from build time to somebody's runtime. One `RUN` puts it back where it
was.

**Why `/bin/sh <path>` and not the bare path.** The two forms genuinely differ: the bare path makes
the kernel read `#!/usr/bin/env sh` and resolve `sh` through `PATH` via `/usr/bin/env`, and it requires
the executable bit; the explicit form depends on neither. `/bin/sh` is guaranteed on this Debian base
(the upstream node image's own entrypoint uses `#!/bin/sh`, and this Dockerfile already relies on the
default `/bin/sh -c` for its shell-form `RUN`s). It is also the idiom this repo already uses for the
same script's production twin (`railway.json`: `sh scripts/railway-start.sh`).

⚠️ *Round 0 justified this as removing a dependence on something "pinned by nothing." That was wrong
and Fable caught it: the mode bit **is** pinned, by the git index at `100755`, which §0a verifies. The
honest justification is narrower — the explicit form depends on nothing outside the Dockerfile, at
zero cost. AC2 pins the form so a later bare-path edit cannot silently reintroduce the dependence.*

Inside the script nothing changes: `$@` forwarding, `set -eu`, exit-code propagation, and the final
`exec "$@"` are identical, and `sh` is the interim PID 1 in both forms.

⚠️ *One correction to the existing comment at `docker/entrypoint.sh:15`, which says the exec makes
"the server" PID 1: `exec "$@"` runs `npm start` (`package.json:9` → `next start`), so **npm** becomes
PID 1, not Next. That is pre-existing and NOT changed by this slice; AC4 measures what PID 1 actually
is and the finding is reported rather than fixed here.*

### 2b. The header stops claiming it is off the deploy path

Rewritten to state the two facts positively: Railway auto-detects and builds this root `Dockerfile`,
and Railway's configured `startCommand` overrides the image's `ENTRYPOINT` — so the entrypoint is the
local-compose path only. The devDependencies paragraph stays; it is still accurate and DOCKERPROD-1
owns changing it.

## 3. Scope

**In:** `Dockerfile` (the runner lines + the header) · one guard, unit tier · `docs/ARCHITECTURE.md`
if the deploy flow's prose is affected.

**Out — all of it DOCKERPROD-1:**
- `output: "standalone"`, `--omit=dev`, a traced runtime, splitting seeding out.
- `railway.json`'s `preDeployCommand`, `scripts/railway-start.sh`, `next.config.ts`.
- Moving the Dockerfile out of Railway's way — the operator's decision was to keep building it.
- The `docker/entrypoint.sh:15` PID-1 comment (§2a): reported by AC4, corrected by neither slice yet.
- Multi-arch, image signing, registry cache.

## 4. Acceptance

- **AC1 — the final stage reads nothing but declared earlier stages (guard, unit, ∀):** in the
  Dockerfile's FINAL stage, (a) there is no `ADD`; (b) every `COPY` carries `--from=<name>` where
  `<name>` is a stage declared by an earlier `FROM … AS <name>` **in this file**; (c) no
  `RUN --mount=type=bind` without an explicit `from=<declared stage>`; and (d) — non-vacuity — at
  least one `COPY --from=<declared stage>` exists. *Round 0 quantified over `COPY` alone, which both
  reviewers broke three ways: `ADD` reads the context, `--from=` may name an external image or a named
  context rather than a stage, and buildkit's default bind-mount source IS the context. A ∀ narrower
  than the rule it claims to enforce is not a guard.*
- **AC2 — the entrypoint is a build-asserted path in the invoked form (guard, unit):** the guard parses
  `ENTRYPOINT`, and (a) **fails loudly on any shape it does not recognise** — shell form, `-c` string,
  anything but `["/bin/sh", "<path>"]`; (b) requires the final stage to contain a `RUN` asserting that
  exact `<path>` is readable; (c) requires `<path>` to correspond, under the image's `/app` root, to a
  file tracked in the repo. *Round 0's version checked only (c) and called it proof the image carries
  the file — Codex's counterexample: copy from the wrong stage, or `rm` after copying, and (c) still
  passes. (b) is what actually observes the image, at build time. (a) exists because an ENTRYPOINT
  shape the guard silently skips is a guard that passes on the defect.*
- **AC3 — the header states the deploy contract positively (guard, unit):** the Dockerfile does not
  contain the retired sentence, AND asserts both that Railway builds this Dockerfile and that its
  `startCommand` overrides the image entrypoint. *Round 0 required only that the word "Railway" appear
  — satisfied by "Railway never builds this Dockerfile," which is false. Asserting the contract is the
  only version that cannot be satisfied by a differently-worded lie.*
- **AC4 — the image builds, serves, and STOPS (manual, recorded):** `docker compose build app`
  succeeds; a container from it boots through `entrypoint.sh` and answers an HTTP request;
  `docker compose stop` terminates it within the grace period with no orphan; and `PID 1` is recorded
  as observed (see §2a). ⚠️ *Manual and named as such — this repo has no container test tier and
  claiming CI proves it would be false. The stop leg is here because the `ENTRYPOINT` form is the one
  thing this slice changes about the running container.*

| # | mutation | must redden |
|---|---|---|
| 1 | restore `COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh` in the runner | **AC1** (a context `COPY`) |
| 2 | add `ADD package.json ./x` to the runner | **AC1** (the `ADD` leg) |
| 3 | add `COPY --from=somectx package.json ./x` — a source that is not a declared stage | **AC1** (the undeclared-source leg) |
| 4 | add `RUN --mount=type=bind,target=/ctx true` to the runner | **AC1** (the bind-mount leg) |
| 5 | delete `COPY --from=build /app ./` entirely | **AC1** (the non-vacuity leg) |
| 6 | `ENTRYPOINT` points at `/usr/local/bin/entrypoint.sh` | **AC2** (assertion/entrypoint divergence) |
| 7 | `ENTRYPOINT` and the `RUN test` BOTH move to `/app/docker/nope.sh` | **AC2** (the repo-correspondence leg) |
| 8 | delete the `RUN test -r` assertion | **AC2** (the build-assertion leg) |
| 9 | `ENTRYPOINT /app/docker/entrypoint.sh` in **shell form** | **AC2** (ambiguity must fail, not skip) |
| 10 | `ENTRYPOINT ["/app/docker/entrypoint.sh"]` — bare path, no `/bin/sh` | **AC2** (the invoked-form leg) |
| 11 | restore the "NOT wired into the Railway deploy path" sentence | **AC3** |
| 12 | header reads "Railway never builds this Dockerfile" — false, contains "Railway" | **AC3** (the round-0 bypass) |
| 13 | header drops the `startCommand`-override statement | **AC3** (the second positive leg) |

Each row changes exactly ONE condition, so a redden attributes to one criterion. Every row must redden
the criterion NAMED, not merely something.

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| The file is absent from the build stage; the build goes green and the container dies at boot | **fail-open introduced by this very change** — the worst outcome here | §2a's `RUN test -r`, pinned by AC2(b) and mutation 8 |
| Wrong entrypoint path or lost exec bit | an unbootable container | AC2(a)+(c); §2a removes the exec-bit dependence; AC4 boots a real container |
| The guard reads the Dockerfile as prose | a guard with no failure mode is ceremony | it must parse stages and instructions; all 13 mutations must redden the NAMED criterion |
| AC1 passes vacuously on a stage with no `COPY` at all | silently green | AC1(d), mutation 5 |
| Someone reads this as "the flake is fixed" | a false claim in the map | §0b states the limit and the no-improvement reading; the PR body must repeat both |
| Railway builds a different Dockerfile than the one guarded | the guard watches the wrong file | the build logs name these stages (`build`, `runner`) verbatim — §0b |

## 6. Release condition

**No staging gate — and the round-0 reason for that was false.** I wrote that the slice "does not
change what the runtime contains." It does: `/usr/local/bin/entrypoint.sh` is gone and the `ENTRYPOINT`
is different. What is actually true is narrower, and it is enough:

- **Railway's runtime process is unchanged**, because `startCommand` overrides the image entrypoint
  (§0c) — so the production path does not execute the thing this slice changes.
- **Local compose is the path whose behaviour changes**, and AC4 exercises exactly that, in the real
  container, including the stop path.
- **One staging build could not demonstrate the absence of a stochastic flake anyway**, so invoking the
  gate here would spend it on a question it cannot answer.

That is a risk-based boundary, not an erosion of the gate DOCKERPROD-1 genuinely needs. Post-merge,
the normal Railway deploy verification applies.

**Nothing is built. No code exists for this slice.**
