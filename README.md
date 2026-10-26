# pi-cursor-workers

A small Pi package. Pi (your orchestrator model) plans and synthesizes, and persistent, named Cursor agents do the expensive exploration, implementation, testing, and review. Workers run through the native Cursor CLI (`agent acp`, JSON-RPC over stdio) on your Cursor subscription. There are no nested Pi calls and no API proxy. Everything is local: child processes of Pi on this machine, with no remote service, no daemon, and no network listener.

It contains:

- `cursor_worker` tool with `run`, `list`, and `close` actions.
- `/cursor-workers` command that lists live and saved workers without calling a model (`/cursor-workers close <name>` releases one).
- `cursor-orchestration` skill covering the scout/implement/test/review pattern.
- `/cursor-delegate <task>` prompt template.
- A dependency-free core in `lib/` (ACP client, profile enforcement, worker manager, private state).

## Requirements

- Node.js >= 22.19
- Pi >= 1.4
- Cursor CLI (`agent`) installed and logged in (`agent login`). This package never reads or stores Cursor credentials.

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
- Cursor persists the selection to its own CLI config (`selectedModel`, `modelParameters`, `maxMode` in `~/.cursor/cli-config.json`, or wherever `CURSOR_CONFIG_DIR` points). That changes your interactive `agent` default to this profile.
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
| `PI_CURSOR_PERMISSIONS` | `ask` | `ask`, `allow`, or `deny` |
| `PI_CURSOR_STATE_DIR` | `~/.pi/agent/cursor-workers` | private state and artifacts (follows `PI_CODING_AGENT_DIR`) |
| `PI_CURSOR_MAX_WORKERS` | `4` | live worker processes; idle ones are released first |
| `PI_CURSOR_RESULT_CHARS` | `12000` | model-facing result cap |
| `PI_CURSOR_TIMEOUT_SECONDS` | `1800` | default per-run timeout |

The package never adds `--force`, `--yolo`, or `--approve-mcps`. **Warning:** putting `--force` in `PI_CURSOR_ARGS` makes Cursor run everything without asking.

## Permissions (not a sandbox)

The policy only answers the `session/request_permission` requests Cursor chooses to send. These typically cover shell commands not on your Cursor allowlist, writes outside the workspace or to protected files, deletes, and MCP calls. **Many actions never produce a request and run under every policy, including `deny` and no-UI modes.** Examples are file reads, edits inside the workspace, commands and paths already on your Cursor allowlist, and web fetch or search that Cursor auto-approves.

- `ask` (default): requests go to `ctx.ui.confirm` with the tool title, kind, paths, and input, when Pi has a dialog UI. In print, JSON, or other no-UI modes they are rejected.
- `allow`: requests are approved without asking. Use it for unattended runs and accept the trade-off.
- `deny`: requests are rejected.

Approvals only ever select `allow_once`, never `allow_always`, because `allow_always` would write to your Cursor allowlist. Cursor reuses permission requests as a fallback for questions, with each answer offered as an "allow" option. So `cursor/ask_question` is always declined, and any question-shaped or ambiguous request (an `__ask_question_skip__` option, a tool call id ending in `_qN`, several `allow_once` options, or unknown option kinds) is cancelled without asking. The client advertises no fs or terminal capabilities, and other unknown agent requests get `-32601`.

`ask` and `plan` modes are Cursor behavior modes, **not enforcement**: nothing at the OS level stops writes. This package provides no security isolation.

## Sessions and persistence

- Records live in `<state>/<project-hash>/<pi-session-id>/workers/<name>.json`: one file per worker, written atomically, directories `0700` and files `0600`. Nothing is written to the repo.
- A new Cursor session id is saved **before** the first prompt. After a Pi restart or `/resume`, the worker reconnects with `session/load`, and history replayed during load is excluded from results. If load fails, or the agent lacks `loadSession`, the run errors out. A fresh session is never silently substituted.
- `close` releases the process and keeps the record for resume. `close` with `forget: true` deletes only the local name-to-session record, so the next run with that name starts a new Cursor session. Cursor's own stored history and the local run artifacts are not deleted.
- Independent Pi sessions get independent workers. `/new`, `/fork`, and `/clone` create a new Pi session id and therefore fresh workers. `/tree` cannot rewind a worker's remote state.
- A worker keeps its first `cwd`. Omit `cwd` on follow-ups; passing a different one is an error.
- There is no daemon. On Pi shutdown, in-flight runs are cancelled and workers are terminated, and a task running at that moment is lost. If Pi is killed hard (SIGKILL), the exit hook cannot run, and a worker (in its own process group) may outlive Pi; it is not known whether Cursor's ACP exits on stdin EOF. The session can be resumed, but tasks are never re-sent automatically, and failed prompts are not retried.

## Timeouts and cancellation

`timeoutSeconds` (default 1800) and Pi's abort cover the whole run: process start, `initialize`, `session/new` or `session/load`, mode and profile setup, permission dialogs, and the prompt. If a run is interrupted before the prompt is sent, no task is started and the half-configured process is killed. During a prompt, the client sends `session/cancel`. If the agent doesn't stop within 12 seconds (Cursor waits up to 10 for subagents), its process group is killed and the worker is not reused.

## Output and success

Each run writes `runs/<timestamp>-<name>-<id>/events.jsonl` (the full ACP traffic) and `result.md` (the full assistant text) under the state dir. If the disk falls more than 16 MiB behind, or a write fails, further artifact output is dropped and the result says so. Only live assistant message chunks become the result; thinking, tool output, and replayed history do not. The model sees a capped head and tail plus the path to the full result. Streaming updates and `details` carry only counts and status.

**`stopReason=end_turn` only means the turn ended. It does not prove the task succeeded.**
- Cursor reports many failures as assistant text with `end_turn`. A reply that consists only of `Error: …`, a sign-in prompt, or an empty-prompt notice is treated as a failure, and a reply ending with an `Error:` paragraph gets a warning. Other failures can still appear as ordinary text.
- Cursor marks tool calls `completed` even when they failed or were rejected.
- The orchestrator should check the reply, the diffs, and the test output.
- API or protocol errors, a stop reason other than `end_turn`, timeouts, and cancellations are reported as failures.
- Cursor usage and cost are not reported by ACP, so **Pi's totals exclude Cursor usage**.

## Known limitations

- In `plan` mode, Cursor's `cursor/create_plan` request gets `-32601`, which Cursor treats as accepted. It may then write a local plan file, and the plan content appears only in `events.jsonl`.
- ACP messages over 32 MiB (for example a huge replayed tool output during `session/load`) kill the worker. It fails closed and the session stays resumable.
- Windows has no process-group kill.

## Develop

```bash
npm test            # deterministic tests with a fake ACP agent (offline)
npm run check       # syntax check, no downloads
PI_PACKAGE_DIR=/path/to/node_modules/@earendil-works/pi-coding-agent npm run smoke:extension   # load via Pi's real loader, offline
npm run smoke:live  # opt-in: real Cursor, two turns + session/load resume, ask mode, no edits requested
```

`pi --help` does not run extension factories, so use `smoke:extension` to check that the extension loads.
