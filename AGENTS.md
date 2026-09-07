<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Anthropic coding authentication

Never use an Anthropic API key for coding. Always use Claude through subscription-authenticated access, including delegated coding and builder fallbacks. If subscription access is unavailable or reaches a limit, do not switch to API-key billing; use an authorized alternative builder or report the blocker.
