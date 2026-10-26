import fs from "node:fs/promises";
import path from "node:path";
import { AcpConnection, AcpError } from "./acp-connection.mjs";
import { MODES, validateWorkerName } from "./config.mjs";
import { applyProfile } from "./profile.mjs";
import { WorkerRegistry } from "./state.mjs";

export class WorkerError extends Error {
	constructor(message, details) {
		super(message);
		this.name = "WorkerError";
		this.details = details;
	}
}

export const TASK_PREAMBLE = [
	"You are a Cursor worker delegated by a Pi orchestrator that keeps decision-making and final synthesis.",
	"Work only on the task below, in the current working directory.",
	"- Actually run the relevant builds/tests/commands; never claim a result you did not observe.",
	"- Do not commit, push, create branches/worktrees, or change global settings unless the task explicitly asks.",
	"- Avoid destructive actions (mass deletion, git reset/clean, force operations, editing outside the task scope).",
	"- Do not read, print, or copy credentials or secrets.",
	"- Finish with a concise handoff: what you did, files changed, commands/tests run with results, and open risks or questions.",
].join("\n");

export function buildPrompt(task) {
	return `${TASK_PREAMBLE}\n\n<task>\n${task}\n</task>`;
}

/** Bounded head+tail buffer for the model-facing result; the full text is streamed to result.md. */
export class ResultBuffer {
	constructor(limit) {
		this.limit = limit;
		this.headLimit = Math.floor(limit / 4);
		this.head = "";
		this.tail = "";
		this.total = 0;
	}

	append(text) {
		this.total += text.length;
		if (this.head.length < this.headLimit) {
			const take = text.slice(0, this.headLimit - this.head.length);
			this.head += take;
			text = text.slice(take.length);
		}
		this.tail += text;
		if (this.tail.length > this.limit * 2) this.tail = this.tail.slice(-this.limit);
	}

	render() {
		if (this.total <= this.limit) return { text: this.head + this.tail, truncated: false, shown: this.total };
		const tail = this.tail.slice(-(this.limit - this.headLimit));
		const omitted = this.total - this.head.length - tail.length;
		return { text: `${this.head}\n\n[... ${omitted} chars omitted ...]\n\n${tail}`, truncated: true, shown: this.head.length + tail.length };
	}
}

// Cursor's ACP reports some failures as assistant text with stopReason=end_turn.
const IN_BAND_FATAL = [/^Error:/, /^Please sign in to continue/i, /^No prompt content provided/i, /^Upgrade your plan/i];

/** Classify Cursor's in-band error text: a reply consisting only of an error is fatal; a trailing error paragraph is a warning. */
export function detectInBandError(text) {
	const t = text.trim();
	if (!t) return undefined;
	if (IN_BAND_FATAL.some((re) => re.test(t))) return { fatal: true, message: t.slice(0, 500) };
	const idx = t.lastIndexOf("\n\n");
	const last = idx >= 0 ? t.slice(idx + 2) : "";
	if (/^Error:/.test(last)) return { fatal: false, message: last.slice(0, 500) };
	return undefined;
}

const KNOWN_PERMISSION_KINDS = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);

/**
 * Reasons a permission request must not be answered by policy: Cursor reuses session/request_permission as a
 * fallback for questions (answers offered as allow_once options), so anything question-shaped or ambiguous is cancelled.
 */
export function unsafePermissionReason(params) {
	const options = Array.isArray(params?.options) ? params.options : [];
	if (options.some((o) => o?.optionId === "__ask_question_skip__")) return "question fallback (__ask_question_skip__ option)";
	if (/_q\d+$/.test(String(params?.toolCall?.toolCallId ?? ""))) return "question fallback (toolCallId _qN)";
	if (options.some((o) => !KNOWN_PERMISSION_KINDS.has(o?.kind))) return "unknown option kind";
	if (options.filter((o) => o?.kind === "allow_once").length > 1) return "multiple allow_once options";
	return undefined;
}

export function describePermission(params) {
	const tc = params?.toolCall ?? {};
	const lines = [`Tool: ${tc.title ?? "(untitled)"}${tc.kind ? ` [${tc.kind}]` : ""}`];
	const locations = (tc.locations ?? []).map((l) => l?.path).filter(Boolean);
	if (locations.length) lines.push(`Paths: ${locations.slice(0, 10).join(", ")}`);
	if (tc.rawInput !== undefined) {
		let raw;
		try {
			raw = JSON.stringify(tc.rawInput, null, 1);
		} catch {
			raw = String(tc.rawInput);
		}
		lines.push(`Input: ${raw.length > 1500 ? `${raw.slice(0, 1500)}…` : raw}`);
	}
	const kinds = (params?.options ?? []).map((o) => o?.kind).filter(Boolean);
	if (kinds.length) lines.push(`Offered: ${kinds.join(", ")} (only allow_once is ever selected)`);
	return lines.join("\n");
}

async function resolveDir(dir, base) {
	const abs = path.resolve(base, dir);
	let stat;
	try {
		stat = await fs.stat(abs);
	} catch {
		throw new WorkerError(`Worker cwd does not exist: ${abs}`);
	}
	if (!stat.isDirectory()) throw new WorkerError(`Worker cwd is not a directory: ${abs}`);
	return fs.realpath(abs);
}

function abortRejection(signal) {
	return new Promise((_, reject) => {
		const fail = () => reject(new WorkerError("aborted"));
		if (signal.aborted) fail();
		else signal.addEventListener("abort", fail, { once: true });
	});
}

const CANCEL_WORDS = { timeout: "timed out", cancelled: "was cancelled", shutdown: "was stopped by Pi session shutdown" };

export class WorkerManager {
	constructor(options) {
		const o = {
			args: ["acp"],
			env: process.env,
			permissionPolicy: "ask",
			maxWorkers: 4,
			resultLimit: 12000,
			defaultTimeoutMs: 30 * 60 * 1000,
			rpcTimeoutMs: 60000,
			loadTimeoutMs: 180000,
			cancelGraceMs: 12000,
			killGraceMs: 2000,
			maxFrameBytes: 32 * 1024 * 1024,
			artifactMaxPendingBytes: 16 * 1024 * 1024,
			clientInfo: { name: "pi-cursor-workers", version: "0.1.0" },
			...options,
		};
		for (const key of ["stateDir", "projectCwd", "piSessionId", "command", "profile"]) {
			if (!o[key]) throw new Error(`WorkerManager requires ${key}`);
		}
		this.opts = o;
		this.registry = new WorkerRegistry(o);
		this.workers = new Map();
		this.reserved = new Set();
		this.activeRuns = new Set();
		this.profileQueue = Promise.resolve();
		this.shuttingDown = false;
	}

	get profileLabel() {
		const p = this.opts.profile;
		return `model=${p.model} context=${p.context} effort=${p.effort} fast=${p.fast}`;
	}

	async run({ name, task, cwd, mode, timeoutMs, signal, onProgress, askPermission } = {}) {
		validateWorkerName(name);
		if (typeof task !== "string" || !task.trim()) throw new WorkerError("run requires a non-empty task");
		if (mode !== undefined && !MODES.includes(mode)) throw new WorkerError(`mode must be one of ${MODES.join("|")}`);
		timeoutMs ??= this.opts.defaultTimeoutMs;
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new WorkerError("timeout must be positive");
		if (this.shuttingDown) throw new WorkerError("Cursor worker manager is shutting down");
		if (this.reserved.has(name)) {
			throw new WorkerError(`Worker "${name}" is already running a task; concurrent prompts to one worker would interleave context. Wait, or use another worker name.`);
		}
		this.reserved.add(name);
		try {
			return await this.#run({ name, task, cwd, mode, timeoutMs, signal, onProgress, askPermission });
		} finally {
			this.reserved.delete(name);
		}
	}

	/** The timeout and abort signal cover the whole run: connect, load, profile/mode setup, permission dialogs, and the prompt. */
	async #run({ name, task, cwd, mode, timeoutMs, signal, onProgress, askPermission }) {
		const started = Date.now();
		const run = {
			name,
			timeoutMs,
			artifacts: undefined,
			worker: undefined,
			phase: "connect",
			promptSent: false,
			result: new ResultBuffer(this.opts.resultLimit),
			counts: { messageChunks: 0, thoughtChunks: 0, toolCalls: 0, permissionRequests: 0, permissionsAllowed: 0 },
			askPermission,
			abort: new AbortController(),
			dialogs: new AbortController(),
			cancelled: undefined,
			notes: [],
			emit: () => {},
		};
		run.cancel = (reason) => {
			if (run.cancelled) return;
			run.cancelled = reason;
			run.abort.abort();
			run.dialogs.abort();
			if (run.promptSent) run.worker?.conn.notify("session/cancel", { sessionId: run.worker.sessionId });
		};
		this.activeRuns.add(run);
		const timer = setTimeout(() => run.cancel("timeout"), timeoutMs);
		const onAbort = () => run.cancel("cancelled");
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		let worker;
		try {
			const record = await this.registry.read(name);
			worker = this.workers.get(name);
			const boundCwd = worker?.cwd ?? record?.cwd;
			const dir = await resolveDir(cwd ?? boundCwd ?? this.opts.projectCwd, this.opts.projectCwd);
			if (boundCwd && boundCwd !== dir) {
				throw new WorkerError(`Worker "${name}" is bound to ${boundCwd}; refusing to move it to ${dir}. Use a different worker name for another directory or worktree.`);
			}
			run.artifacts = await this.registry.createRun(name, { maxPendingBytes: this.opts.artifactMaxPendingBytes });
			if (!worker && record?.lastRun?.status === "running") {
				run.notes.push("Previous run on this worker was interrupted (Pi exited mid-task); the remote session may contain partial work from it.");
			}
			this.#checkRun(run);
			if (worker) worker.run = run;
			else worker = await this.#connect(name, dir, record, mode ?? record?.mode ?? "agent", run);
			run.worker = worker;
			try {
				if (mode && mode !== worker.mode) await this.#setMode(worker, mode, run.abort.signal);
				// Always re-apply: Cursor never reports config changes reliably, and session/load restores the session's last model.
				await this.#applyProfile(worker, run);
				this.#checkRun(run);
			} catch (err) {
				await this.#discard(worker, "setup failed or was interrupted");
				throw err;
			}
			worker.lastRun = { status: "running", startedAt: new Date(started).toISOString(), artifactDir: run.artifacts.dir };
			await this.#save(worker);
			const response = await this.#prompt(worker, run, task, onProgress);
			const durationMs = Date.now() - started;
			const inBand = detectInBandError(run.result.render().text);
			if (inBand?.fatal) {
				throw new WorkerError(`Cursor worker "${name}" replied with an error although stopReason=end_turn: ${inBand.message}`);
			}
			if (inBand) run.notes.push(`Warning: the reply ends with an error reported by Cursor: ${inBand.message}`);
			worker.lastRun = { ...worker.lastRun, status: "completed", stopReason: response.stopReason, finishedAt: new Date().toISOString() };
			await this.#save(worker);
			await run.artifacts.close();
			return this.#format(worker, run, response.stopReason, durationMs);
		} catch (err) {
			let message = err.message;
			if (run.cancelled && !run.promptSent) {
				const what = CANCEL_WORDS[run.cancelled] ?? "was cancelled";
				message = `Cursor worker "${name}" ${what}${run.cancelled === "timeout" ? ` after ${timeoutMs / 1000}s` : ""} during ${run.phase}, before the task was sent; no prompt was started.`;
			}
			if (worker?.lastRun?.status === "running") {
				worker.lastRun = { ...worker.lastRun, status: run.cancelled ?? "failed", finishedAt: new Date().toISOString(), error: String(message).slice(0, 500) };
				await this.#save(worker).catch(() => {});
			}
			const a = run.artifacts;
			await a?.close();
			const extra = [];
			if (a && run.result.total) extra.push(`Partial assistant output (${run.result.total} chars) saved to ${a.resultPath}${a.writeError ? " (incomplete)" : ""}`);
			if (a) extra.push(`ACP event log: ${a.eventsPath}${a.writeError ? ` (incomplete: ${a.writeError.message})` : ""}`);
			throw new WorkerError([message, ...extra].join("\n"), { name, artifactDir: a?.dir, cancelled: run.cancelled });
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			this.activeRuns.delete(run);
			if (worker) {
				worker.run = undefined;
				worker.lastUsed = Date.now();
			}
		}
	}

	#checkRun(run) {
		if (run.cancelled) throw new WorkerError("cancelled");
		if (this.shuttingDown) {
			run.cancel("shutdown");
			throw new WorkerError("shutdown");
		}
	}

	async #connect(name, cwd, record, mode, run) {
		while (this.workers.size >= this.opts.maxWorkers) {
			const idle = [...this.workers.values()].filter((w) => !this.reserved.has(w.name)).sort((a, b) => a.lastUsed - b.lastUsed)[0];
			if (!idle) throw new WorkerError(`All ${this.opts.maxWorkers} Cursor workers are busy; wait for one to finish (PI_CURSOR_MAX_WORKERS raises the cap).`);
			await this.#discard(idle, "released to stay within PI_CURSOR_MAX_WORKERS");
		}
		const worker = {
			name,
			cwd,
			mode: undefined,
			sessionId: record?.sessionId,
			createdAt: record?.createdAt ?? new Date().toISOString(),
			lastRun: record?.lastRun,
			configOptions: undefined,
			modes: undefined,
			lastUsed: Date.now(),
			run,
			conn: undefined,
		};
		worker.conn = new AcpConnection({
			command: this.opts.command,
			args: this.opts.args,
			cwd,
			env: this.opts.env,
			maxFrameBytes: this.opts.maxFrameBytes,
			killGraceMs: this.opts.killGraceMs,
			onEvent: (event) => worker.run?.artifacts?.logEvent({ phase: worker.run.phase, ...event }),
			onNotification: (method, params) => this.#onNotification(worker, method, params),
			onRequest: (method, params) => this.#onRequest(worker, method, params),
			onClose: () => {
				if (this.workers.get(name) === worker) this.workers.delete(name);
				worker.run?.dialogs.abort();
			},
		});
		this.workers.set(name, worker);
		const timeoutMs = this.opts.rpcTimeoutMs;
		const signal = run.abort.signal;
		try {
			this.#checkRun(run);
			worker.conn.start();
			const init = await worker.conn.request(
				"initialize",
				{ protocolVersion: 1, clientCapabilities: { _meta: { parameterizedModelPicker: true } }, clientInfo: this.opts.clientInfo },
				{ timeoutMs, signal },
			);
			if (init?.protocolVersion !== 1) throw new WorkerError(`Unsupported ACP protocolVersion ${JSON.stringify(init?.protocolVersion)} (expected 1)`);
			let session;
			if (record?.sessionId) {
				if (init.agentCapabilities?.loadSession !== true) {
					throw new WorkerError(`Cannot resume worker "${name}" (session ${record.sessionId}): the agent does not advertise loadSession. Not creating a fresh session silently; close it with forget:true or use another name.`);
				}
				run.phase = "load";
				try {
					session = await worker.conn.request("session/load", { sessionId: record.sessionId, cwd, mcpServers: [] }, { timeoutMs: this.opts.loadTimeoutMs, signal });
				} catch (err) {
					throw new WorkerError(`session/load failed for worker "${name}" (session ${record.sessionId}): ${err.message}\nNot creating a fresh session silently; close it with forget:true or use another name.`);
				}
			} else {
				session = await worker.conn.request("session/new", { cwd, mcpServers: [] }, { timeoutMs, signal });
				if (typeof session?.sessionId !== "string" || !session.sessionId) throw new WorkerError("session/new returned no sessionId");
				worker.sessionId = session.sessionId;
				await this.#save(worker);
			}
			run.phase = "setup";
			worker.modes = session?.modes;
			worker.mode = session?.modes?.currentModeId;
			worker.configOptions = session?.configOptions;
			await this.#setMode(worker, mode, signal);
			this.#checkRun(run);
			return worker;
		} catch (err) {
			await this.#discard(worker, "setup failed");
			throw err;
		}
	}

	/** Set and verify the full profile before every prompt. Serialized across workers because Cursor persists it to its CLI config file. */
	async #applyProfile(worker, run) {
		const previous = this.profileQueue;
		let release;
		this.profileQueue = new Promise((r) => (release = r));
		try {
			await Promise.race([previous, abortRejection(run.abort.signal)]);
			run.phase = "setup";
			worker.configOptions = await applyProfile(worker.conn, worker.sessionId, worker.configOptions, this.opts.profile, {
				timeoutMs: this.opts.rpcTimeoutMs,
				signal: run.abort.signal,
			});
		} finally {
			release();
		}
	}

	async #setMode(worker, mode, signal) {
		const available = worker.modes?.availableModes;
		if (Array.isArray(available) && !available.some((m) => m?.id === mode)) {
			throw new WorkerError(`Cursor session does not offer mode "${mode}" (offered: ${available.map((m) => m?.id).join(", ")})`);
		}
		await worker.conn.request("session/set_mode", { sessionId: worker.sessionId, modeId: mode }, { timeoutMs: this.opts.rpcTimeoutMs, signal });
		worker.mode = mode;
		await this.#save(worker);
	}

	async #save(worker) {
		await this.registry.write(worker.name, {
			version: 1,
			name: worker.name,
			cwd: worker.cwd,
			sessionId: worker.sessionId,
			mode: worker.mode,
			profile: this.opts.profile,
			createdAt: worker.createdAt,
			updatedAt: new Date().toISOString(),
			lastRun: worker.lastRun,
		});
	}

	#onNotification(worker, method, params) {
		if (method !== "session/update" || params?.sessionId !== worker.sessionId) return;
		const update = params.update ?? {};
		if (update.sessionUpdate === "current_mode_update" && update.currentModeId) worker.mode = update.currentModeId;
		const run = worker.run;
		// Only live prompt output counts; session/load replays history before the prompt phase.
		if (!run || run.phase !== "prompt") return;
		switch (update.sessionUpdate) {
			case "agent_message_chunk": {
				const text = update.content?.type === "text" && typeof update.content.text === "string" ? update.content.text : "";
				if (!text) break;
				run.counts.messageChunks++;
				run.result.append(text);
				run.artifacts.appendResult(text);
				break;
			}
			case "agent_thought_chunk":
				run.counts.thoughtChunks++;
				break;
			case "tool_call":
				run.counts.toolCalls++;
				break;
		}
		run.emit();
	}

	async #onRequest(worker, method, params) {
		if (method === "session/request_permission") return this.#permission(worker, params);
		// Any error here makes Cursor fall back to a permission request whose options are the answers; decline instead.
		if (method === "cursor/ask_question") {
			worker.run?.artifacts?.logEvent({ phase: worker.run.phase, dir: "decision", method, response: "cancelled" });
			return { outcome: { outcome: "cancelled" } };
		}
		throw new AcpError(`Method not found: ${method}`, { code: -32601 });
	}

	async #permission(worker, params) {
		const cancelled = { outcome: { outcome: "cancelled" } };
		const options = Array.isArray(params?.options) ? params.options : [];
		const pick = (kind) => {
			const option = options.find((o) => o?.kind === kind && typeof o.optionId === "string");
			return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : cancelled;
		};
		const run = worker.run;
		if (!run || run.phase !== "prompt" || run.cancelled || params?.sessionId !== worker.sessionId) return cancelled;
		run.counts.permissionRequests++;
		const policy = this.opts.permissionPolicy;
		const unsafe = unsafePermissionReason(params);
		let allow = false;
		let response;
		if (unsafe) {
			response = cancelled;
		} else {
			allow = policy === "allow";
			if (policy === "ask" && run.askPermission) {
				try {
					const request = { worker: worker.name, cwd: worker.cwd, title: params.toolCall?.title ?? "Cursor tool request", message: describePermission(params) };
					allow = (await run.askPermission(request, run.dialogs.signal)) === true;
				} catch {
					allow = false;
				}
			}
			if (run.cancelled) response = cancelled;
			else response = pick(allow ? "allow_once" : "reject_once");
		}
		if (response.outcome.optionId && allow) run.counts.permissionsAllowed++;
		run.artifacts.logEvent({ phase: run.phase, dir: "decision", policy, allow, unsafe, response });
		run.emit();
		return response;
	}

	async #prompt(worker, run, task, onProgress) {
		this.#checkRun(run);
		run.phase = "prompt";
		const started = Date.now();
		let last = 0;
		run.emit = () => {
			const now = Date.now();
			if (!onProgress || now - last < 1000) return;
			last = now;
			try {
				onProgress({ status: "running", elapsedMs: now - started, resultChars: run.result.total, ...run.counts });
			} catch {
				// progress is best effort
			}
		};
		const settle = (p) => p.then((r) => ({ r }), (e) => ({ e }));
		run.promptSent = true;
		const promptResult = settle(
			worker.conn.request("session/prompt", { sessionId: worker.sessionId, prompt: [{ type: "text", text: buildPrompt(task) }] }, { timeoutMs: 0 }),
		);
		const interrupted = new Promise((resolve) => {
			if (run.abort.signal.aborted) resolve(null);
			else run.abort.signal.addEventListener("abort", () => resolve(null), { once: true });
		});
		let outcome = await Promise.race([promptResult, interrupted]);
		let killed = false;
		if (!outcome) {
			let graceTimer;
			outcome = await Promise.race([promptResult, new Promise((r) => (graceTimer = setTimeout(() => r(null), this.opts.cancelGraceMs)))]);
			clearTimeout(graceTimer);
			if (!outcome?.r) {
				killed = true;
				await this.#discard(worker, "did not stop after session/cancel");
			}
		}
		const stopReason = outcome?.r?.stopReason;
		if (run.cancelled) {
			if (stopReason === "end_turn") {
				run.notes.push(`Note: cancellation (${run.cancelled}) was requested, but the agent had already ended its turn.`);
				return outcome.r;
			}
			const what = `${CANCEL_WORDS[run.cancelled] ?? "was cancelled"}${run.cancelled === "timeout" ? ` after ${run.timeoutMs / 1000}s` : ""}`;
			const how = killed
				? "it did not stop after session/cancel, so its process group was terminated (the session stays resumable)"
				: stopReason === "cancelled"
					? "the agent acknowledged session/cancel"
					: `the agent ended with ${outcome?.e ? `error: ${outcome.e.message}` : `stopReason=${stopReason}`}`;
			throw new WorkerError(`Cursor worker "${worker.name}" ${what}; ${how}. The task did not complete; do not assume its changes are finished.`);
		}
		if (stopReason === "end_turn") return outcome.r;
		if (outcome?.e) {
			throw new WorkerError(`Cursor worker "${worker.name}" failed during prompt: ${outcome.e.message}\nThe prompt was not retried; inspect the worker state before re-sending.`);
		}
		throw new WorkerError(`Cursor worker "${worker.name}" stopped with unsupported stopReason=${JSON.stringify(stopReason)}; treating as failure.`);
	}

	#format(worker, run, stopReason, durationMs) {
		const rendered = run.result.render();
		const a = run.artifacts;
		const lines = [
			`Cursor worker "${worker.name}" ended its turn: stopReason=${stopReason}, mode=${worker.mode}, ${this.profileLabel} (verified before prompt), session=${worker.sessionId}, ${Math.round(durationMs / 1000)}s.`,
			"end_turn only means the turn ended; check the reply, diffs, and test output before treating the task as done.",
			...run.notes,
			"",
			rendered.text || "(no assistant text)",
		];
		if (a.writeError) lines.push("", `Warning: run artifacts are incomplete (${a.writeError.message}).`);
		if (rendered.truncated) lines.push("", `[Result truncated: showing ${rendered.shown} of ${run.result.total} chars. Full result: ${a.resultPath}${a.writeError ? " (incomplete)" : ""}]`);
		lines.push("", `Artifacts: ${a.dir}`);
		return {
			text: lines.join("\n"),
			details: {
				name: worker.name,
				sessionId: worker.sessionId,
				cwd: worker.cwd,
				mode: worker.mode,
				profile: this.opts.profile,
				stopReason,
				durationMs,
				resultChars: run.result.total,
				truncated: rendered.truncated,
				resultPath: a.resultPath,
				eventsPath: a.eventsPath,
				artifactError: a.writeError?.message,
				counts: { ...run.counts },
			},
		};
	}

	async #discard(worker, reason) {
		if (this.workers.get(worker.name) === worker) this.workers.delete(worker.name);
		worker.run?.dialogs.abort();
		await worker.conn?.terminate(reason);
	}

	async list() {
		const records = await this.registry.list();
		const byName = new Map(records.map((r) => [r.name, r]));
		for (const w of this.workers.values()) if (!byName.has(w.name)) byName.set(w.name, { name: w.name, cwd: w.cwd, sessionId: w.sessionId });
		return [...byName.values()].map((r) => {
			const live = this.workers.get(r.name);
			return {
				name: r.name,
				live: Boolean(live),
				busy: this.reserved.has(r.name),
				cwd: r.cwd,
				sessionId: r.sessionId,
				mode: live?.mode ?? r.mode,
				lastRun: r.lastRun ? { status: r.lastRun.status, stopReason: r.lastRun.stopReason, artifactDir: r.lastRun.artifactDir } : undefined,
				error: r.error,
			};
		});
	}

	/**
	 * Release the worker process. With forget, also delete the local worker record (name -> Cursor session mapping);
	 * Cursor's own session history and local run artifacts are not deleted.
	 */
	async close(name, { forget = false } = {}) {
		validateWorkerName(name);
		if (this.reserved.has(name)) throw new WorkerError(`Worker "${name}" is running a task; abort the Pi turn to cancel it first.`);
		const worker = this.workers.get(name);
		if (worker) await this.#discard(worker, "closed by request");
		if (forget) await this.registry.remove(name);
		return { name, wasLive: Boolean(worker), forgotten: forget };
	}

	/** Cancel in-flight runs and terminate every worker process. Idempotent; durable records are kept for resume. */
	shutdown() {
		this.shuttingDown = true;
		for (const run of this.activeRuns) run.cancel("shutdown");
		this.shutdownPromise ??= Promise.allSettled([...this.workers.values()].map((w) => this.#discard(w, "Pi session shutdown"))).then(() => {});
		return this.shutdownPromise;
	}
}
