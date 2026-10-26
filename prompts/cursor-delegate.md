---
description: Plan a task, then delegate scouting, implementation, tests, and review to Cursor workers
argument-hint: "<task>"
---
Orchestrate this task using the cursor_worker tool and the cursor-orchestration skill: $@

1. Plan briefly. Decide what to delegate and which worker names to use.
2. Scout with a read-only worker (mode ask) if the relevant code is not already clear.
3. Delegate implementation with a self-contained handoff that names the acceptance criteria and the tests to run.
4. Have a separate worker (mode ask) review the result against the requirements; send concrete fixes back to the implementer.
5. Verify key claims yourself, then give the final summary: what changed, test results, open risks.

Do not commit or push unless I ask.
