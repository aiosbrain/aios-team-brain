# AIOS is now AGPL-3.0

**This is going-forward only. Every version released before this one remains MIT, forever.
Nothing is being taken away.** If you're running an MIT release today, you can keep running
it under MIT for as long as you like. We couldn't retract that even if we wanted to, and we
don't.

From here on, the AIOS server is licensed under the **GNU AGPL v3.0**.

## Why

AIOS is self-hostable and our business is hosting it. Under MIT, someone could take AIOS,
run it as a paid hosted service, and contribute nothing back. The AGPL stops that. That's
the whole reason — there isn't a second one.

We're saying it plainly because the alternative is a paragraph about "sustainability" and
"community stewardship" that means the same thing while pretending not to.

## What doesn't change

**Running AIOS inside your company is unrestricted.** It was free under MIT and it's free
under the AGPL. Any number of users, any number of instances, modified however you like.
The AGPL creates no obligation for internal use — none.

**Your software can still call the AIOS API.** The AGPL reaches code combined into the same
program, not separate services talking over a network. If your internal tools query AIOS
over HTTP, nothing here touches them.

**Self-hosting unmodified publishes nothing.** The obligation only appears if you modify
AIOS *and* offer your modified version to third parties as a service. Then you owe the
source of your modified AIOS to that service's users — not your infrastructure, not your
Terraform, not your other services.

## If your company bans AGPL

**Email cn@fluora.ai and we'll give you a free commercial license for internal use.** No
charge, no seat count, no expiry, no sales call.

A blanket AGPL ban is usually a policy about license text rather than about what you
actually plan to do. An AGPL ban should never be the reason someone can't try AIOS, so
we've made sure it isn't one.

## The SDKs stay Apache-2.0

Deliberately. The connector sidecar, the Graphiti patches, the design system and SDK
packages are all Apache-2.0 and will stay that way. Those are meant to be embedded in your
software, and copyleft would defeat the point. We want them everywhere, with no strings.

## On calling this open source

The AGPL is OSI-approved and is listed by the FSF as a free software license. It is
open source, and we chose it over
BUSL, SSPL, and the Elastic License specifically because those aren't. We wanted to keep
saying "open source" and have it be true.

## Ask us hard questions

If you think we've got this wrong, or you're stuck on something the license makes awkward,
say so — open an issue or email **cn@fluora.ai**. We'll answer, publicly where it's useful
to others.

Full detail: [LICENSING.md](../../LICENSING.md) ·
[licensing FAQ](../LICENSING-FAQ.md) ·
[commercial licensing](../../COMMERCIAL-LICENSE.md)

---

<!-- Short versions for other channels. Not part of the post. -->

## Short versions

**For X (two sentences):**

> AIOS is now AGPL-3.0. Every prior release stays MIT forever, running it inside your
> company is still completely unrestricted, and if your policy bans AGPL we'll give you a
> free commercial license — just email us.

**For GitHub release notes (three sentences):**

> AIOS is now licensed under the GNU AGPL v3.0. This is going-forward only — every version
> released before this one remains available under MIT, and internal use of AIOS remains
> completely unrestricted, with no obligations of any kind. If your organization's policy
> prohibits AGPL, email cn@fluora.ai for a free commercial license for internal use; the
> SDK and connector packages stay Apache-2.0.
