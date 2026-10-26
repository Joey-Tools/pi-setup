---
name: cursor-orchestration
description: Orchestrate coding work through persistent named Cursor workers (cursor_worker tool) - scout, implement, test, review - while Pi keeps planning and final synthesis. Use when delegating multi-step code exploration, implementation, testing, or review to Cursor.
---

# Cursor orchestration

You plan, decide, and synthesize. Cursor workers do the expensive hands-on work. Each worker is a named, persistent Cursor agent with its own conversation; it cannot see the Pi conversation.

## Roles (one worker name each)

- `scout` (mode `ask`): map the relevant code, return paths, key facts, and risks. No edits.
- `impl` (mode `agent`): implement a specified change, run the build and the relevant tests.
- `tests` (mode `agent`): add or run tests and report the real output.
- `review` (mode `ask`): review the diff against the requirements; list concrete defects.

Send follow-ups to the same name to reuse its context (omit `cwd`; the worker keeps its first one). Use new names for independent threads.

## Handoffs

Every task must be self-contained: goal, relevant paths, constraints, acceptance criteria, which commands/tests to run, and what to report. Paste the facts a worker needs from other workers' results; do not refer to "the previous discussion".

## Concurrency

- Distinct workers may run in parallel; one worker runs one task at a time.
- Never let two writing workers share one checkout. Give each concurrent writer its own git worktree via `cwd` (create it yourself or ask the user). A worker's cwd is fixed after its first run.
- Workers must not commit, push, or create worktrees unless the user asked for it.

## Verify

- A finished run (`end_turn`) only means the turn ended; Cursor reports some errors as plain text and marks failed tools `completed`. Check key claims yourself (read the diff, rerun a test) before reporting them.
- A failed, cancelled, or timed-out run may have left partial edits; inspect before retrying. Failed prompts are never resent automatically.
- Large results are truncated; read the referenced `result.md` when you need the full text.

## Limitations

- `ask`/`plan` modes are behavioral, not an OS sandbox. The permission policy only gates actions Cursor asks about; reads, in-workspace edits, and allowlisted commands can run without asking.
- By default (`review`), your current Pi model reviews each permission request Cursor sends, seeing only the task and that request. It approves routine task-scoped actions once and escalates risky or unclear ones to the user (rejected without a UI). The run result reports review counts and the event log path. If a worker reports a rejected command it needed, ask the user instead of re-sending the task to get around the review.
- Each review is an extra Pi model call; its usage is included in the `cursor_worker` result.
- Setting the profile also changes the user's interactive Cursor CLI default model.
- Cursor usage and cost are not included in Pi's totals.
- `/tree` and `/fork` cannot rewind a worker's remote state; a new Pi session gets fresh workers.
- A task running when Pi exits is lost; the session resumes, but the task must be re-sent deliberately.
