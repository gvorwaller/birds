## MANDATORY: Use td for Task Management

You must run td usage --new-session at conversation start (or after /clear) to see current work.
Use td usage -q for subsequent reads.

## Claude Relay Protocol & Peer Directory (AGY)

When sending review requests or messages to peer agents over `claude-relay`:
- Fast CLI helper: `node /Users/gaylonvorwaller/claude-relay/scripts/relay-send.js --to <PEER> --msg "<PROMPT>" [--wait] [--timeout 300]`
- Relay server is at `ws://localhost:9999`. AGY owner secret is at `/Users/gaylonvorwaller/claude-relay/sessions/owners/AGY.secret`.
- Active Peer Directory for `~/birds`:
  - **CODEX / CODEX1**: Maps to `CODEX13` (active Codex session in `~/birds`). Sending directly to `CODEX13` automatically launches a headless Codex review delegate in `~/birds`.
  - **CC1**: Claude Code controller session in `~/birds` (wakes via its Stop hook).
  - **GROK**: Grok session in `~/birds`.
- Review permissions: CODEX may review and commit its own fixes; GROK and AGY provide findings only.
