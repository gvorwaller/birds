# Gemini repository instructions

Before diagnosing, editing, testing, reviewing, committing, or deploying in
this repository, read these files completely:

1. [`cs.md`](cs.md) — authoritative project hard rules.
2. [`docs/agent-development-guide.md`](docs/agent-development-guide.md) — the
   canonical coding, test-data safety, UI/UX, verification, and release workflow.
3. The current `td` ticket, relevant specification under `docs/ux/`, and latest
   relevant `docs/devlog/` entry.

Run `td usage --new-session` at the beginning of the conversation. Preserve all
unrelated work and existing test data. Do not commit, push, deploy, run a
backfill, or mutate production data unless the user explicitly requests that
specific action.
