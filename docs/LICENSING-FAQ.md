# Licensing FAQ

AIOS Team Brain is licensed under the **GNU AGPL v3.0** (`AGPL-3.0-only`). The connector
and graph-deployment directories are **Apache-2.0**. Both are OSI-approved open source licenses.

This page answers the questions people actually ask. If yours isn't here, email
**cn@fluora.ai** — we'd rather answer it than have you guess.

---

### Can I use AIOS inside my company for free?

**Yes. Unrestricted.**

The AGPL creates no obligation for internal use. Any number of employees, any number of
instances, modified as much as you like. You don't owe anyone source code, notification,
or money. This does not change and is not a trial.

---

### Do I have to publish anything if I self-host AIOS?

**No** — not unless you do two things together: *modify* AIOS, *and* offer network access
to your modified version to third parties.

Running it unmodified publishes nothing. Modifying it for internal use publishes nothing.
Only "modified **and** offered to outsiders as a service" triggers the obligation.

---

### Does AGPL affect my other software that talks to AIOS over its API?

**No.**

The AGPL reaches code that is combined into the same program. Separate services
communicating over a network are ordinarily not combined into the same program, and an
HTTP API caller is the clearest case of it. Your application can
call the AIOS API, store its results, and build on them, and its license is entirely your
own business.

This is the question that generates the most unnecessary fear about the AGPL, so to be
concrete: if you run AIOS and your internal tools query it over HTTP, nothing about the
AGPL touches those tools.

---

### What exactly do I owe if I do modify it and host it for others?

**The source of your modified AIOS, offered to the users of that service.** That's it.

Not your infrastructure. Not your Terraform, Kubernetes manifests, or deployment scripts.
Not your other services, even ones that talk to AIOS. Not your data, your prompts, or
your configuration. The obligation is scoped to the AIOS source you changed, offered to
the people using your hosted version of it.

---

### My company bans AGPL. What now?

**Email cn@fluora.ai and we'll give you a free commercial license for internal use.**

No charge, no seat count, no expiry, no sales call. See
[`COMMERCIAL-LICENSE.md`](../COMMERCIAL-LICENSE.md).

A blanket AGPL ban is usually a policy about license text rather than about what you
intend to do with the software. We'd rather remove the blocker than lose the conversation
over it.

---

### What about the older MIT versions?

**They remain MIT. Permanently.**

The relicense is going-forward only. Every release published under MIT stays available
under MIT — we haven't retracted anything, and we can't. The MIT text is preserved in
[`LICENSE-MIT`](../LICENSE-MIT), including the original copyright notice.

---

### Why did you change?

**Straight answer: AIOS is self-hostable and our business is hosting it.**

The AGPL keeps someone else from taking AIOS, running it as a paid hosted service, and
contributing nothing back. MIT allowed that; the AGPL doesn't.

That's the whole reason. It isn't about restricting users — internal use was free under
MIT and is free under the AGPL, and we've added a free commercial license so that even an
AGPL policy ban doesn't block you. It's about the one specific case of a competitor
selling hosted AIOS.

We picked the AGPL over a source-available license (BUSL, SSPL, Elastic) deliberately.
Those aren't open source. The AGPL is OSI-approved and is listed by the FSF as a free software
license, and we wanted to
keep being able to say "open source" and have it be true.

---

### Which parts are Apache-2.0, and why?

`ingestion/` (the connector sidecar) and `graphiti/` (deployment and patches for the
graph engine).

Both are meant to end up inside someone else's system, and copyleft would defeat that.
`graphiti/` has a second reason: its patches modify `graphiti_core`, which is Apache-2.0
upstream, and matching the license is what lets us contribute them back.

The design system and SDK packages in our other repositories are Apache-2.0 for the same
reason — we want them embedded everywhere, with no strings.

---

### Can I fork it?

Yes. It's open source. Fork it, modify it, run it, redistribute it — under the AGPL's
terms, which mainly means keeping it open and passing along the same freedoms.

---

### Is there a CLA?

Not currently. There's no legal entity yet to be the counterparty. One will be introduced
once our company is formed, and contributors will be asked to sign at that point. See
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

---

### Who holds the copyright?

Chetan Nandakumar and John Ellison, as individuals. It will be assigned to a company once
one exists.
