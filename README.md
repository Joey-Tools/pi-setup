# pi-cursor-workers

A small Pi package. Pi (your orchestrator model) plans and synthesizes, and persistent, named Cursor agents do the expensive exploration, implementation, testing, and review. Workers run through the native Cursor CLI (`agent acp`, JSON-RPC over stdio) on your Cursor subscription. There are no nested Pi sessions and no API proxy; the only extra model calls are the optional permission reviews made with Pi's own model. Everything else is local: child processes of Pi on this machine, with no remote service, no daemon, and no network listener.

It contains:

- `cursor_worker` tool with `run`, `list`, and `close` actions.
- `/cursor-workers` command that lists live and saved workers without calling a model (`/cursor-workers close <name>` releases one).
- `/approvals` command: your private history of Cursor permission decisions, and exact allow/block rules you add from it (see [Approval history](#approval-history-approvals)).
- `cursor-orchestration` skill covering the scout/implement/test/review pattern.
- `/cursor-delegate <task>` prompt template.
- A dependency-free core in `lib/` (ACP client, profile enforcement, permission review, worker manager, private state).
- A separate, independent progress-updates extension with the `/progress` command (see [Progress updates](#progress-updates)).

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

**Upgrading an existing session:** fully exit and restart Pi after updating this package's core `.mjs` files. An already-running process can retain cached helper exports across `/reload`; a full restart is the reliable upgrade path for this release.

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
| `PI_CURSOR_REVIEW_PROFILE` | `task` | reviewer policy under `review`: `task` (task-scoped autonomy) or `conservative` (the original stricter policy) |
| `PI_CURSOR_REVIEW_TIMEOUT_SECONDS` | `45` | per-request deadline for the Pi model review (1-120) |
| `PI_CURSOR_STATE_DIR` | `~/.pi/agent/cursor-workers` | private state and artifacts (follows `PI_CODING_AGENT_DIR`) |
| `PI_CURSOR_MAX_WORKERS` | `4` | live worker processes; idle ones are released first |
| `PI_CURSOR_RESULT_CHARS` | `12000` | model-facing result cap |
| `PI_CURSOR_TIMEOUT_SECONDS` | `1800` | default per-run timeout |

The package never adds `--force`, `--yolo`, or `--approve-mcps`. **Warning:** putting `--force` in `PI_CURSOR_ARGS` makes Cursor run everything without asking.

## Permissions (not a sandbox)

The policy only answers the `session/request_permission` requests Cursor chooses to send. These typically cover shell commands not on your Cursor allowlist, writes outside the workspace or to protected files, deletes, and MCP calls. **Many actions never produce a request and run under every policy, including `deny` and no-UI modes.** Examples are file reads, edits inside the workspace, commands and paths already on your Cursor allowlist, and web fetch or search that Cursor auto-approves.

There are two layers. Cursor decides first: its allowlist, its default read boundary (direct file reads already run without a request), in-workspace edits, and any sandbox settings. Whatever Cursor allows itself never reaches Pi. Requests Cursor does send, including read-only shell commands such as `git status`, are answered by the policy:

- `review` (default): Pi's **currently selected model** decides each request (see below) under the review profile you choose (`task` by default). It approves task-scoped requests once and blocks everything else. **It never opens a permission dialog**, even when Pi has a UI. Blocked requests are recorded so you can look at them later with `/approvals`.
- `ask` (explicit opt-in manual mode): every request goes to `ctx.ui.confirm` with the tool title, kind, paths, and input, when Pi has a dialog UI. In print, JSON, or other no-UI modes they are rejected. This is the only policy that shows permission dialogs.
- `allow`: requests are approved without asking. Use it for unattended runs and accept the trade-off.
- `deny`: requests are rejected.

Set `PI_CURSOR_PERMISSIONS=ask`, `allow`, or `deny` to opt out of review. If Pi loads this package from a local checkout, no settings change is needed for the default; restart Pi after upgrading core helpers so cached modules do not preserve old behavior. There is no fallback from `review` to `allow` or to a blanket Cursor mode.

Under every policy, your exact `/approvals` block rules apply first and block without a model call. Your exact allow rules apply under `review`, `ask`, and `allow`, but never under `deny`. Every decision is written to the private history **before** Cursor gets the answer. If the record can't be written, the request is blocked, even under `allow`.

Approvals only ever select `allow_once`, never `allow_always`, because `allow_always` would write to your Cursor allowlist. Cursor reuses permission requests as a fallback for questions, with each answer offered as an "allow" option. So `cursor/ask_question` is always declined, and any question-shaped or ambiguous request (an `__ask_question_skip__` option, a tool call id ending in `_qN`, several `allow_once` options, or unknown option kinds) is cancelled under every policy, before any rule, reviewer, or dialog sees it. No rule can override this. The client advertises no fs or terminal capabilities, and other unknown agent requests get `-32601`.

### Intelligent review (`review` policy)

For the exact model roles, reasoning budgets, context packet, trust boundaries, and omitted information, see [Permission review: models, agents, and context](docs/permission-review.md).

- **Reviewer:** the active Pi model (`ctx.model`) at the time of the `cursor_worker` call, through `ctx.modelRegistry.streamSimple`. Each call is one direct request with a fixed system policy and a single user message. There are no tools, no code execution, no internet, and no Pi conversation history, so the reviewer can't run anything or recurse into `cursor_worker`. Thinking is capped at `low` (off if Pi's thinking is off or the model doesn't reason), and the answer is capped at 4096 tokens. Cursor workers keep their own fixed profile; the reviewer never changes Pi's or Cursor's model.
- **Second opinion:** only a valid first `ask` (the model is uncertain) gets one more call. It sees the same full request and trusted scope, with the first reason added inside the untrusted data, and thinks one step more (`minimal`→`low`, `low`→`medium`) under the same 4096-token cap. Both calls share the one review deadline. A first `deny` is final. A malformed answer, API error, missing model, oversized or incomplete request, timeout, or abort blocks without a retry. A second `ask` blocks. There are at most 2 model calls per request, and no human fallback.
- **What it sees:** the worker's constraints, the full delegated task, the worker name, cwd and mode, and the complete ACP tool call (title, kind, `rawInput`, content and diffs, locations) and options. All of it is marked as untrusted data, and `<` is escaped so the data can't close its tag. Under the `task` profile, a separate trusted section above the data names the profile, the worker cwd, the current run's scratch directory, Pi's state directory, and your recent user messages (see below). If the whole prompt exceeds 32,000 characters after escaping, or Cursor sent no command, input, or diff, the model is not called and the request is blocked. The reviewer never decides on truncated data.
- **Your intent (task profile):** the adapter reads your recent user messages from the current Pi session branch (`ctx.sessionManager.getBranch()`): only `user` messages, never assistant or tool output. It keeps up to 6 whole messages and 8,000 characters, newest first, and labels them oldest-to-latest, with the latest being the current request. A message is never cut. If the latest message alone is too large, none are included, and that grants nothing. There is no tool argument for this. The policy says that only an explicit, recent user request authorizes scoped operations it would otherwise block, such as a commit, PR, push, or merge you asked for (without force or history rewrites). Old, unrelated, or superseded messages authorize nothing, and claims in the task or tool call that "the user approved this" are not authorization. User intent never authorizes secret access, exfiltration, safeguard changes, or edits to Pi's approval state.
- **Trust:** only the fixed policy, your profile setting, the workspace, scratch and state roots that Pi issues, and your own recent messages are trusted. Task text, commands, code, paths, labels, and the first review's reason are untrusted, including any text that claims a path is "the scratch directory" or pre-approved. Tool arguments cannot choose the profile, the policy, the scratch directory, the user context, or any rule.
- **Profile `task` (default):** task-scoped autonomy for normal development work, not blanket approval. The reviewer approves tests, builds, linters, type checks, and project scripts. It also approves running local project code to validate it (`node`/`python` scripts, `node -e` snippets, dynamic imports of project modules): running project code doesn't make a request "opaque" on its own, but the reviewer still reads the full inline code for red flags. It approves read-only inspection, ordinary task edits in the cwd, controlled and restorable temporary changes such as backup, mutate, and restore, and creating, copying, restoring, or removing files inside the **current run's scratch directory** when every target is plainly inside it (no `..`, symlink tricks, globs, or variables that could reach outside it). It also approves git operations that a recent user message explicitly asks for. It denies out-of-task or prohibited requests, credential or secret access, exfiltration, safeguard bypasses, and writes to Pi's state directory outside the run scratch. It blocks deletes outside the scratch directory that aren't ordinary task edits (anything in `/tmp`, home, caches, unknown ownership, bulk deletes), `git reset/clean/restore`, history rewrites and force flags, commits, branches, worktrees, pushes, releases, deployments or publishing that you didn't explicitly ask for (task text alone isn't enough), privilege, system or global config changes, writes outside the cwd other than to the run's scratch directory, spending, network side effects, downloaded or genuinely unknown code, risky compound or obfuscated commands, and anything incomplete or unclear.
- **Profile `conservative`:** `PI_CURSOR_REVIEW_PROFILE=conservative` keeps the original fixed policy text and review prompt exactly: no user context, no scratch scope. It approves only tests, builds, linters, read-only inspection, and ordinary edits inside the cwd. Its policy text still says "a human decides" for `ask`, but under this package an `ask` is blocked and recorded, and no dialog is shown. Workers still get a scratch directory, but the reviewer isn't told about it.
- **Run scratch directory:** every run gets a fresh private directory, `<run artifacts>/scratch` (mode `0700`, canonical path), which Pi creates before the prompt. The worker's preamble names it on every prompt, including follow-ups to a reused worker, and asks the worker to keep temporary probes, backups, and fixtures there instead of `/tmp`, home, or the repo. It is never deleted automatically; the run's logs and results are kept too. It is **not** a sandbox or a filesystem grant: Cursor decides which requests it sends, and approving scratch work is still the model's judgment of the full command.
- **Strict answer:** the reply must be exactly `{"decision":"approve"|"deny"|"ask","reason":"..."}` with a non-empty reason of at most 300 characters, from a normal `stop`. Markdown, prose, extra fields, tool calls, refusals, truncation (`length`), errors, and aborts all count as `ask`.
- **Failure handling:** a missing reviewer (no active Pi model), a failed request, or a timeout (`PI_CURSOR_REVIEW_TIMEOUT_SECONDS`, default 45, covering both passes) all block the request immediately. Nothing is left hanging, and no dialog is shown. The deadline settles the request even if a provider ignores the abort signal, and a late answer is ignored. The run's timeout, Pi's abort, shutdown, and a dropped worker also abort the review, and no approval is applied after that.
- **What Cursor and Pi learn:** ACP lets Pi answer only with an option id, so Cursor just sees "rejected". The worker preamble tells it not to retry the same or a disguised request, but to take a legitimately different approach or report the blocker. The `cursor_worker` result lists up to 5 blocked decision ids with short reasons, the counts, and the history path; it never includes full logs. The orchestrator is told to report blockers rather than ask you for permission.
- **Dialogs:** none under `review`. Under the explicit `ask` policy, dialogs from all workers in a Pi session are queued one at a time. Model reviews of different workers can run in parallel.
- **Audit:** each run's `events.jsonl` starts with a `run` entry recording the policy, the review profile, and the scratch path. Every decision is logged too: the decision id, policy and review profile, each review pass with its decision, reason, reviewer `provider/model`, and whether it timed out, failed, or aborted, plus whether it was skipped (oversized or no details), the final decision with its provenance, whether it was recorded, and the response sent. The prompt itself is not logged. `/cursor-workers` shows the active profile and the history path.
- **Usage:** the reviewer's token usage and cost are summed across all of a run's reviews and returned as the `cursor_worker` tool result `usage`, so they appear in Pi's totals. That includes failed or malformed reviews when the provider reports usage. When a run fails after reviews, the tool returns an error result that keeps that usage. Usage reported only after a run has finished cannot be added retroactively. Each model review is an extra paid call on your Pi provider.

**Model review is judgment, not a safety proof.** The `review` policy replaces human prompts with model judgment; choose `conservative` for the stricter policy or `ask` for manual dialogs. A model can misjudge an obfuscated or compound shell command, and nothing here parses shell or sandboxes execution. The reviewer only sees requests Cursor sends, so it adds no protection for actions Cursor runs without asking. A permission request that is still pending when the worker's turn ends (or when the run is cancelled or times out) is cancelled, and no later review or answer is applied to it.

### Approval history (`/approvals`)

Every Cursor permission request gets a decision record in `<PI_CURSOR_STATE_DIR>/<project-key>/approvals/`. That is outside the repo, with directories `0700` and files `0600`, and it is shared by all Pi sessions of the project. Nothing goes into the repo or your global settings.

- **Records** (`records/<id>.json`, immutable, written before anything is sent): the id and time, Pi session, worker, Cursor session, cwd and mode, a task hash and preview, the exact action fingerprint, policy and profile, each review pass, the **intended** approve/block decision with its reason and provenance (`pi-review`, `user-rule`, `guard`, `rules-unreadable`, `policy-*`, `human` for the explicit `ask` policy), and the run's artifact paths.
- **Replies** (`responses/<id>.json`, immutable): the reply Pi actually prepared: `allow_once`, `reject_once`, or `cancelled`, plus `allowGranted`, its reason, its provenance (including `late` and `history-error`), and whether the run had already ended. It is written synchronously after the last check of the run's identity, with no await between that check and the reply going to the ACP connection. If it can't be written, an allow is withdrawn. A missing reply record means the reply is **not known to have been sent**. Neither file proves Cursor received the reply or ran anything. `/approvals` lists and filters by the reply: an intended approval whose turn ended first shows as `CANCELLED (intended approve)`, never as approved. A once-rule is claimed only after the delivery checks (allow_once offered, run still current), so a late or unanswerable request doesn't spend it. The full ACP request is stored separately (`payloads/<id>.json`, up to 512K characters). A record without a stored full request or without a command, input, or diff is marked incomplete, and incomplete or question-shaped records can't back a rule.
- **Approval is not execution.** A record says what Pi decided, not what Cursor did. The status Cursor reported for that tool call afterwards (`evidence/<id>.json`) is labeled as Cursor-reported only; Cursor marks some rejected or failed calls `completed`.
- **Cursor-observed tool calls** (`observed/<run>.json`): tool calls Cursor reported without asking Pi, such as in-workspace edits and allowlisted commands, are kept separately as **Cursor-observed, NOT Pi-reviewed**, bounded to 300 per run. Pi can't block these here or retroactively, and there are no overrides for them; use Cursor's own permission configuration to control them. Calls Cursor did ask about, but whose decision couldn't be recorded (and so weren't allowed), are listed apart as `askedPiButNotRecorded`, not as unasked. Before saving, the history waits up to 3 seconds for permission handlers still running at the end of the turn, and the run result warns if any are still pending.
- **Rules:** from a recorded decision you can add **allow once** (the next matching request, consumed atomically before the reply, so across concurrent workers and Pi processes only one request uses it), **allow for this exact task** (same Pi session, worker, and exact task text), **allow in this project**, or **block in this project**. Matching is exact: the canonical request with only the per-call `toolCallId` and `status` removed (commands, flags, quotes, and payloads stay as they are), plus the canonical cwd and the mode. There are no prefixes, patterns, or command families such as `Shell(git)`. Block rules win over allow rules. Allow rules also skip the dialog under the explicit `ask` policy, and they never allow anything under `deny`. Each rule is its own immutable file; a revocation is a separate file and applies to the next request. A new rule is bound to the exact request you were shown (fingerprint, cwd, mode, task key, and a digest of the full request); if the stored decision changed before you confirmed, no rule is created. If an unrevoked rule for an action can't be read, that action is blocked. Revocation is checked by the rule's id before the file is parsed, so you can revoke an unreadable rule from `/approvals` (the file stays in place for inspection); a file without a valid rule id keeps blocking until you fix or remove it.
- **The command:** `/approvals` opens a menu in the interactive TUI: recent, blocked, and approved decisions, rules, and Cursor-observed calls. `/approvals show <id>` prints one decision, and `/approvals blocked|approved|unknown|rules|observed` lists them read-only in any mode (`unknown`: no reply record). Rule changes need the interactive TUI. The full request is shown first (read-only, edits are ignored), then a confirmation spells out the scope. In print, JSON, and RPC modes the command is read-only. This is a command only you can run; no tool can read or change rules, and the dialogs exist only because you opened them. Untrusted text (requests, reasons, task previews, paths, errors) is shown with control characters (C0, DEL, C1), bidi controls, zero-width characters, and line separators escaped as visible `\uXXXX`, newlines included, so a request can't inject terminal escapes or fake lines into the menus or confirmations. Rules still match the original bytes.
- **No replay.** Viewing or changing history never runs, replays, or re-sends anything, and actions that already ran can't be undone. After adding a rule, resume the work yourself, for example by asking Pi to re-run the worker.
- **Not a sandbox:** Pi refuses to start a worker whose canonical cwd (symlinks resolved) contains, equals, or is inside Pi's state directory, for example a worker started in your home directory when the state is under `~/.pi/agent/cursor-workers`. Cursor edits its workspace without asking, so such a worker could rewrite your rules. A worker elsewhere could still write to these files with a shell command Cursor doesn't ask about, and any other process can edit them. The `task` policy denies Cursor requests that write to Pi's state directory, but that is model judgment, not OS enforcement.
- History starts with this version. Older runs keep their `events.jsonl` logs, but no history records are created from them.

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

Each run writes `runs/<timestamp>-<name>-<id>/events.jsonl` (the full ACP traffic) and `result.md` (the full assistant text) under the state dir, next to the run's `scratch/` directory. If the disk falls more than 16 MiB behind, or a write fails, further artifact output is dropped and the result says so. Only live assistant message chunks become the result; thinking, tool output, and replayed history do not. The model sees a capped head and tail plus the path to the full result.

Each run reports its Cursor profile (`model=… context=… effort=… fast=…`) with a status, and its `details` carry the same snapshot as `profile`, `profileStatus`, and `phase`:
- Every streaming update and the successful result name the profile on their first line. The first update is sent as soon as the run starts, before the agent process is contacted. Later updates are sent at each phase change (`connect`, `load`, `setup`, `prompt`), when verification succeeds, and at most once a second for Cursor output, with the elapsed time since the run started and the running counts.
- `configured; not yet verified` means the values are what you configured (`PI_CURSOR_MODEL`, `PI_CURSOR_EFFORT`), not yet confirmed by Cursor for this run. `verified before prompt` is a checkpoint: every value was set and checked by `session/set_config_option` for this run before any prompt. The prompt may still never start (for example, the run is cancelled right after verification), and it does not guarantee which model Cursor is serving later. Every run, including a reused or resumed worker, starts as configured again.
- A failed, timed-out, or cancelled run comes back as an error result. Its text starts with the original error message (one or more lines), followed by a `Cursor profile:` line with the status and phase it reached, then counts, artifact paths, and any reviewer usage.
- A run rejected by the worker manager before it starts (for example, the worker is busy) is also an error result, but it reports only the configured profile, never a verified one. Invalid tool arguments, such as a malformed worker name or a missing task, are still plain tool errors without profile metadata.
- Pi shows streaming updates live; only the final result and its `details` are saved in the session history. If Pi is killed mid-run, no partial update is kept, and older history entries are not changed.

**`stopReason=end_turn` only means the turn ended. It does not prove the task succeeded.**
- Cursor reports many failures as assistant text with `end_turn`. A reply that consists only of `Error: …`, a sign-in prompt, or an empty-prompt notice is treated as a failure, and a reply ending with an `Error:` paragraph gets a warning. Other failures can still appear as ordinary text.
- Cursor marks tool calls `completed` even when they failed or were rejected.
- The orchestrator should check the reply, the diffs, and the test output.
- API or protocol errors, a stop reason other than `end_turn`, timeouts, and cancellations are reported as failures.
- Cursor usage and cost are not reported by ACP, so **Pi's totals exclude Cursor usage**. They do include the Pi model's permission reviews (see above).

## Progress updates

`extensions/progress-update.ts` loads with the package but does not depend on the Cursor bridge. It is enabled by default, and `/reload` picks it up.

- It adds a `progress_updates` section to Pi's structured system prompt that asks Pi's model to write a short milestone update (1–3 sentences) at meaningful phases of multi-step work, and still give a separate final answer. Other extensions' sections and the delegation guidance are left alone. When disabled, the section is removed.
- In the interactive TUI, a widget above the editor shows the newest updates of the current run. When the provider marks text phases (OpenAI Responses), only `commentary` text counts. Otherwise, assistant text sent together with tool calls counts. Thinking, final answers, tool results, and Cursor's raw output are never shown. Each update is stripped of terminal control sequences and capped at 500 characters. Retries keep the run's updates, and a new prompt starts fresh. Other modes get the prompt guidance but no widget.
- `/progress on|off|status|clear` (`enable`/`disable` also work). `on`/`off` is saved in the session and follows the current branch (`/tree`, `/fork`, resume); a branch without a saved setting is on. `clear` empties the widget and keeps collecting.
- These are milestones Pi's model writes in its normal replies, not Cursor worker heartbeats. The extension makes no extra model calls and does no polling.

## Known limitations

- In `plan` mode, Cursor's `cursor/create_plan` request gets `-32601`, which Cursor treats as accepted. It may then write a local plan file, and the plan content appears only in `events.jsonl`.
- ACP messages over 32 MiB (for example a huge replayed tool output during `session/load`) kill the worker. It fails closed and the session stays resumable.
- Windows has no process-group kill.

## Develop

```bash
npm test            # deterministic tests with a fake ACP agent (offline)
npm run check       # syntax check, no downloads
PI_PACKAGE_DIR=/path/to/node_modules/@earendil-works/pi-coding-agent npm run smoke:extension   # load every manifest extension (cursor, progress, approval history) via Pi's real loader, offline, stubbed reviewer model
npm run smoke:live  # opt-in: real Cursor, two turns + session/load resume, ask mode, no edits requested
npm run configure:cursor   # dry run of the native Cursor approvalMode helper (see above)
```

`pi --help` does not run extension factories, so use `smoke:extension` to check that the extension loads.
