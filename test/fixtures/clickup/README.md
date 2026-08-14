# ClickUp fixtures

`synthetic-*.json` exercises task and Docs response shapes without using customer data.

`recorded-probe.redacted.json` preserves only the counts and response-shape facts from the
2026-08-11 credential probe recorded on AIO-819. Workspace identifiers and names are substituted;
the probe did not read task or Doc bodies. No fixture may contain an authorization header, token,
secret, or unredacted customer content.
