# Permission review: models, agents, and context

This document describes the implemented approval path. For setup and the history commands, see the [README](../README.md#permissions-not-a-sandbox).

## Roles and model selection

| Role | Model selection | Lifetime and budget |
|---|---|---|
| Cursor worker | Defaults to `claude-opus-5-5`, with `context=1m`, effort at least `high`, and `fast=false` | A persistent, named Cursor ACP session. The required profile is set and verified before every delegated prompt. |
| Permission reviewer | Pi's active `ctx.model`, captured when a `cursor_worker` run starts | A separate, tool-free request for each permission decision that needs model review. No hardcoded Pi model or provider. |
| Second opinion | The same selected Pi model | At most one extra request, only after a valid first answer of `ask` (uncertain). It is not an independent agent. |

**Opus is not approving its own actions.** Cursor does the work; the selected Pi model reviews the requests Cursor sends. The design has been exercised with GPT-6.1 Sol, but does not depend on that model. If you select GPT-6 Astra in Pi, subsequent worker runs capture Astra as their reviewer. Changing Pi's model during an existing run does not replace that run's captured reviewer.

History records the configured reviewer as `provider/model`. This identifies the requested selection, not independently verified physical routing inside a provider.

### Reasoning and output budgets

- First pass: reasoning capped at `low`; a Pi level of `minimal` remains `minimal`.
- Second opinion: one step more reasoning, at most `medium` (`minimal` to `low`, or `low` to `medium`).
- If Pi's thinking is off, or the model does not reason, no extra reasoning level is explicitly requested.
- Each call receives `maxTokens: 4096`. Provider adapters determine how that option maps to their output and thinking budgets.
- Both passes share one model-review deadline: **45 seconds by default**, configurable with `PI_CURSOR_REVIEW_TIMEOUT_SECONDS` from 1 to 120 seconds.
- The main orchestrator's higher thinking setting is not copied unchanged into every permission review.

The reviewer uses `ctx.modelRegistry.streamSimple(...).result()`. It has no tools, cannot execute code, cannot inspect files, cannot browse the web, and cannot recursively call `cursor_worker`.

## Decision flow

1. **Question and protocol guards:** ambiguous permission options, question-shaped requests, and `cursor/ask_question` are not answered as tool approvals. Rules cannot override these guards.
2. **Exact user rules:** applicable `/approvals` rules are checked before model review. Block rules win. An allow rule can authorize the exact action without a model call; it never overrides `PI_CURSOR_PERMISSIONS=deny`.
3. **First model review:** only a normal, strictly parsed response can approve. A first explicit `deny` is final.
4. **Second opinion:** only a valid first `ask` gets one more review. It receives the same request and scope, plus the first uncertainty reason as untrusted data. It gets more reasoning effort, not new evidence.
5. **Final answer:** an explicit approval permits `allow_once`. Denial, unresolved uncertainty, missing model, malformed response, incomplete or oversized input, API failure, timeout, or cancellation blocks the request. Default `review` never opens a human permission dialog.
6. **Persistence and delivery checks:** the intended decision is recorded, and the final run identity is checked before preparing the response. A reply record is written before handing the answer to ACP. Failed history writes withdraw an approval; ended or cancelled runs cannot receive a late approval.

The internal model answer is exactly:

```json
{"decision":"approve","reason":"Routine task-scoped validation."}
```

The other valid decisions are `deny` and `ask`; the reason must be nonempty and at most 300 characters. `ask` is an internal uncertainty label, **not an instruction to interrupt the user**. Markdown, extra fields, tool calls, errors, and truncated responses do not authorize an operation. Failures do not trigger repeated attempts until a model approves.

The old interactive behavior is available only through the explicit `PI_CURSOR_PERMISSIONS=ask` setting. Existing exact allow rules also skip that mode's dialog; question guards and block rules still apply.

## What the reviewer receives

Every call has a fixed system-policy prompt and one constructed user-message packet. It does not inherit the orchestrator's complete transcript.

### Trusted policy and scope

The default `task` profile includes:

- The fixed review policy selected by user-owned `PI_CURSOR_REVIEW_PROFILE` configuration.
- The fixed constraints Pi gave the worker.
- The canonical worker cwd, which defines the workspace.
- The current run's private scratch directory, created and named by Pi.
- Pi's state-directory location, so requests to alter the approval control plane can be rejected.
- A bounded extraction of the user's own recent messages from the active Pi session branch.

The adapter, not the worker or tool arguments, supplies these facts. A path or claim inside a command does not become trusted merely by calling itself a scratch directory or saying that the user approved it.

### Recent user intent

The adapter reads `ctx.sessionManager.getBranch()` and extracts only message entries whose role is `user`.

- Up to **six recent whole messages**, totaling at most **8,000 characters**, are kept.
- Newest messages are selected first, then presented in chronological order with timestamps when available.
- Messages are never shortened in a way that could drop a constraint. If the newest message alone exceeds the budget, no user messages are included.
- Assistant, tool-result, custom, and summary entries are excluded.
- Attached images are not supplied to the reviewer; their omission is noted.
- Old, unrelated, superseded, ambiguous, or omitted instructions do not grant authority.

This allows a clear recent request such as "push this branch and open a PR" to authorize that scoped git operation without reconfirmation. A worker's claim that the user asked for a push is not equivalent to an actual user message. Missing context is not reconstructed or treated as consent.

### Untrusted request data

Inside an explicitly untrusted request block, Pi supplies:

- The full delegated task text.
- Worker name, cwd, and execution mode.
- The complete ACP `toolCall` supplied by Cursor: title, kind, `rawInput` (including a command when present), content, supplied code or diffs, and locations.
- The permission options Cursor offered.
- On a second pass only, the first review's uncertainty reason.

The reviewer must judge the complete command, including quoting, flags, redirections, paths, and all parts of a compound command. Text in the task, source, diff, or command is data, not a way to rewrite the fixed policy.

"Complete" means the fields Cursor actually sent. Pi does not independently recover omitted source files, command output, or hidden effects of a program.

### Context-size limit

The constructed **user-message packet** is capped at **32,000 characters after escaping**. It includes the constraints, scope, recent user text, request JSON, and any prior uncertainty reason. The fixed **system-policy text is additional**.

This is a character limit, not a token count, not the model's total context window, and not the Cursor worker's 1M context setting. If the request cannot fit completely, it is blocked rather than approved using truncated data.

## What is not provided

The reviewer does not receive:

- Pi's entire conversation or hidden reasoning.
- Earlier assistant explanations or design proposals, except insofar as the delegated task describes the work; that task remains untrusted as an authority source.
- The Cursor worker's conversation or private reasoning.
- The whole repository, arbitrary file contents, or command stdout.
- The complete history of tool calls or permission decisions.
- Attached images.

There is no investigative subagent reading the repository on behalf of the reviewer. The second pass is the same model with the same available facts and more reasoning effort. This can cause a legitimate operation to be blocked when the supplied evidence is insufficient.

## Profiles, rules, and retrospective corrections

`PI_CURSOR_REVIEW_PROFILE=task` is the default. It supports routine local development, project-code validation, controlled backup/restore work, and operations confined to the current run's managed scratch directory. Clear recent user intent can authorize scoped git operations. Secrets, exfiltration, safeguard bypasses, and worker edits to Pi's approval state remain prohibited by its policy.

`PI_CURSOR_REVIEW_PROFILE=conservative` retains the original stricter fixed policy and request format. It receives no separate trusted user-intent or scratch-scope section. Its old policy text still uses the phrase "a human decides", but an unresolved `ask` is blocked under `review`, not forwarded to a human.

Your corrections through `/approvals` create **exact rules**, not model training or automatic generalization:

- Allow once, allow for the exact task, allow for the project, or block the exact action for the project.
- Match the canonical request with only ephemeral `toolCallId` and `status` removed, plus cwd and mode. Commands, quotes, flags, and payloads stay exact.
- Block wins over allow; once-rules are atomically claimed; rules can be revoked.
- Rule changes require a user-initiated interactive TUI flow showing the full request and confirming its scope. There is no model-callable rule-mutation tool.
- A rule is bound to the displayed request snapshot. A changed, corrupt, incomplete, or question-shaped request cannot silently acquire an allowance.
- Viewing or changing history never executes, replays, or undoes a command. Resume work explicitly after changing a rule if you want another attempt.

See the [approval-history guide](../README.md#approval-history-approvals) for commands, storage, and recovery of unreadable rules.

## Audit, accounting, and boundaries

Private per-project history lives under the configured state directory, outside the repo, with directories `0700` and files `0600`. It distinguishes:

1. **Intended decision** — what a model, rule, or policy decided.
2. **Prepared ACP reply** — the `allow_once`, rejection, or cancellation prepared for Cursor. No reply record means it is not known to have been sent.
3. **Cursor-reported status** — evidence only, not proof the action executed or succeeded.
4. **Cursor-observed, not Pi-reviewed actions** — actions Cursor reported without asking Pi. Pi does not retroactively control them, and its history UI offers no overrides for them.

Reported reviewer usage from both passes is included in the tool result and Pi's totals, including failed reviews when usage arrives before the run finishes. Usage reported only after completion cannot be added retroactively. Cursor's own usage remains separate and unreported by this bridge.

Native Cursor Auto-review is not the Pi reviewer. In the inspected Cursor CLI 2026.10.22 build, native Auto-review is not wired into ACP; setting it affects the standalone CLI, not this model-review path. File reads, in-workspace edits, and allowlisted actions can still run without a permission request.

**This is model judgment, not a sandbox or proof of safety.** A model can misunderstand a command. A same-user process can also modify ordinary state files outside Pi's review path. The default promises no automatic human permission dialogs, not automatic success: unresolved operations are blocked and reported. Setup/authentication failures, including a locked macOS keychain, remain errors.

## Activating updates

After updating the core `.mjs` modules, fully exit and restart Pi. An already-running process can retain cached helper-module exports across `/reload`, producing an old behavior or a missing-export error even though a fresh process loads correctly. `/reload` is useful for ordinary extension/prompt changes, but a full restart is the reliable upgrade path for this release.

## Implementation references

- [`extensions/cursor.ts`](../extensions/cursor.ts): captures the active model and user messages and wires the reviewer to a worker run.
- [`lib/permission-review.mjs`](../lib/permission-review.mjs): profiles, packet construction, validation, reasoning budgets, and model-call adapter.
- [`lib/worker-manager.mjs`](../lib/worker-manager.mjs): guards, rule matching, bounded second opinion, deadline, accounting, and final response checks.
- [`lib/approvals.mjs`](../lib/approvals.mjs): private history, exact rules, atomic claims, and reply records.
- [`lib/approval-history.mjs`](../lib/approval-history.mjs): user-initiated history and rule-management flow.
