# pi-cursor-workers

A small Pi package. Pi (your orchestrator model) plans and synthesizes, and persistent, named Cursor agents do the expensive exploration, implementation, testing, and review. Workers run through the native Cursor CLI (`agent acp`, JSON-RPC over stdio) on your Cursor subscription. There are no nested Pi sessions and no API proxy; the only extra model calls are the optional permission reviews made with Pi's own model. Everything else is local: child processes of Pi on this machine, with no remote service, no daemon, and no network listener.

It contains:

- `cursor_worker` tool with `run`, `list`, and `close` actions.
- `/cursor-workers` command that lists live and saved workers without calling a model (`/cursor-workers close <name>` releases one).
- `cursor-orchestration` skill covering the scout/implement/test/review pattern.
- `/cursor-delegate <task>` prompt template.
- A dependency-free core in `lib/` (ACP client, profile enforcement, permission review, worker manager, private state).

## Requirements

- Node.js >= 22.19
- Pi >= 1.4
- Cursor CLI (`agent`) installed and logged in (`agent login`). The worker bridge uses that existing login without extracting credentials. The optional config helper makes a private backup of the whole CLI config, which may contain credentials.

## Install

Installing is opt-in. Nothing here changes your Pi settings until you run one of these:

```bash
git clone <this-repo-url> pi-cursor-workers      # or use any local checkout
pi install /absolute/path/to/pi-cursor-workers   # personal: ~/.pi/agent/settings.json
pi install --local /absolute/path/to/pi-cursor-workers   # project: .pi/settings.json (needs project trust)
pi -e /absolute/path/to/pi-cursor-workers        # try once without saving
```

Relative local paths in settings resolve from the settings file that contains them, so prefer absolute paths for `--local` installs, or a git source once the repo is published (`pi install git:<host>/<repo>@<tag>`). On another machine, clone the repo and `pi install` its path. No paths or credentials are hard-coded, and there is nothing to `npm install`: the host packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox`) are peer dependencies supplied by Pi.

## Use

Ask Pi to delegate, or run `/cursor-delegate <task>`. The tool's prompt guidelines tell Pi to delegate exploration, implementation, tests, and review, and to keep decisions and the final synthesis itself. Built-in tools are not hidden. For strict orchestration, where Pi can only delegate and read, start Pi with:

```bash
pi --tools cursor_worker,read
```

Tool arguments: `action`, `name` (`[A-Za-z0-9_-]{1,48}`), `task`, optional `cwd`, optional `mode` (`agent`/`plan`/`ask`), optional `timeoutSeconds`, and `forget` for close. There are deliberately no arguments for model, context, effort, fast, or permissions.

## Model profile (fixed, verified before every prompt, fail closed)

| config | value |
|---|---|
| `model` | `claude-opus-5-5` (override with `PI_CURSOR_MODEL`) |
| `context` | `1m` (fixed) |
| `effort` | `high` (`PI_CURSOR_EFFORT` accepts only `high`, `xhigh`, or `max`) |
| `fast` | `false` (fixed) |

How it is enforced:

1. The client sends `initialize` with `clientCapabilities._meta.parameterizedModelPicker: true`. Without this, Cursor's ACP exposes only a limited set of model variants.
2. Before **every** prompt (new, loaded, or reused worker), it sends `session/set_config_option` sequentially for `model`, then `context`, `effort`, and `fast`. All values are strings.
3. It checks the `currentValue`s returned by the last call. A missing option, an unoffered value, a failed call, or a mismatch aborts before the prompt is sent, and the worker process is released. It never falls back to a smaller profile.

The Cursor CLI `--model` flag is ignored by ACP, and the older `session/set_model` canonical variants are not used. An overridden `PI_CURSOR_MODEL` must accept the same mandatory values, or every run fails closed.

**Side effects you should know about:**
- Cursor persists the selection (`selectedModel`, `modelParameters`, `maxMode`) to its own `cli-config.json`: under `CURSOR_CONFIG_DIR`, otherwise `$XDG_CONFIG_HOME/cursor` if set, otherwise `~/.cursor`. That changes your interactive `agent` default to this profile.
- `session/load` restores the session's last-used model, which is why the profile is re-applied after it.
- Profile application is serialized within one Pi process, but separate Pi processes or an interactive `agent` writing that file at the same moment can lose each other's update to the file. The per-session verification still holds.
- Pi's own model is unchanged.

## Configuration (environment, user-owned)

| variable | default | meaning |
|---|---|---|
| `PI_CURSOR_COMMAND` | `agent` | Cursor CLI executable (spawned directly, no shell) |
| `PI_CURSOR_ARGS` | `["acp"]` | JSON array of arguments |
| `PI_CURSOR_MODEL` | `claude-opus-5-5` | model config value |
| `PI_CURSOR_EFFORT` | `high` | `high`, `xhigh`, or `max` |
| `PI_CURSOR_PERMISSIONS` | `review` | `review`, `ask`, `allow`, or `deny` |
| `PI_CURSOR_REVIEW_TIMEOUT_SECONDS` | `45` | per-request deadline for the Pi model review (1-120) |
| `PI_CURSOR_STATE_DIR` | `~/.pi/agent/cursor-workers` | private state and artifacts (follows `PI_CODING_AGENT_DIR`) |
| `PI_CURSOR_MAX_WORKERS` | `4` | live worker processes; idle ones are released first |
| `PI_CURSOR_RESULT_CHARS` | `12000` | model-facing result cap |
| `PI_CURSOR_TIMEOUT_SECONDS` | `1800` | default per-run timeout |

The package never adds `--force`, `--yolo`, or `--approve-mcps`. **Warning:** putting `--force` in `PI_CURSOR_ARGS` makes Cursor run everything without asking.

## Permissions (not a sandbox)

The policy only answers the `session/request_permission` requests Cursor chooses to send. These typically cover shell commands not on your Cursor allowlist, writes outside the workspace or to protected files, deletes, and MCP calls. **Many actions never produce a request and run under every policy, including `deny` and no-UI modes.** Examples are file reads, edits inside the workspace, commands and paths already on your Cursor allowlist, and web fetch or search that Cursor auto-approves.

There are two layers. Cursor decides first: its allowlist, its default read boundary (direct file reads already run without a request), in-workspace edits, and any sandbox settings. Whatever Cursor allows itself never reaches Pi. Requests Cursor does send, including read-only shell commands such as `git status`, are answered by the policy:

- `review` (default): Pi's **currently selected model** reviews each request (see below). It approves routine task-scoped requests once, denies clearly prohibited ones, and escalates the rest to `ctx.ui.confirm`. Without a dialog UI, escalations are rejected.
- `ask`: every request goes to `ctx.ui.confirm` with the tool title, kind, paths, and input, when Pi has a dialog UI. In print, JSON, or other no-UI modes they are rejected.
- `allow`: requests are approved without asking. Use it for unattended runs and accept the trade-off.
- `deny`: requests are rejected.

Set `PI_CURSOR_PERMISSIONS=ask`, `allow`, or `deny` to opt out of review. If Pi loads this package from a local checkout, `/reload` picks up the new default without any settings change. There is no fallback from `review` to a blanket Cursor mode.

Approvals only ever select `allow_once`, never `allow_always`, because `allow_always` would write to your Cursor allowlist. Cursor reuses permission requests as a fallback for questions, with each answer offered as an "allow" option. So `cursor/ask_question` is always declined, and any question-shaped or ambiguous request (an `__ask_question_skip__` option, a tool call id ending in `_qN`, several `allow_once` options, or unknown option kinds) is cancelled under every policy, before any reviewer or dialog sees it. The client advertises no fs or terminal capabilities, and other unknown agent requests get `-32601`.

### Intelligent review (`review` policy)

- **Reviewer:** the active Pi model (`ctx.model`) at the time of the `cursor_worker` call, through `ctx.modelRegistry.streamSimple`. It is one direct request per permission request, with a fixed system policy and a single user message. There are no tools and no Pi conversation history, so the reviewer can't run anything or recurse into `cursor_worker`. Thinking is capped at `low` (off if Pi's thinking is off or the model doesn't reason), and the answer is capped at 4096 tokens. Cursor workers keep their own fixed profile; the reviewer never changes Pi's or Cursor's model.
- **What it sees:** the worker's constraints, the full delegated task, the worker name, cwd and mode, and the complete ACP tool call (title, kind, `rawInput`, content and diffs, locations) and options. All of it is marked as untrusted data, and `<` is escaped so the data can't close its tag. If that context exceeds 32,000 characters, or Cursor sent no command, input, or diff, the model is not called and the request is escalated. The reviewer never decides on truncated data.
- **Policy:** approve only routine, non-destructive, task-scoped work (tests, builds, linters, read-only inspection, ordinary edits inside the cwd). Deny clearly out-of-task or prohibited requests, credential or secret access or exfiltration, and attempts to bypass safeguards. Ask for destructive operations (`rm`, `git reset/clean`, force flags), privilege or system changes, writes outside the cwd, commits, branches, worktrees, pushes or deployments (even when the task asks), spending, network side effects, opaque scripts, and compound or unclear shell commands.
- **Strict answer:** the reply must be exactly `{"decision":"approve"|"deny"|"ask","reason":"..."}` with a non-empty reason of at most 300 characters, from a normal `stop`. Markdown, prose, extra fields, tool calls, refusals, truncation (`length`), errors, and aborts all count as `ask`.
- **Failure handling:** a missing reviewer (no active Pi model), a failed request, or a timeout (`PI_CURSOR_REVIEW_TIMEOUT_SECONDS`, default 45) all become `ask`. That means a human decides, or the request is rejected without a UI. The deadline settles the request even if a provider ignores the abort signal, and a late answer is ignored. The run's timeout, Pi's abort, shutdown, and a dropped worker also abort the review, and no approval is applied after that.
- **Dialogs:** human prompts from all workers in a Pi session are queued one at a time. Model reviews of different workers can run in parallel.
- **Audit:** every decision is logged to the run's `events.jsonl`: the policy, the review decision, its reason, the reviewer `provider/model`, whether it timed out, failed, was skipped (oversized or no details) or aborted, the input size, the duration, the human answer, and the response sent. The prompt itself is not logged. The tool result shows only counts and the log path.
- **Usage:** the reviewer's token usage and cost are summed across all of a run's reviews and returned as the `cursor_worker` tool result `usage`, so they appear in Pi's totals. That includes failed or malformed reviews when the provider reports usage. When a run fails after reviews, the tool returns an error result that keeps that usage. Usage reported only after a run has finished cannot be added retroactively. Each model review is an extra paid call on your Pi provider.

**Model review is judgment, not a safety proof.** A model can misjudge an obfuscated or compound shell command, and nothing here parses shell or sandboxes execution. The reviewer only sees requests Cursor sends, so it adds no protection for actions Cursor runs without asking. A permission request that is still pending when the worker's turn ends (or when the run is cancelled or times out) is cancelled, and no later review or human answer is applied to it.

### Cursor's native Auto-review (optional helper)

`scripts/configure-cursor.mjs` sets Cursor CLI `approvalMode` to `auto-review` in `cli-config.json`, so the standalone interactive `agent` lets Cursor's own classifier approve safe operations:

```bash
node scripts/configure-cursor.mjs           # dry run: shows the config path and current/target value, changes nothing
node scripts/configure-cursor.mjs --apply   # writes approvalMode only, after a private backup
npm run configure:cursor                    # same as the dry run
```

- **Config path:** the helper uses the Cursor CLI's precedence: `$CURSOR_CONFIG_DIR/cli-config.json`, then `$XDG_CONFIG_HOME/cursor/cli-config.json`, then `~/.cursor/cli-config.json`.
- **What it changes:** only `approvalMode`. Every other field (permissions allow/deny lists, sandbox, model, auth) keeps its value; the file is rewritten atomically with its original indentation. It adds no Shell allowlist and never sets `--force` or `--yolo`. It does nothing if the value is already set.
- **Backup:** before writing, the original bytes are copied to `<Pi agent dir>/cursor-config-backups/` (mode `0600`, directory `0700`, follows `PI_CODING_AGENT_DIR`). It refuses a backup directory inside this repo or the Cursor config directory. The backup may contain credentials: keep it local and never commit it.
- **ACP limitation:** in Cursor CLI 2026.10.22, native Auto-review is **not** wired into ACP. `agent acp` ignores `approvalMode: auto-review` (and `--auto-review`) and behaves like `allowlist`, so it does not classify or auto-approve the requests these workers send. Over ACP, the requests that reach Pi are handled by the `review` policy above. Later Cursor versions may change this.
- Auto-review is also a model's judgment; it does not prove arbitrary commands read-only.

`ask` and `plan` modes are Cursor behavior modes, **not enforcement**: nothing at the OS level stops writes. This package provides no security isolation.

## Sessions and persistence

- Records live in `<state>/<project-hash>/<pi-session-id>/workers/<name>.json`: one file per worker, written atomically, directories `0700` and files `0600`. Nothing is written to the repo.
- A new Cursor session id is saved **before** the first prompt. After a Pi restart or `/resume`, the worker reconnects with `session/load`, and history replayed during load is excluded from results. If load fails, or the agent lacks `loadSession`, the run errors out. A fresh session is never silently substituted.
- `close` releases the process and keeps the record for resume. `close` with `forget: true` deletes only the local name-to-session record, so the next run with that name starts a new Cursor session. Cursor's own stored history and the local run artifacts are not deleted.
- Independent Pi sessions get independent workers. `/new`, `/fork`, and `/clone` create a new Pi session id and therefore fresh workers. `/tree` cannot rewind a worker's remote state.
- A worker keeps its first `cwd`. Omit `cwd` on follow-ups; passing a different one is an error.
- There is no daemon. On Pi shutdown, in-flight runs are cancelled and workers are terminated, and a task running at that moment is lost. If Pi is killed hard (SIGKILL), the exit hook cannot run, and a worker (in its own process group) may outlive Pi; it is not known whether Cursor's ACP exits on stdin EOF. The session can be resumed, but tasks are never re-sent automatically, and failed prompts are not retried.

## Timeouts and cancellation

`timeoutSeconds` (default 1800) and Pi's abort cover the whole run: process start, `initialize`, `session/new` or `session/load`, mode and profile setup, permission reviews and dialogs, and the prompt. If a run is interrupted before the prompt is sent, no task is started and the half-configured process is killed. During a prompt, the client sends `session/cancel`. If the agent doesn't stop within 12 seconds (Cursor waits up to 10 for subagents), its process group is killed and the worker is not reused.

## Output and success

Each run writes `runs/<timestamp>-<name>-<id>/events.jsonl` (the full ACP traffic) and `result.md` (the full assistant text) under the state dir. If the disk falls more than 16 MiB behind, or a write fails, further artifact output is dropped and the result says so. Only live assistant message chunks become the result; thinking, tool output, and replayed history do not. The model sees a capped head and tail plus the path to the full result. Streaming updates and `details` carry only counts and status.

**`stopReason=end_turn` only means the turn ended. It does not prove the task succeeded.**
- Cursor reports many failures as assistant text with `end_turn`. A reply that consists only of `Error: …`, a sign-in prompt, or an empty-prompt notice is treated as a failure, and a reply ending with an `Error:` paragraph gets a warning. Other failures can still appear as ordinary text.
- Cursor marks tool calls `completed` even when they failed or were rejected.
- The orchestrator should check the reply, the diffs, and the test output.
- API or protocol errors, a stop reason other than `end_turn`, timeouts, and cancellations are reported as failures.
- Cursor usage and cost are not reported by ACP, so **Pi's totals exclude Cursor usage**. They do include the Pi model's permission reviews (see above).

## Known limitations

- In `plan` mode, Cursor's `cursor/create_plan` request gets `-32601`, which Cursor treats as accepted. It may then write a local plan file, and the plan content appears only in `events.jsonl`.
- ACP messages over 32 MiB (for example a huge replayed tool output during `session/load`) kill the worker. It fails closed and the session stays resumable.
- Windows has no process-group kill.

## Develop

```bash
npm test            # deterministic tests with a fake ACP agent (offline)
npm run check       # syntax check, no downloads
PI_PACKAGE_DIR=/path/to/node_modules/@earendil-works/pi-coding-agent npm run smoke:extension   # load via Pi's real loader, offline, stubbed reviewer model
npm run smoke:live  # opt-in: real Cursor, two turns + session/load resume, ask mode, no edits requested
npm run configure:cursor   # dry run of the native Cursor approvalMode helper (see above)
```

`pi --help` does not run extension factories, so use `smoke:extension` to check that the extension loads.
