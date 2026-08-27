# The runner stage stops reading the build context — DOCKERPROD-2

**Status:** spec, round 3 (five model reviews folded). Code written against it.

**Build with:** opus / high — it changes the image production boots from. The diff is small but the
failure mode is a container that builds green and cannot start, and the only roll-forward from that is
another deploy. Round 2 found **three** distinct ways to reach exactly that outcome while every
round-1 criterion stayed green.

**Deps:** none. **Blocks:** DOCKERPROD-1, the standalone/production-image slice, deliberately NOT this
one.

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
That redundancy is the whole case for this slice and it holds independently of §0b.

**The motivation** — not the argument — is that this instruction failed two Railway production builds,
each time blocking a merged fix from production for hours and needing a human dashboard re-trigger:

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

The context COPY lands the file at exactly the path the new `ENTRYPOINT` names, with its `100755` mode
preserved. Supporting reads:

| claim | how checked | result |
|---|---|---|
| `.dockerignore` does not exclude `docker/` | read the file | excludes `node_modules`, `.next`, `.git`, `.github`, env files, dev noise — **nothing under `docker/`** |
| the file is tracked, executable | `git ls-files -s docker/entrypoint.sh` | `100755 e940c8fa` |
| nothing else consumes `/usr/local/bin/entrypoint.sh` | `grep -rn` across the repo | only the `Dockerfile`'s own `COPY`/`chmod`/`ENTRYPOINT` triple; both reviewers confirmed independently |
| the copy-through already works in production | `docker/entrypoint.sh:5` runs `node /app/docker/bootstrap.mjs` | the **sibling file** ships through this exact path today, and every compose boot proves it |

### 0b. Why the flake is MOTIVATION and not EVIDENCE — a claim I withdrew

Round 0 argued the LATE context read is the vulnerable one, offering the error's leading slash
(`lstat /docker/…`) as proof the daemon resolved against `/` rather than the context. **Both reviewers
rejected it and they were right.** Measured:

```
$ docker build .        # COPY definitely-not-here.sh /tmp/x   — a genuinely absent context file
ERROR: failed to calculate checksum of ref …: "/definitely-not-here.sh": not found
```

A plainly context-relative miss **also prints a leading slash** — the context root IS `/`. The slash
discriminates nothing; the sentence is deleted.

**What survives as fact:** two failures at the identical instruction; the file present at both commits;
`git diff` on `Dockerfile`, `.dockerignore` and `docker/` between the last success and the failure is
**empty**; and in the #648 failure `npm run build` demonstrably EXECUTED (its route table is in the
build log), so the build stage was not a pure cache replay — the same context session was read
successfully minutes before the failing read. That is **consistent with** a late-read/session-longevity
mechanism at n=2. It does not establish one.

**What this slice does and does not promise:**

- ❌ **It does not promise a lower flake rate.** If Railway/buildkit has an unreliable context session,
  the next failure may simply land on `COPY . .` instead. That reading is accepted.
- ✅ **It provably cannot RAISE context exposure.** The change strictly removes one of the file's three
  context reads and adds no new context dependency. Monotone, and free to state.

### 0c. On the production path, the entrypoint never runs

`railway.json:5` sets `startCommand: "sh scripts/railway-start.sh"`, which replaces the image's
`ENTRYPOINT`; `scripts/railway-start.sh:4-5` says so and duplicates the bootstrap for that reason. On
Railway this file is **dead weight whose `COPY` can still fail the build**. Its only consumer is the
local `docker compose` stack (`compose.yml`'s `app` service — `build: .`, no `entrypoint:` override).

⚠️ *That fact is load-bearing for §6, and it lives in `railway.json` — not in the Dockerfile. Deleting
`deploy.startCommand` silently falsifies §0c AND §6 while every prose check still passes, which is why
AC3(c) checks the file where the contract actually is.*

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

### 0e. Two behaviours I measured because the reviewers disagreed or I was about to guess

**`ONBUILD` fires inside a single Dockerfile.** Codex said it "does not execute in the current image
build"; Fable said it bypasses the guard entirely. Fable is right, and the build log settles it — the
context read is attributed to the *runner* stage while appearing in no runner-stage instruction:

```
FROM busybox AS base
ONBUILD COPY leaked.txt /leaked.txt
FROM base AS runner
RUN ls -l /leaked.txt
--------------------------------------------------------------------
#6 [runner 1/2] ONBUILD COPY leaked.txt /leaked.txt
#7 0.169 -rw-r--r--  1 root root  7 … /leaked.txt      ← the context, read inside runner
```

So AC1 must reject `ONBUILD` **anywhere in the file**, not just in the final stage.

**An empty `CMD` is a silent, successful exit.** `docker/entrypoint.sh:17` ends in `exec "$@"`; POSIX
`exec` with zero arguments is a no-op, so the script falls off the end and returns 0:

```
$ /bin/sh entrypoint-like.sh            # no args, i.e. CMD deleted
bootstrap ran
exit=0                                  ← green build, container exits at boot, no error anywhere
```

`CMD ["npm", "start"]` is therefore half the boot invocation and was pinned by nothing in round 1.

## 1. The rule

> **The final stage's FILESYSTEM comes from earlier stages of this same Dockerfile and from nothing
> else — no build context, no named context, no external image. Everything the boot chain needs is
> already in the image, the stage ASSERTS that at build time, and that assertion is the last thing in
> the stage that can touch the filesystem.**

*Deliberately scoped to filesystem sources.* A final-stage `RUN` may still reach the network; policing
that is a different rule and claiming it here would be claiming more than the guard checks.

## 2. The design

### 2a. Delete the redundant copy; assert the boot chain terminally; complete the invocation

```dockerfile
FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app ./
ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000

# TERMINAL boot-chain assertion — nothing below this line may touch the filesystem.
RUN set -eu; \
    for f in /app/docker/entrypoint.sh /app/docker/bootstrap.mjs; do \
      test -f "$f" || { echo "boot chain: $f is missing or not a regular file" >&2; exit 1; }; \
      test -s "$f" || { echo "boot chain: $f is empty" >&2; exit 1; }; \
      test -r "$f" || { echo "boot chain: $f is not readable" >&2; exit 1; }; \
    done; \
    /bin/sh -n /app/docker/entrypoint.sh

ENTRYPOINT ["/bin/sh", "/app/docker/entrypoint.sh"]
CMD ["npm", "start"]
```

### ⚠️ 2a-bis. The assertion I first wrote COULD NOT FAIL — measured, not reasoned

The first version, under `set -eu`, was `for f in …; do test -f "$f" && test -s "$f" && test -r "$f"; done`.

**It does not fail.** POSIX ignores `errexit` for a command in an AND-OR list, so a missing file falls
straight through:

```
$ sh -c 'set -eu; for f in /nope; do test -f "$f" && test -s "$f"; done; echo REACHED'
REACHED          exit=0     <- the && form
$ sh -c 'set -eu; for f in /nope; do test -f "$f"; test -s "$f"; done; echo REACHED'
                 exit=1     <- separate statements DO fire errexit
```

and end to end, which is the reading that matters — a real image build with `bootstrap.mjs` absent:

```
#8 [runner 3/3] RUN echo "!!! BUILD PASSED WITH bootstrap.mjs MISSING !!!"
#8 0.113 !!! BUILD PASSED WITH bootstrap.mjs MISSING !!!
```

So the centrepiece repair of this slice — the thing that closes the fail-open — **was itself
fail-open**, and all 21 static mutations still passed, because a static guard compares TEXT and the
text looked right. Neither the spec reviews nor the mutation battery could have caught it; only
building it could. Hence **AC5**: an assertion whose failure has never been observed is
unfalsifiable, and unfalsifiable reads exactly like coverage.

The shipped form exits explicitly, depends on no shell option, and names what is missing.

⚠️ **The assertion repairs a fail-open the deletion would otherwise introduce — the sharpest finding of
round 1.** Today, if the file were absent from the build stage, line 35 **fails the build**. Delete
line 35 and that absence becomes: `COPY --from=build /app ./` succeeds, `next build` succeeds, the
image is green, and the *container* dies at boot — a defect moved from build time to somebody's
runtime. The `RUN` puts it back.

Round 2 then broke my first version of it three ways, all folded above:

- **`test -r` alone is nearly `test -e`.** The build runs as root, where `access(2)` grants read on any
  mode — and `-r` passes on a **directory** at that path and on a **zero-byte file**, both of which
  still yield a green image and a container that exits without serving. Verified: `[ -r <dir> ]` is
  true, `[ -f <dir> ]` is false. Hence `-f` + `-s` + `-r`, plus `sh -n` as a build-time parse of the
  script. **Not `-x`** — that would re-couple the build to the very mode bit the `/bin/sh <path>` form
  deliberately decouples from.
- **It covered one of the two boot files.** `entrypoint.sh:5` runs `node /app/docker/bootstrap.mjs`;
  any absence mechanism that can eat one can eat the other. Both are asserted.
- **The assertion must be TERMINAL.** `RUN test …` followed by `RUN rm …` — or even
  `RUN test … && rm …` — passed round 1's wording, which is precisely the "rm after copying" hole the
  assertion exists to close. AC2(d) forbids any filesystem-touching instruction after it.

⚠️ **The assertion is DEPTH-1, and "the two boot files" is not the whole chain.** `bootstrap.mjs`
statically imports `../scripts/pg-load-schema.mjs` and two modules under `../scripts/setup/`, and the
derivation only reads `entrypoint.sh` — so a `.dockerignore` line excluding `scripts/` would build
green and boot dead. **Not a regression** (the old Dockerfile had the identical hole, and asserted
nothing at all), and a complete check would mean resolving the ESM import graph at build time —
`node -e "import(…)"` would do it but would also RUN bootstrap against no database, which is not a
trade this slice should make. Named as a limit rather than left implied. Raised by the diff review.

**Caching cannot stale this.** The `RUN`'s cache key includes its parent layer; `COPY --from=build
/app ./` re-checksums the build stage's `/app`, so a changed tree invalidates the COPY and therefore
the RUN. A cache hit implies a byte-identical tree, in which case the cached success is a true success.
Both reviewers agree; recorded so the next one need not re-derive it.

**Why `/bin/sh <path>` and not the bare path.** The bare path makes the kernel read
`#!/usr/bin/env sh`, resolve `sh` through `PATH` via `/usr/bin/env`, and require the executable bit;
the explicit form depends on none of that. `/bin/sh` is guaranteed on this Debian base (the upstream
node image's own entrypoint uses `#!/bin/sh`, and this Dockerfile already relies on the default
`/bin/sh -c` for its shell-form `RUN`s), and it is the idiom this repo already uses for the same
script's production twin (`railway.json`: `sh scripts/railway-start.sh`). Inside the script nothing
changes: `$@` forwarding, `set -eu`, exit-code propagation and the final `exec "$@"` are identical.

⚠️ *Round 0 justified this as removing a dependence on something "pinned by nothing." Wrong — the mode
bit IS pinned, by the git index at `100755`, which §0a verifies. The honest justification is narrower:
the explicit form depends on nothing outside the Dockerfile, at zero cost.*

⚠️ *One correction to `docker/entrypoint.sh:15`, which says the exec makes "the server" PID 1:
`exec "$@"` runs `npm start` (`package.json:9` → `next start`), so **npm** becomes PID 1, not Next.
Pre-existing and NOT changed here; AC4 records what PID 1 actually is and the finding is reported
rather than fixed in this slice.*

### 2b. The header states the deploy contract positively

Two sentinel sentences, quoted here verbatim so the header and the guard cannot drift:

> `Railway's GitHub integration auto-detects this root Dockerfile and BUILDS PRODUCTION with it.`
> `Railway overrides this image's ENTRYPOINT/CMD with railway.json's startCommand, so the entrypoint below is the local `docker compose` path only.`

The devDependencies paragraph stays — still accurate, and DOCKERPROD-1 owns changing it.

## 3. Scope

**In:** `Dockerfile` (the runner stage + the header) · one guard, unit tier · `docs/ARCHITECTURE.md`
if the deploy flow's prose is affected.

**Out — all of it DOCKERPROD-1:**
- `output: "standalone"`, `--omit=dev`, a traced runtime, splitting seeding out.
- `railway.json`'s `preDeployCommand`, `scripts/railway-start.sh`, `next.config.ts`.
- Moving the Dockerfile out of Railway's way — the operator's decision was to keep building it.
- The `docker/entrypoint.sh:15` PID-1 comment (§2a): reported by AC4, corrected by neither slice yet.
- Multi-arch, image signing, registry cache.

## 4. Acceptance

- **AC1 — the final stage's filesystem sources are earlier stages of this file, and nothing else
  (guard, unit, ∀):** in the FINAL stage — defined as the last `FROM` in file order, i.e. the default
  build target, which is what both `compose.yml:38` (`build: .`) and Railway build today —
  **(a)** its own `FROM` names a stage declared earlier in this file; **(b)** there is no `ADD`;
  **(c)** every `COPY` carries `--from=<name>` naming an earlier declared stage; **(d)** no `RUN`
  carries any `--mount`; **(e)** no `ONBUILD` appears **anywhere in the file**; **(f)** the parser
  fails LOUDLY rather than skipping — an unclassifiable instruction, a numeric or `ARG`-substituted
  `--from`, a duplicate stage name, or a final stage with no instructions is a failure, not a pass.
  *Round 1 quantified over `COPY` alone and round 2 broke it four ways: the stage's own `FROM` could
  be `busybox` (green build, no `node`, dead boot); `--mount` with `type=` omitted defaults to bind
  and `from=` omitted defaults to the context; `ONBUILD` in a parent stage executes inside this one
  (§0e, measured); and "non-vacuity" was a parser property masquerading as a product criterion.
  `--mount` is forbidden outright rather than allowlisted because modelling buildkit's mount defaults
  is a bug surface and nothing here uses one.*
- **AC2 — the boot invocation is complete, build-asserted, and terminal (guard, unit):**
  **(a)** `ENTRYPOINT` is present and is exactly `["/bin/sh", "<path>"]` — absence, shell form, a bare
  path, or any shape the parser does not recognise FAILS; **(b)** `CMD` is present, exec-form, and runs a
  **script `package.json` actually defines**; **(c)** the final stage's boot-chain assertion is
  EXACTLY the derived check — whole-instruction equality, not `contains`; **(d)** that assertion is TERMINAL
  — only `ENV`, `EXPOSE`, `LABEL`, `ARG`, `STOPSIGNAL`, `HEALTHCHECK`, `ENTRYPOINT`, `CMD` may follow
  it (an allowlist, so an unknown instruction fails closed); **(e)** the `ENTRYPOINT` path is one of
  the asserted paths; **(f)** the asserted paths correspond, under the image's `/app` root, to files
  tracked in the repo. *(f) is the weakest leg and is labelled so: it observes the repo, not the
  image — (c)+(d) are what observe the image. (b) exists because `exec "$@"` with an empty `$@` exits
  0 silently (§0e), so an unpinned `CMD` reproduces this slice's stated worst case with nothing
  noticing.*

  ⚠️ **Two conditions that a round-3 confirmation pass added, both against the built guard rather
  than the prose.** (i) `contains` was not enough for (c): `RUN <assertion> && rm <path>` asserts,
  passes, and then destroys what it observed **inside one instruction**, where (d)'s look-ahead
  cannot see it. Equality closes that, and has a second payoff — the Dockerfile line becomes a
  DERIVED artifact, so adding a boot dependency to `docker/entrypoint.sh` reddens the guard until
  the Dockerfile is updated to match. (ii) "non-empty `CMD`" was not the invariant either:
  `CMD ["true"]` is non-empty and boots a container that exits 0 having served nothing. The
  invariant is that `CMD` runs a script `package.json` defines — derived, not a pinned literal.
- **AC3 — the deploy contract is asserted where it is actually configured (guard, unit):**
  **(a)** the Dockerfile does not contain the retired sentence; **(b)** it contains both §2b sentinel
  sentences verbatim; **(c)** `railway.json` has a non-empty `deploy.startCommand`. *Round 1 required
  only that the word "Railway" appear — satisfied by "Railway never builds this Dockerfile." And a
  prose-only criterion cannot see the deletion of `deploy.startCommand`, which is what would actually
  falsify §0c and §6.* ⚠️ **Stated limit:** a repo guard cannot see a Railway **dashboard**-set start
  command or build target; that stays a deployment assumption, verified post-merge.
- **AC4 — the image builds, serves, and STOPS (manual, recorded as observed):**
  1. `docker compose build app` → exit 0.
  2. `docker inspect -f '{{.Config.Entrypoint}} {{.Config.Cmd}}'` → `[/bin/sh /app/docker/entrypoint.sh] [npm start]`.
  3. `docker compose logs app` contains bootstrap's own named startup line.
  4. `curl -fsS http://localhost:3000/login` → exit 0.
  5. `docker exec … cat /proc/1/cmdline` → recorded verbatim (expect `npm`, per §2a).
  6. `docker compose stop app` → stop latency **far under the 10s grace period** (SIGTERM honoured,
     not a SIGKILL at the end of it), `docker compose ps` lists nothing running, and the exit code is
     **UNCHANGED against the same image running `main`'s bare-path entrypoint** — an A/B, not a
     predicted constant.

  ⚠️ *Round 3 of this criterion said "exit code **143**, not 137." **Measured: it is 1, in both
  forms.** `npm start` catches SIGTERM, forwards it, and exits 1 rather than 128+15 — so 143 was a
  value I predicted instead of measured, written into an acceptance criterion where it would have
  read as a regression in a change that causes none. The A/B is what discriminates: NEW
  `["/bin/sh", "<path>"]` → exit 1 @ 1s; OLD bare path → exit 1 @ 2s; PID 1 is `npm start` in both.
  Recorded rather than quietly corrected, because "the criterion named a number I had not observed"
  is the finding.*
- **AC5 — the assertion is FALSIFIABLE (manual, negative controls):** with each boot-chain file
  removed, emptied, or replaced by a directory, `docker build` must **FAIL**; with all present it must
  pass. *Without this, §2a-bis shipped: a decoration that every other criterion called green.*

  ⚠️ *Manual and named as such — this repo has no container test tier and claiming CI proves it would
  be false. Round 1 said "boots through entrypoint.sh", "answers an HTTP request" and "no orphan",
  all three of which are design vocabulary that would ship green: a 500 page answers a request, and
  after `exec` there is no wrapper left to orphan. The numbers above are what a person can check.*

| # | mutation | must redden |
|---|---|---|
| 1 | final stage becomes `FROM busybox AS runner` | AC1(a) |
| 2 | restore `COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh` | AC1(c) |
| 3 | add `ADD package.json ./x` to the runner | AC1(b) |
| 4 | add `COPY --from=somectx package.json ./x` — source is not a declared stage | AC1(c) |
| 5 | add `RUN --mount=target=/ctx true` — type omitted ⇒ bind, from omitted ⇒ context | AC1(d) |
| 6 | add `ONBUILD COPY . .` to the `base` stage | AC1(e) |
| 7 | declare `AS build` twice | AC1(f) |
| 8 | delete `ENTRYPOINT` entirely | AC2(a) |
| 9 | `ENTRYPOINT` in shell form | AC2(a) |
| 10 | `ENTRYPOINT ["/app/docker/entrypoint.sh"]` — bare path | AC2(a) |
| 11 | **delete `CMD ["npm", "start"]`** | **AC2(b)** |
| 11b | **`CMD ["true"]`** — non-empty, exec-form, serves nothing | **AC2(b)** |
| 11c | **`CMD ["npm","start","--","--help"]`** — a defined script that prints help and exits 0 | **AC2(b)** |
| 11d | **`CMD ["npm","build"]`** — in `package.json.scripts`, but npm answers `Unknown command` | **AC2(b)** |
| 12 | assertion drops `/app/docker/bootstrap.mjs` | AC2(c) |
| 13 | assertion weakens to `test -r` only (a dir or empty file would pass) | AC2(c) |
| 13b | **assertion reverts to the `&&` AND-OR form** — the §2a-bis shape that cannot fail | **AC2(c)** |
| 14 | **insert `RUN rm /app/docker/entrypoint.sh` AFTER the assertion** | **AC2(d)** |
| 14c | **`ENV PATH=/nope` after the assertion** — green build, dead boot (`entrypoint.sh:5` resolves `node` via PATH) | **AC2(d)** |
| 14b | **append `&& rm /app/docker/entrypoint.sh` INSIDE the assertion instruction** | **AC2(c)** |
| 15 | `ENTRYPOINT` → `/app/scripts/railway-start.sh` — tracked and corresponds, but unasserted | AC2(e) |
| 16 | assertion AND `ENTRYPOINT` both → `/app/docker/nope.sh` | AC2(f) |
| 17 | restore the "NOT wired into the Railway deploy path" sentence | AC3(a) |
| 18 | header reads "Railway never builds this Dockerfile" — false, contains "Railway" | AC3(b) |
| 19 | **delete `deploy.startCommand` from `railway.json`** | **AC3(c)** |
| 19b | **`startCommand: "true"`** — non-empty, overrides the entrypoint, exits immediately | **AC3(c)** |
| 20 | prepend a `` # escape=` `` parser directive — it changes what a backslash MEANS | parse test |
| 21 | an instruction before the first `FROM` (only a global `ARG` is legal there) | parse test |
| 22 | `COPY --from=2` — a numeric stage reference that cannot be statically resolved | AC1(c)+(f) |
| 23 | **`node /app/docker/bootstrap.mjs?typo` in `docker/entrypoint.sh`** — the valid-PREFIX case | **AC2(c)** |

Every row must redden the criterion NAMED — not merely something — and all 30 were **run**, not
narrated. *These are unit-guard mutations; several would also fail AC4/AC5, which are manual.*

⚠️ **Where isolation does NOT hold, stated rather than smoothed over.** Four rows (8, 9, 10, 15) also
trip AC2(c), because the boot-chain expectation is DERIVED from the `ENTRYPOINT` by design — breaking
the entrypoint necessarily breaks the derivation. Row 22 trips AC1(c) as well as (f). Rows 20/21 make
the parse fail, which reddens the parse test and every test downstream of it by construction. In all
of these the NAMED criterion is among the reddened; none is a case where the criterion under test
stayed green.

⚠️ **Row 23 SURVIVED on first run, and that is the point of running them.** `…/bootstrap.mjs?typo`
yielded the valid PREFIX `/app/docker/bootstrap.mjs`, so the assertion covered a path node never
requests and the guard reported everything fine. Closed by requiring a shell word boundary after the
path. ⚠️ **Rows 20 and 21 first came back `REFUSING — ZERO tests ran`**: the parser threw at module
scope, so vitest collected nothing, and zero-tests-ran is indistinguishable from all-green. A parse
failure is now a red TEST rather than a collection error.

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| The boot chain is absent; the build goes green and the container dies at boot | **fail-open introduced by this very change** | §2a's terminal assertion over both files, pinned by AC2(c)+(d), mutations 12–14 |
| `CMD` is dropped and the container exits 0 at boot, silently | same outcome, no error anywhere (§0e) | AC2(b), mutation 11 |
| `deploy.startCommand` is removed and §0c/§6 quietly become false | the release rationale evaporates unobserved | AC3(c), mutation 19 |
| **Dropping the static `.dockerignore` leg trades pre-merge detection for at-Railway-build detection** | a PR adding `docker/` to `.dockerignore` passes ALL CI (this repo runs no docker build in CI), merges, and fails the Railway build — verbatim the incident class in this spec's own motivation table | Accepted, and it is **not a regression**: today's line 35 fails that same Railway build the same way. A third option was considered and declined — a battle-tested matcher library (`@balena/dockerignore`) is not hand-rolling — because a new production dependency to guard a one-line risk is out of proportion to this slice |
| The guard reads the Dockerfile as prose | a guard with no failure mode is ceremony | it must parse stages and instructions; all 19 mutations must redden the NAMED criterion |
| Railway builds a different Dockerfile, or a dashboard-set `--target`/start command diverges from the repo | the guard watches the wrong file | out of a repo guard's reach by construction; stated in AC3's limit; the build logs name these stages (`build`, `runner`) verbatim |
| Someone reads this as "the flake is fixed" | a false claim in the map | §0b states the limit AND the monotone claim; the PR body must repeat both |

## 6. Release condition

**No staging gate — and the round-0 reason for that was false.** I wrote that the slice "does not
change what the runtime contains." It does: `/usr/local/bin/entrypoint.sh` is gone and the `ENTRYPOINT`
is different. What is actually true is narrower, and it is enough:

- **Railway's runtime process is unchanged**, because `startCommand` overrides the image entrypoint
  (§0c) — so the production path does not execute the thing this slice changes. *Pinned by AC3(c),
  because otherwise this bullet is prose that a one-line edit to `railway.json` can falsify.*
- **Local compose is the path whose behaviour changes**, and AC4 exercises exactly that in a real
  container, including the stop path.
- **One staging build could not demonstrate the absence of a stochastic flake anyway**, so invoking the
  gate here would spend it on a question it cannot answer.

A risk-based boundary, not an erosion of the gate DOCKERPROD-1 genuinely needs. Post-merge, the normal
Railway deploy verification applies.

## 7. AC4, as observed

Run against the real image built from this branch (`docker compose build app`, exit 0), on a real
Postgres. Every line is a reading, not a claim.

| # | observable | result |
|---|---|---|
| 1 | `docker compose build app` | **exit 0**; the runner stage is now 2 steps and **reads nothing from the context** — `#12 COPY --from=build /app ./`, `#13 RUN set -eu; …` |
| 2 | `docker inspect -f '{{.Config.Entrypoint}} {{.Config.Cmd}}'` | `[/bin/sh /app/docker/entrypoint.sh]  [npm start]` |
| 2b | the deleted copy is gone; the boot chain is present | `/usr/local/bin/entrypoint.sh`: **No such file or directory**; `/app/docker/entrypoint.sh` (665 b) and `/app/docker/bootstrap.mjs` (16,295 b) both `-rwxr-xr-x` |
| 3 | booted THROUGH `entrypoint.sh` | `docker compose logs app` opens with bootstrap's own lines — `▶ generated AUTH_SECRET + SECRETS_KEY`, `▶ waiting for postgres…`, `▶ loading schema…` |
| 4 | `curl -fsS http://localhost:3199/login` | **exit 0** |
| 5 | `cat /proc/1/cmdline` | `npm start` — confirming §2a's correction: **npm** is PID 1, not Next |
| 6 | stop | exit **1** @ **1s** (NEW) vs exit **1** @ **2s** (OLD bare path) — unchanged, and far under the 10s grace |

**And the empty-`CMD` fail-open reproduced in a real container** — first by accident, because a compose
`entrypoint:` override silently clears the image's `CMD`, then deliberately:

| run | result |
|---|---|
| image defaults (`ENTRYPOINT` + `CMD`) | `Running=true` |
| `CMD` removed | `Running=false`, **`ExitCode=0`**, last log line is the success banner's rule — **no error anywhere** |

That is AC2(b)'s failure mode, observed rather than argued: a container that prints a login URL and a
password, then exits successfully having served nothing.

### AC5 — the negative controls, against the SHIPPED assertion

| build | expected | result |
|---|---|---|
| `entrypoint.sh` missing | FAIL | **FAILED** |
| `bootstrap.mjs` missing | FAIL | **FAILED** |
| `bootstrap.mjs` present but **0 bytes** | FAIL | **FAILED** — `boot chain: /app/docker/bootstrap.mjs is empty` |
| `entrypoint.sh` is a **directory** | FAIL | **FAILED** |
| both present and valid (positive control) | PASS | **PASSED** |

`-f` and `-s` were each observed firing with their own message. ⚠️ **`-r` was NOT, and cannot be:**
the build runs as root, where `access(2)` grants read regardless of mode — measured, `test -r` passes
on a `chmod 000` file as root. It stays as belt, labelled untestable in this context rather than
claimed live. *(An earlier draft of this line said "so `-s` and `-r` are live" — a leg no row
exercises. That is the sweeping-claim habit this section exists to check, caught by the diff review.)*

Against the FIRST version of the assertion, rows 1-4 all **PASSED** the build.

**Code is written. AC1–AC3 are guarded in `test/guards/dockerfile-runner-stage.test.ts`; AC4 and AC5
are the tables above.**
