# `td` bug report — handoff/review blocked by orphaned session reference

**Date:** 2026-06-17 14:26 EST
**Tool:** `td v0.47.1`
**Reporter:** Gaylon (via Claude Code session, birds repo)
**Context:** Hit while trying to submit `td-94e0fd` for review after shipping a feature.

---

## Symptom

`td review <id>`, `td handoff <id>`, and `td ws tag <id>` all fail on one task with:

```
ERROR: failed to create handoff for td-94e0fd: constraint failed: FOREIGN KEY constraint failed (787)
```

The task is stuck `in_progress` and cannot be submitted for review. The actual
code/work is unaffected (committed, pushed, deployed, verified) — only the
`td` audit-trail write fails.

## Root cause (hypothesis)

A task got stamped with a **session ID that was never persisted to the sessions
table**. This happens when `td start <id>` runs *before* the session is
registered — i.e. resuming after a context compaction / `/clear` and calling
`td start` without first running `td usage --new-session`.

In this case `td start` assigned session `ses_08c4ec` (printed
`STARTED 94e0fd (session: ses_08c4ec)` and wrote a `logs[]` entry with that
session), but no row for `ses_08c4ec` exists. Any later operation that writes a
child row whose foreign key resolves back to that session — handoff creation,
ws-tag — fails the FK check.

## Why it's sticky

`td stop` + `td start` re-stamps `implementer_session` to a valid session, but
**that alone does not fix it** — so the dangling reference is *not*
`implementer_session`. After stop/start, `implementer_session` was a valid,
registered session (`ses_97d335`) and `td review` *still* failed with the same
FK error. The bad reference is reachable through some other path the CLI doesn't
let you reset, most likely:

- the task's existing `logs[].session` entry (the original "Started work" log
  still points at `ses_08c4ec`), and/or
- the session chain itself — `td whoami` shows `PREVIOUS SESSION: ses_08c4ec`,
  so the *current* session FK-references the orphaned one as its predecessor.

## Reproduction

1. After a `/clear` or context compaction, **don't** run `td usage --new-session`.
2. `td start <some-open-task>` → it stamps an unpersisted session ID and writes
   a log entry referencing it.
3. `td review <task>` (or `td handoff`, or `td ws tag`) →
   `FOREIGN KEY constraint failed (787)`.

## What was tried (all failed identically)

| Attempt | Result |
| --- | --- |
| `td review 94e0fd -m "..."` | FK 787 |
| `td handoff 94e0fd -m "..."` | FK 787 |
| `td usage --new-session` then `td review` | FK 787 (and rotated session identity) |
| `td stop 94e0fd` → `td start 94e0fd` (implementer now valid) → `td review` | FK 787 |
| `td ws start` → `td ws tag 94e0fd` | FK 787 (tag fails too) |

`td v0.47.1` has no `doctor` or `config` subcommand to introspect or repair.

## Suggested fixes (any of)

1. **Best — close the whole class:** make `td start` (and anything that stamps a
   session onto a task) **upsert/persist the session row first**, so a session ID
   can never be referenced before it exists.
2. Have `td stop` / re-stamp also rewrite or null the orphaned `logs[].session`
   references.
3. Add a repair / `td doctor` command that finds and clears dangling session FKs.
4. Make handoff / ws-tag inserts validate-and-skip (or tolerate) unresolvable
   session references instead of hard-failing the FK.

## Side effect worth noting

The only way found to register the session mid-work was `td usage --new-session`,
which **rotates the session identity** — and the CLI itself warns `--new` is
"not mid-work—bypasses review." So the current recovery path forces an action the
tool flags as review-bypassing. A `td session --register`-style no-rotate option
would avoid that.

## Current state of the affected task

- `td-94e0fd` — "Copy calendar date picker from trips" — status `in_progress`,
  implementer `ses_97d335`. Feature is shipped: commit `832fe34`, deployed
  (`db=ok`, `version=832fe34`), browser-verified. Only the `td` review handoff is
  blocked.
