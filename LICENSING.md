# Licensing

AIOS Team Brain is open source. The server is under the **GNU Affero General Public
License v3.0 only** (`AGPL-3.0-only`); the pieces meant to be embedded in other people's
systems are under the **Apache License 2.0**.

Both are OSI-approved, and both are listed by the FSF as free software licenses.

Copyright (C) 2026 Chetan Nandakumar and John Ellison.

---

## What is under which license

| Path | License | Why |
| --- | --- | --- |
| `app/`, `lib/`, `components/`, `scripts/`, `postgres/`, `test/`, and everything else not listed below | `AGPL-3.0-only` | This is the server application. It's the thing we host, and the AGPL is what stops someone else selling hosted AIOS without contributing back. |
| `ingestion/` | `Apache-2.0` | A separately packaged connector service (`aios-ingest`) with its own `pyproject.toml`. It reaches the brain only over HTTP and is never imported by the brain's TypeScript. It is meant to run inside other people's systems, so it needs a license that lets it. |
| `graphiti/` | `Apache-2.0` | The `patch-*.py` scripts patch `graphiti_core`, which is Apache-2.0 upstream. Matching that license keeps our patches contributable back; an Apache-2.0 project cannot accept an AGPL contribution. |

Prior releases were published under the MIT License. **They remain MIT** — the change is
going-forward only and takes nothing away. That text is preserved verbatim in
[`LICENSE-MIT`](LICENSE-MIT), including the original copyright notice, as the MIT License
requires.

---

## What this means for you

**Running AIOS inside your company is unrestricted.** The AGPL places no obligation on
internal use, however many people use it, however much you modify it. You do not owe
anyone anything.

**Self-hosting it as-is publishes nothing.** The obligation only arises if you *modify*
AIOS *and* offer network access to your modified version to third parties — and then it
covers your modified AIOS, not your infrastructure, your Terraform, or your other
services.

**Your other software can talk to the AIOS API freely.** The AGPL reaches code combined
into the same program. Separate services communicating over a network ordinarily are
not that, and an HTTP API caller is the clearest case of it.

**If your company's policy bans AGPL**, there is a free-of-charge commercial license for
internal use. See [`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md). An AGPL ban should
never be the reason someone can't try AIOS.

Longer answers: [`docs/LICENSING-FAQ.md`](docs/LICENSING-FAQ.md).

---

## The dependency-direction rule

Two licenses in one org means one rule, and it only runs one way:

> **An Apache-2.0 package must never import from an AGPL-3.0 package.**
> Apache → AGPL is fine. AGPL → Apache is a license violation.

The reason is that the AGPL is contagious across a combined program and Apache-2.0 is
not. An AGPL module pulled into an Apache-2.0 package makes that package's Apache grant
undeliverable — we would be promising permissions on code we cannot grant them for. The
reverse is harmless: AGPL code may absorb Apache-2.0 code, and the result is AGPL.

In practice, for this repository:

- `ingestion/` and `graphiti/` **must not** import from `lib/`, `app/`, `components/`, or
  `scripts/`. Neither does today: `ingestion/` is a separate Python package that speaks
  HTTP, and `graphiti/` is a Dockerfile plus patch scripts against a third-party library.
- The AGPL side may freely use either.

This is enforced by a build-failing guard rather than by memory, because the failure mode
is someone adding one convenient import eighteen months from now and nobody noticing:
[`test/guards/license-import-direction.test.ts`](test/guards/license-import-direction.test.ts),
which runs in CI as part of `npm test`. It also pins the licensing metadata itself, so the
rule cannot go quietly vacuous by a directory ceasing to be Apache-licensed.

The same rule holds across repositories in the `aiosbrain` organization. An Apache-2.0
repo may not depend on an AGPL-3.0 one.

---

## Third-party components

[`NOTICE`](NOTICE) records the third-party components carrying an attribution obligation,
plus plain-language answers on the two that show up in compliance scans:
`@img/sharp-libvips` (LGPL) and `@sentry/cli` (FSL-1.1, source-available and not
OSI-approved). Neither conflicts with the AGPL, and `NOTICE` says exactly why.

FalkorDB (SSPL) is **not** a dependency and is not installed by anything here. It appears
only in design documents, as an option that was evaluated and declined.

---

## Contributing

Contributions are accepted under `AGPL-3.0-only`, or `Apache-2.0` for `ingestion/` and
`graphiti/`. See [`CONTRIBUTING.md`](CONTRIBUTING.md).
