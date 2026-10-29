# Cache insights (V1)

Cache insights shows whether your **next** request is likely to reuse the provider's prompt cache. The forecast uses a profile **you seed** for one exact provider/model, and the previous response on the current session branch. It is a local, provisional estimate. It is not provider confirmation and not a statistically validated (for example 95%) guarantee. For a short overview and setup commands, see the [README](../README.md#cache-insights-seeded-forecast-opt-in).

| Capability | V1 |
|---|---|
| Status-bar forecast: `cache hit`, `uncertain`, `cache expired`, with absolute times | Shipped |
| Seeded active profile per exact provider/model (`/cache seed`, CLI `seed`) | Shipped |
| Approximate input-cost range (USD, GitHub credits, or both) | Shipped |
| Metadata-only import of Pi session history (`/cache import`, CLI `import`) | Shipped |
| Observed candidate envelope (`/cache learn`, CLI `learn`) | Shipped (report only) |
| Optional live recording of new responses (`/cache on`, CLI `recording on`) | Shipped |
| Explicit upgrade of an older database (`/cache migrate`, CLI `migrate`) | Shipped |
| Promoting a candidate to the active profile | Not in V1: set it explicitly with `seed` |
| Confidence intervals, isotonic or partial-hit calibration | Not in V1 |
| Compaction estimate, blocking confirmation before a likely miss | Not in V1 |
| Automatic or paid cache warming | Not in V1 (nothing in this feature spends money) |
| Retention, deletion, or export commands | Not in V1 (nothing is deleted) |

## Layout

- `extensions/cache-insights/index.ts`: a thin entry that calls `registerCacheInsights(pi)`.
- `lib/cache-insights/`: cache-only modules. `index.mjs` is the stable public API, `controller.mjs` handles hooks, timers, and `/cache`, and `db.mjs` is storage. `entries.mjs` classifies session entries and decides pairs, `importer.mjs` imports history, `learner.mjs` derives envelopes, `forecast.mjs` holds the rule and cost range, `format.mjs` builds output text, and `paths.mjs` and `util.mjs` are helpers.
- `scripts/cache-insights.mjs`: the CLI.
- `test/cache-insights/`: behaviour and stable-API tests on synthetic fixtures.

Nothing imports the Cursor bridge (`lib/index.mjs` and its modules) or the progress extension. Registering opens no files and starts no timer.

## Forecast

**Rule.** Given the active profile (`hit` and `expire` minutes for the active `provider/model`) and an anchor (the previous usable response):

- `cache hit`: the time since the anchor's request start **and** the time since its response end are both **strictly less** than `hit`.
- `cache expired`: both are **strictly greater** than `expire`.
- `uncertain`: everything else, including exactly `hit` or exactly `expire`, a long response whose start clock is past `hit` while its end clock is not, and every case below.

**Display and refresh.** The status bar shows absolute times, never a countdown: `cache hit · until 14:32 UTC+1` (start + hit, rounded down) or `uncertain · expired after 14:37 UTC+1` (end + expire, rounded up). Every footer time carries its zone:

- `UTC` in UTC mode, or when the local offset is zero;
- otherwise the local offset, for example `UTC+9`, `UTC-5`, `UTC+5:30`, or `UTC-3:30`.

The offset belongs to the shown time itself, so a deadline after a daylight-saving change shows the new offset. Times are local by default, or UTC. Full timestamps in `/cache status` and history keep their existing formats (ISO `…Z` in UTC mode). An optional `· miss ≈$…` suffix shows the cost range. `/cache status` shows both clocks, their provenance, the profile, and the cost range in detail.

**Footer styling.** In the TUI the footer uses Pi's current theme and is styled again at every refresh, so a theme change applies at the next update. Everything is the theme's `dim` colour, like other footer text, except the `cache expired` label, which uses the theme's `warning` colour, the same style as Pi's own cache-miss notices; its cost suffix stays dim. Hits, uncertain states, errors, and "upgrade needed" stay dim. Without a usable theme (`ctx.ui.theme.fg`), the footer is plain text. `/cache` output, the CLI, and stored data never contain styling.

**Local time zone.** "Local" times use the Pi process's time zone: `TZ` if it is set in the environment Pi was started from, otherwise the operating system's default. Your terminal app's own clock display does not change it, but the shell, tmux, SSH session, container, or launcher that starts Pi can.

- The `/cache settings` menu shows the effective zone and current UTC offset, and whether `TZ` overrides it. Its **Local timezone guide** (a read-only view) explains the options: the OS Date & Time settings; one launch with `TZ=Asia/Tokyo pi` (PowerShell: `$env:TZ='Asia/Tokyo'; pi`); persisting with `export TZ=...` in your own shell profile, which affects every program started from it; and `unset TZ`.
- Restart Pi after changing its environment. Daylight saving time is applied automatically.
- UTC (`/cache settings time utc`, or the menu) only changes how `/cache` formats times.
- The plugin never changes `TZ`, the environment, or any shell file, and stores no time zone of its own.

The status recalculates on every observed hook, and on a one-minute timer while a session has a database. An extra one-shot timer fires exactly when the label can next change (hit → uncertain, uncertain → expired), so the status is not up to a minute late. Both timers are unref'd. They are never started without a database, and they are cancelled on shutdown, reload, and storage failure, so nothing renders after close.

**Anchors.**

- **Live:** an assistant `message_end` with stop reason `stop`, `toolUse`, or `length`. Its request start is the message timestamp (Pi records it when the provider request starts). Its end is when `message_end` was received, which is after the response and before tools run. It is not `turn_end` or `agent_end`.
- **Recovered at startup or resume:** the latest response on the **current branch only** (`ctx.sessionManager.getBranch()`), never another session's latest event. The end is that entry's saved timestamp, a proxy labeled as such. The recovered anchor counts only if the configuration it was sent with is verified unchanged (see "Baseline check" below). With a seed, existing history, and an unchanged configuration, the first status after startup is meaningful without recording anything new.
- **After `/reload`:** the anchor is recovered too, but the forecast stays `uncertain · extension reloaded` until the next response, because the in-memory system-prompt/tool baseline is lost.
- **Repeated events:** a repeated `message_end` for the same response (same provider, model, and request start, or the same message object) is ignored before anything changes. It cannot extend the anchor's end time or pair a response with itself, whether or not recording is on. The check is in memory, bounded to the last 512 responses, and stores nothing.

**Baseline check (startup and resume, in memory only).** The thin adapter injects Pi's own projection helpers into a dependency-free core resolver (`createBaselineResolver`):

- `buildSessionContext(entries)` from `@earendil-works/pi-coding-agent` projects the current branch: its messages and thinking level.
- `getCurrentSystemPrompt(messages)` and `getCurrentTools(messages)` from `@earendil-works/pi-ai` resolve the persisted system-message checkpoints and patches into the system prompt and tool declarations in effect.

The resolver compares those with the running configuration: `ctx.getSystemPrompt()`, the active tools' declarations (`pi.getActiveTools()` names looked up in `pi.getAllTools()`, comparing name, description, and parameters while preserving declaration order and ignoring object-key order), and `pi.getThinkingLevel()`. The result is one of three:

- **unchanged:** the recovered history forecast stands;
- **changed:** `uncertain · system prompt or tools changed` or `uncertain · thinking level changed`;
- **unknown:** `uncertain · configuration not verifiable`. This covers an empty persisted prompt (for example a branch without system checkpoints), tool metadata without parameters, an active tool without metadata, a missing thinking level, a missing helper, or any error.

Until a live response replaces the recovered anchor, the check runs again at every `before_agent_start`, so a configuration changed while Pi was closed, or before the first request, cannot stay a hit into that request. Reload, fork, and new sessions stay uncertain regardless of the result. Nothing from the check is stored, hashed, or logged, and no token prefix is reconstructed.

**Uncertain until the next usable response:**

- no profile for the active model;
- no anchor;
- the anchor's model differs from the active model;
- the provider answered with a different model. Only the same id (see "Model ids" below), optionally with a snapshot suffix `-YYYY-MM-DD` (OpenAI style) or `-YYYYMMDD` (Anthropic style, for example `claude-opus-5-5-20261101`), counts as the same model. Any other suffix is a different model: `gpt-6.1-sol-mini` is not `gpt-6.1-sol`;
- a model change with a previous model, or a thinking-level change. A `model_select` between Opus version-separator aliases of the same provider is not a change;
- a system prompt or tool-set change, whether persisted as a `system` message entry or detected by comparing `before_agent_start` events in memory (never stored);
- compaction, `/tree`, fork, reload, or a new session;
- an error or abort;
- a cache warm after the anchor (its start time is unknown);
- any non-message session entry after the anchor on the branch, such as model or thinking changes, system messages, compaction, branch summaries, context edits, warms, or unknown types.

Ordinary user, tool-result, custom-message, and extension-state entries do not reset anything.

**Clocks.** Anchors are wall-clock UTC milliseconds. For live anchors, the monotonic clock is a sanity check:

- A negative elapsed time, or an end before the start, is `uncertain · clock anomaly`.
- Wall time more than 5 seconds behind monotonic time is `uncertain · wall clock moved backward`.
- Wall time ahead of monotonic time (laptop sleep or a forward clock change) is trusted, because the provider's clock keeps running. `/cache status` reports it as `wall_ahead`.

**Model ids.** Ids are compared exactly, within one provider, except for one known alias: Claude Opus version separators, so `claude-opus-5-5` and `claude-opus-5.5` are the same model. The alias applies consistently to profile lookup, import targets, learner filtering and grouping, pair decisions, and the anchor/active-model comparison. Stored samples and pairs keep the raw reported id. There is no other aliasing and no inheritance across providers.

**Switching models.** Everything per model happens automatically when you change provider or model:

- Live samples and pairs are recorded under the model that actually answered.
- `/cache learn` groups candidates per provider/model.
- The status looks up the active model's own profile at once.
- The pair across a switch is excluded from learning, and the status stays `uncertain` until the new model's next response.

Only the active thresholds are manual (`seed`); candidates are never promoted, and a model without its own profile shows `uncertain · no seeded profile for this model` instead of borrowing another model's or provider's seed. Menu views (status, learning, history) are snapshots: reopen them for fresh data.

**Profiles.** `seed provider/model hit expire` takes plain decimal minutes with `0 < hit <= expire <= 1440`. It sets the active profile for exactly that `provider/model`; seeding the Opus alias of an existing profile updates that profile. Other models never inherit it and show `uncertain · no seeded profile for this model`. The active profile changes only through `seed`. The learner never changes it. The package ships no profile values. For example, the maintainer's local install uses `seed github-copilot/gpt-6.1-sol 25 30`.

## Cost range

This is the approximate **input-only** cost of the next request. Response generation is excluded, and it is a Pi catalog estimate, not a bill.

- **Prompt size:** `ctx.getContextUsage().tokens` when available. Otherwise, the anchor's prompt (`input + cacheRead + cacheWrite`) plus its output.
- **Hit:** the anchor's prompt at the `cacheRead` price, and the rest at the `input` price.
- **Miss:** a range from all tokens at `input` (cold) to all tokens at `cacheWrite`, when the catalog has a positive cache-write price.
- **Pricing:** Pi's model cost, per million tokens: `{ input, output, cacheRead, cacheWrite, tiers?: [{ inputTokensAbove, input, output, cacheRead, cacheWrite }] }`. A tier replaces all prices for prompts strictly larger than its `inputTokensAbove`, and the highest matching tier wins.
- **Unknown prices:** a missing input price, a malformed tier, or an all-zero price set gives "unknown", never $0. An all-zero catalog entry usually means "not priced" rather than free. A zero `cacheRead` price alongside a positive `input` price is a real price.
- **Units:** `/cache settings cost usd|credits|both|off`. GitHub credits use 1 credit = $0.01. They are an equivalent for credit-based plans only, not your balance, and not legacy premium-request accounting.

## Commands and CLI (stable user API)

| In Pi | CLI (`node scripts/cache-insights.mjs …`) | Writes |
|---|---|---|
| `/cache` or `/cache menu` (TUI: interactive menu; elsewhere: status text) | | only through the actions below |
| `/cache status` | `status` | no |
| `/cache history [1-200]` | | no |
| `/cache learn [provider/model]` | `learn [--model provider/model]` | no |
| `/cache seed <provider/model> <hit> <expire>` | `seed <provider/model> <hit> <expire>` | profile |
| `/cache import [provider/model ...]` | `import [--model provider/model]... [--sessions-dir DIR]` | samples, pairs |
| `/cache on` / `/cache off` | `recording on\|off` | recording choice |
| `/cache settings [time local\|utc] [cost off\|usd\|credits\|both]` | `settings [--time …] [--cost …]` | settings |
| `/cache migrate` | `migrate` | schema upgrade |

- **Validation first:** every command, argument, flag, and value is validated before anything is opened or created. Unknown commands, flags used with the wrong command, repeated single-value flags, empty or non-decimal minutes, and invalid settings are rejected, and no directory or database is created. The CLI exits 2 for these.
- **Import targets:** without explicit models, import uses the models that have a seeded profile. With neither, it fails with `no_targets` and creates nothing. There are no built-in default models. In Pi, those profiles are read without upgrading anything; an older database reports `migration_required`, and nothing is upgraded or written until you confirm an import.
- **In Pi:** write commands work only in the interactive TUI, and `seed` and `import` show a confirmation. In `print`, `json`, and `rpc` modes, write commands change nothing. There are no model-callable tools.

**Interactive menu (TUI).** Bare `/cache` and `/cache menu` open a looping menu built only on Pi's `ctx.ui.select`, `input`, `confirm`, and `editor`. Its title summarizes the active model, recording state, and display settings. The entries are:

- **Status and forecast:** opens the full status in a read-only view.
- **Display settings:** a picker for times (local or UTC) and cost (off, USD, GitHub credits, or both). `/cache settings` with no arguments opens this submenu directly.
- **Recording:** shows the current state and toggles it.
- **Seed or edit a model profile:** offers the current model, seeded profiles, or a typed `provider/model`. It then asks for the hit and expire minutes. When a profile exists, an empty entry keeps its shown value; for a new profile, an empty entry or Esc cancels. Values are validated like `seed`, and nothing is written until the usual confirmation.
- **Import session metadata:** offers all seeded models, the current model, or typed models. Profiles are read without creating or upgrading the database, and the usual metadata-only confirmation comes before anything is written.
- **Learning candidates:** for all models, the current model, a seeded model, or a typed one.
- **Recent history:** 20, 50, 100, 200, or a typed 1–200.
- **Upgrade the database:** asks for confirmation first.
- **Close.**

Typed models for a profile or learning view must be exactly one `provider/model`; only import accepts several. When the database needs an upgrade (`migration_required`), or cannot be used, the title shows "upgrade needed" or the error and "settings unknown", never invented defaults. Every data action (settings, recording, profile, import, learning, history) then explains the situation and returns to the menu without acting. "Upgrade the database (needed)" is the only way forward, and it asks before upgrading. Every write reuses the validated actions of the direct commands. Status, history, and learning open in Pi's editor titled "… (read-only; edits are ignored)". Whatever is returned is discarded; without an editor, the text is shown as a notification. Back or Esc returns to the previous menu without changes, and an answer that was not offered counts as cancel. Only one menu runs at a time.

Session start, shutdown, reload, and `/tree` close the menu. Its pending dialogs receive an abort signal, and any answer that still arrives later is ignored, so it cannot write or reopen the menu. Cancelling never creates a database or reports a storage error. Outside the TUI, or when `ctx.ui.select` is unavailable, bare `/cache` and `/cache settings` show read-only text and open no dialogs. The menu creates no timers or other resources.
- **CLI options:** `--agent-dir DIR` (default `PI_CODING_AGENT_DIR` or `~/.pi/agent`), `--root DIR` (the cache-insights dir), and `--json`. The CLI writes only the feature's database, and only for write commands. `recording off`, `status`, `learn`, `settings` without flags, and `migrate` never create a database. Exit codes: 0 success, 1 error (a fixed code and message, never paths or raw error text), 2 usage.

## Storage

- **Location:** `<Pi agent dir>/cache-insights/cache-insights.sqlite`, separate from all other plugin state.
- **Engine:** built-in `node:sqlite`, imported lazily. Without it, the feature stops with one generic `unsupported` warning, and Cursor workers and the other extensions are unaffected.
- **Rows:** uncompressed, with fixed allowlisted columns.
- **Schema version:** one per database, in `PRAGMA user_version` (2). Rows carry no schema version.
- **Path safety:**
  - The directory is `0700` and the file `0600`.
  - The store refuses a symlinked root or database file, a hard-linked database file, and entries not owned by the current user. Symlinked *parent* directories are allowed.
  - It also refuses a root inside the current project. The project is the nearest `.git` ancestor of the session cwd (a version-controlled home directory and `/` do not count). Outside a repository, the project is the cwd itself, unless the cwd contains the agent dir (home, `/`, `~/.pi`, or the agent dir itself), which is private agent data.
  - These checks are not hardened against a concurrent local attacker with write access to the parent directory.
- **Versions and migration:**
  - The stored version is checked before anything is written, so not even the journal mode changes. Newer schemas and files with unrelated tables are refused unchanged.
  - Read-only opens (startup, `status`, `learn`, `history`) never migrate. An older file shows `cache: upgrade needed`, and `/cache status` and the CLI report `migration_required`.
  - Only explicit, confirmed write commands (`seed`, a confirmed `import`, `on`/`off`, `settings` with values) and `/cache migrate` or CLI `migrate` upgrade, in one `BEGIN IMMEDIATE` transaction. A cancelled seed or import leaves the file byte-identical. A failed migration rolls back completely.
  - A schema-1 file from the earlier unreleased draft (gzip JSON per row) is upgraded losslessly. Its table is renamed intact to `legacy_events`, with every original column, the original payload bytes, and its indexes. A `payload_text` column then holds the decompressed bytes decoded as strict UTF-8, never re-serialized (`NULL` when undecodable). The saved recording choice survives. Legacy rows are not used by the learner.
- **Sharing:** journal mode `DELETE` (no `-wal` or `-shm` files) and a 2-second `busy_timeout`. Settings, profiles, and the recording choice are shared by every Pi process and the CLI.
- **Retention:** nothing is deleted by default. Re-imports are idempotent. A storage error stops the feature in that Pi process with one generic warning, and existing data is kept.

**Stored values.** All values are allowlisted:

- **Samples** (responses and warms): an identity kind, origin (`live` or `historical`), provider/model/API/response-model ids, thinking level (live only), stop reason, request start, end, end provenance (`message_end_received`, `entry_timestamp_proxy`, or `unknown`), the six token buckets, and the five catalog cost fields.
- **Pairs:** origin (`live`, `historical`, or `both`), gaps on both clocks, the previous and current read/write/prompt counts, `qualified`, the tier, and an exclusion code.
- **Profiles**, **settings**, and **events** (fixed kinds and codes).

Unknown values are `NULL`, and a provider-reported `0` stays `0`. Unsafe identifiers become `NULL`. Unknown fields are rejected.

**Never stored or shown:** message, system, or tool content; tool arguments; summaries; warm notes; error messages; headers; credentials; raw session or entry ids; session names; file names; paths; the cwd; and content fingerprints.

**Deduplication.** Each sample gets a keyed HMAC-SHA256 identity under a random per-database key. That is deduplication, not anonymization.

- `time`: provider, model, and request start. Warms use their completion time instead. This is shared by live and imported copies of the same response.
- `entry_id`: an opaque session-entry id plus its time, when there is no request start.
- `position`: the file's place under the sessions dir and its line number, when there is neither. This is stable across re-imports but ambiguous across copies.
- `none`: a live response without a request start.

Samples without a request start are kept, and they never qualify for learning.

## History import

- **Source:** `*.jsonl` files under `PI_CODING_AGENT_SESSION_DIR`, else `<agent dir>/sessions` (or `--sessions-dir`). Files are read directly, never through SessionManager, which migrates files.
- **Reading:** directories are walked up to 4 levels deep. Symlinks are skipped (and counted), and the sessions root itself must not be a symlink. Lines stream in 64 KiB chunks, and lines over 16 MiB are skipped. Parse problems are counted under fixed codes (`invalid_json`, `oversized_line`, `not_object`), with no snippets.
- **Errors:** filesystem problems are counted per file. Database problems (for example a busy database) stop the import with a `storage` error. Rows already written are kept, and the import never reports success over them. Inserts commit in small chunks so other Pi processes are not locked out for a whole file.
- **Entry classification:**
  - Assistant messages are responses.
  - User, tool-result, bash-execution, custom, and custom-message entries are ordinary appends.
  - `custom`, `label`, and `session_info` entries are ignored.
  - `usage` entries with `kind: "cache_warm"` are warms.
  - System messages, model or thinking changes, compaction, branch summaries, context edits, unknown entry types, and other message roles are boundaries.
- **Pairs** are formed in file order. A pair links each target response to the response just before it in the file, and both actual chronology and tree ancestry are checked. The first failing gate decides the exclusion:
  - a boundary or warm between them (`boundary`, `warm_between`);
  - the current response does not reach the previous one through ordinary entries only (`ancestry_break`, for example after `/tree`), or the file has no entry ids (`legacy_ambiguous`);
  - different requested models (`model_changed`), or either response answered by a different model (`model_mismatch`);
  - a previous or current response that is not `stop`/`toolUse` (`prev_not_success`, `cur_not_success`);
  - a missing or zero previous prompt (`prev_usage_missing`), or a missing current prompt or cache read (`usage_missing`);
  - missing times (`timing_missing`), or a negative gap or an end before its start (`clock_anomaly`).
- **Records:** every matched response is stored, including failures with their reported zeros and responses without a request start. Imported records are marked `historical`, and their end is the saved entry time (a proxy).
- **Dedup:** copies (forked sessions), hard-link aliases, and re-imports deduplicate.
- **Merging:** the same pair seen live and imported merges independently of order. An exclusion from either source wins, and the origin becomes `both`.
- **Summary:** counts only (files, lines, parse errors, matched/added/duplicate responses and warms, responses without a request start, and pairs by exclusion code).

## Observed envelope (learner)

- **Input:** qualified pairs for each provider/model. The strong tier, where the previous response had a provider-reported cache read greater than 0, is used for the envelope. Weak-tier and excluded pairs are reported as counts.
- **Per clock (start and end):** **H** is the longest gap with `cacheRead > 0`. **Z** is the earliest zero-read gap strictly greater than H. Zero reads at or below H contradict expiry (for example a short anomalous miss). They are counted as `contradictory` and never treated as a minimum TTL.
- **What it does not do:** no gap bins, windows, percentile thresholds, or fitted curves. It computes by iteration, not array spreading, so large histories are safe.
- **Output:** `/cache learn` reports counts, H and Z per clock, exclusions, and origins next to the active profile. Each envelope's `model` is the normalized id, and `models` lists the raw reported ids it groups.
- **Candidate only:** a candidate never changes the active profile. A single lucky hit cannot move the seeded thresholds.

## Live recording

Recording is off until `/cache on` or CLI `recording on`, and the choice is saved for future sessions. While on, each assistant `message_end` stores a live sample and, from the second response in the process, a pair with the previous live response.

A live pair is excluded when a hook-observed transition happened in between. It is also excluded when, at `message_start`, the branch shows a persisted boundary since the previous response (system message, compaction, model or thinking change, warm, ...), which matches what an import of the same file would decide. `/tree` breaks pairing. The first response after a restart has no live pair; a later import can pair it from the file. Successful warms seen on the branch are stored as warm samples.

Recording is separate from forecasting: with recording off, the seeded forecast still works.

## Not in V1

- Confidence intervals, isotonic or partial-hit threshold calibration, or any statistical validity claim.
- Promoting a candidate envelope to the active profile (use `seed`).
- Compaction cost estimates, blocking confirmations before a likely miss, or automatic or paid cache warming.
- Retention, deletion, or export commands.
- Server-side confirmation of cache state. Provider-hidden retries and fallbacks are not visible.
- An exact match between the startup baseline and the prompt Pi builds for a turn. At `before_agent_start`, Pi reports the prompt it built for that turn. If that differs textually from the persisted checkpoints (for example, sections added per turn), the recovered anchor becomes `uncertain` until the response, which errs toward uncertain. Sessions without system checkpoints cannot be verified and stay uncertain until a new response.
- Exact dedup of responses without a request start between live recording and a later import. Such a response can appear twice, once as `none` and once as `entry_id`/`position`. It is rare and never used for learning.

## Decisions taken under the agreed defaults

- **Response identity:** provider, model, and request start, rather than the session-entry id. This way, live and imported copies of the same response deduplicate. The entry id and import position are used only when there is no request start.
- **Clock check:** wall time ahead of monotonic time is trusted (sleep), and wall time behind it makes the forecast uncertain.
- **Cost display:** the default is `usd`. The miss range is also shown when the status is uncertain because of a transition.
- **Transition anchors:** after a transition, the anchor's times stay visible in `/cache status`, but the label stays `uncertain` until the next usable response.
