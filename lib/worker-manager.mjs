import fs from "node:fs/promises";
import path from "node:path";
import { AcpConnection, AcpError } from "./acp-connection.mjs";
import { DEFAULT_PERMISSION_POLICY, DEFAULT_REVIEW_PROFILE, MODES, REVIEW_PROFILES, validateWorkerName } from "./config.mjs";
import { ApprovalStore, actionFingerprint, DECISION_NOTE, MAX_PAYLOAD_CHARS, newId, summarizeToolCall, taskKey, taskSha } from "./approvals.mjs";
import { addUsage, buildReviewPrompt, normalizeReview, normalizeUserContext } from "./permission-review.mjs";
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
	"- If a permission request is rejected, do not retry it or a disguised variant of it; use a legitimately different approach within the task, or stop and report the blocker in your handoff. Rejections are final for this run.",
	"- Finish with a concise handoff: what you did, files changed, commands/tests run with results, and open risks or questions.",
].join("\n");

/** scratchDir is the current run's Pi-created scratch directory; every prompt names its own run's directory. */
export function buildPrompt(task, { scratchDir } = {}) {
	const scratch = scratchDir
		? [
				`- Run scratch directory (private to this run, created by Pi, outside the repo): ${scratchDir}`,
				"  Put temporary probes, backups, test fixtures, and other throwaway files there instead of /tmp, your home directory, or the repo; clean up only what you created there. Pi does not delete it automatically.",
			].join("\n")
		: "";
	return `${TASK_PREAMBLE}${scratch ? `\n${scratch}` : ""}\n\n<task>\n${task}\n</task>`;
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

/** Canonical form of a path that may not exist yet: realpath of its deepest existing ancestor plus the rest. */
async function canonicalPath(p) {
	let cur = path.resolve(p);
	const rest = [];
	for (;;) {
		try {
			return path.join(await fs.realpath(cur), ...rest.reverse());
		} catch (err) {
			if (err.code !== "ENOENT") throw err;
			const parent = path.dirname(cur);
			if (parent === cur) return path.resolve(p);
			rest.push(path.basename(cur));
			cur = parent;
		}
	}
}

const isWithin = (child, parent) => {
	const rel = path.relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

/**
 * Cursor edits files inside its workspace without asking Pi, so a worker whose canonical cwd contains, equals, or is
 * inside Pi's state directory (permission history and approval rules) is refused before any agent starts. This only
 * keeps the workspace away from that state; it is not a sandbox, and other processes can still edit those files.
 */
export async function controlPlaneConflict(cwd, stateDir) {
	const [dir, state] = await Promise.all([canonicalPath(cwd), canonicalPath(stateDir)]);
	if (isWithin(state, dir)) return `it contains Pi's private state directory ${state}`;
	if (isWithin(dir, state)) return `it is inside Pi's private state directory ${state}`;
	return undefined;
}

function abortRejection(signal) {
	return new Promise((_, reject) => {
		const fail = () => reject(new WorkerError("aborted"));
		if (signal.aborted) fail();
		else signal.addEventListener("abort", fail, { once: true });
	});
}

/** Await a promise, rejecting as soon as signal aborts; removes its listener either way. */
async function untilAborted(promise, signal) {
	let onAbort;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				onAbort = () => reject(new WorkerError("aborted"));
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** Once a run's turn is over, pending reviews and dialogs are aborted and no later permission answer can apply. */
function endRun(run) {
	run.finished = true;
	run.dialogs.abort();
}

const MAX_OBSERVED_CALLS = 300;
const MAX_REQUESTED_IDS = 1000;
const PENDING_FLUSH_WAIT_MS = 3000;
const BLOCKED_SHOWN = 5;

function lateReason(run, worker) {
	if (run.cancelled) return `the run ${CANCEL_WORDS[run.cancelled] ?? "was cancelled"} before the decision could be delivered; not applied`;
	if (worker.run !== run) return "the worker was released before the decision could be delivered; not applied";
	return "the worker's turn ended before the decision could be delivered; not applied";
}

/** Compact, model-facing permission summary: counts, a few blocked decision ids with reasons, and where history lives. */
function permissionSummary(run, eventsPath, historyDir) {
	const c = run.counts;
	if (!c.permissionRequests) return undefined;
	const lines = [];
	if (c.permissionReviews) {
		lines.push(
			`Permissions: Pi's model (${run.reviewModel ?? "unavailable"}) reviewed ${c.permissionReviews} Cursor permission request(s) under review profile ${run.reviewProfile}: ${c.reviewApproved} approved, ${c.reviewDenied} denied, ${c.reviewUncertain} uncertain and blocked (${c.secondOpinions} second opinion(s)). No permission dialogs are shown under review.`,
		);
	}
	if (c.ruleAllowed || c.ruleBlocked) lines.push(`Your exact /approvals rules allowed ${c.ruleAllowed} and blocked ${c.ruleBlocked} request(s).`);
	if (c.permissionsBlocked) {
		lines.push(`Blocked ${c.permissionsBlocked} Cursor permission request(s) (Cursor only receives "rejected"); report these as blockers, do not re-send work to get around them:`);
		for (const b of run.blocked.slice(0, BLOCKED_SHOWN)) lines.push(`- ${b.id}: ${b.reason.slice(0, 200)}${b.recorded ? "" : " (not in history)"}`);
		if (c.permissionsBlocked > BLOCKED_SHOWN) lines.push(`- and ${c.permissionsBlocked - BLOCKED_SHOWN} more`);
		lines.push("The user can inspect decisions and add exact allow rules with /approvals; nothing is re-run automatically, so resume the work explicitly afterwards.");
	}
	lines.push(`Decision history (private, outside the repo): ${historyDir}. ACP event log: ${eventsPath}`);
	return lines.join("\n");
}

const CANCEL_WORDS = { timeout: "timed out", cancelled: "was cancelled", shutdown: "was stopped by Pi session shutdown" };

export class WorkerManager {
	constructor(options) {
		const o = {
			args: ["acp"],
			env: process.env,
			permissionPolicy: DEFAULT_PERMISSION_POLICY,
			reviewProfile: DEFAULT_REVIEW_PROFILE,
			reviewTimeoutMs: 45000,
			maxWorkers: 4,
			resultLimit: 12000,
			defaultTimeoutMs: 30 * 60 * 1000,
			rpcTimeoutMs: 60000,
			loadTimeoutMs: 180000,
			cancelGraceMs: 12000,
			killGraceMs: 2000,
			maxFrameBytes: 32 * 1024 * 1024,
			artifactMaxPendingBytes: 16 * 1024 * 1024,
			clientInfo: { name: "pi-cursor-workers", version: "0.3.0" },
			...options,
		};
		for (const key of ["stateDir", "projectCwd", "piSessionId", "command", "profile"]) {
			if (!o[key]) throw new Error(`WorkerManager requires ${key}`);
		}
		if (!REVIEW_PROFILES.includes(o.reviewProfile)) throw new Error(`WorkerManager reviewProfile must be one of ${REVIEW_PROFILES.join("|")}`);
		this.opts = o;
		this.registry = new WorkerRegistry(o);
		this.approvals = new ApprovalStore({ stateDir: o.stateDir, projectCwd: o.projectCwd });
		this.workers = new Map();
		this.reserved = new Set();
		this.activeRuns = new Set();
		this.profileQueue = Promise.resolve();
		this.dialogQueue = Promise.resolve();
		this.shuttingDown = false;
	}

	get profileLabel() {
		const p = this.opts.profile;
		return `model=${p.model} context=${p.context} effort=${p.effort} fast=${p.fast}`;
	}

	/**
	 * userContext is the caller's recent user messages ([{ text, timestamp }], chronological), read by the Pi adapter from
	 * its own session branch; it is not a tool argument. askPermission is used only by the explicit ask policy.
	 */
	async run({ name, task, cwd, mode, timeoutMs, signal, onProgress, askPermission, reviewPermission, userContext } = {}) {
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
			return await this.#run({ name, task, cwd, mode, timeoutMs, signal, onProgress, askPermission, reviewPermission, userContext });
		} finally {
			this.reserved.delete(name);
		}
	}

	/** The timeout and abort signal cover the whole run: connect, load, profile/mode setup, permission dialogs, and the prompt. */
	async #run({ name, task, cwd, mode, timeoutMs, signal, onProgress, askPermission, reviewPermission, userContext }) {
		const started = Date.now();
		const run = {
			name,
			task,
			timeoutMs,
			userContext: normalizeUserContext(userContext),
			blocked: [],
			pending: new Set(),
			requestedToolCallIds: new Set(),
			decisionsByToolCallId: new Map(),
			observed: new Map(),
			observedOmitted: 0,
			artifacts: undefined,
			scratchDir: undefined,
			reviewProfile: this.opts.reviewProfile,
			worker: undefined,
			phase: "connect",
			promptSent: false,
			result: new ResultBuffer(this.opts.resultLimit),
			counts: {
				messageChunks: 0,
				thoughtChunks: 0,
				toolCalls: 0,
				permissionRequests: 0,
				permissionsAllowed: 0,
				permissionsBlocked: 0,
				permissionReviews: 0,
				reviewApproved: 0,
				reviewDenied: 0,
				reviewUncertain: 0,
				secondOpinions: 0,
				ruleAllowed: 0,
				ruleBlocked: 0,
				humanApproved: 0,
				cursorObservedUnreviewed: 0,
			},
			askPermission,
			reviewPermission,
			reviewUsage: undefined,
			reviewModel: undefined,
			finished: false,
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
			const conflict = await controlPlaneConflict(dir, this.opts.stateDir);
			if (conflict) {
				throw new WorkerError(
					`Refusing to start Cursor worker "${name}" in ${dir}: ${conflict} (permission history and approval rules). Cursor edits files in its workspace without asking Pi, so a worker there could change your approval state. Use a project directory outside it. This check is not a sandbox; other processes can still edit those files.`,
				);
			}
			run.artifacts = await this.registry.createRun(name, { maxPendingBytes: this.opts.artifactMaxPendingBytes });
			run.scratchDir = await run.artifacts.createScratch();
			run.artifacts.logEvent({ phase: run.phase, dir: "run", policy: this.opts.permissionPolicy, reviewProfile: run.reviewProfile, scratchDir: run.scratchDir });
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
			await this.#flushHistory(run);
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
			if (a && run.promptSent) await this.#flushHistory(run);
			await a?.close();
			const extra = [];
			if (a && run.result.total) extra.push(`Partial assistant output (${run.result.total} chars) saved to ${a.resultPath}${a.writeError ? " (incomplete)" : ""}`);
			if (a) extra.push(`ACP event log: ${a.eventsPath}${a.writeError ? ` (incomplete: ${a.writeError.message})` : ""}`);
			const permissions = a && permissionSummary(run, a.eventsPath, this.approvals.dir);
			if (permissions) extra.push(permissions);
			extra.push(...run.notes.filter((n) => n.startsWith("Warning:")));
			throw new WorkerError([message, ...extra].join("\n"), {
				name,
				artifactDir: a?.dir,
				scratchDir: run.scratchDir,
				reviewProfile: this.opts.permissionPolicy === "review" ? run.reviewProfile : undefined,
				blockedDecisionIds: run.blocked.length ? run.blocked.slice(0, BLOCKED_SHOWN).map((b) => b.id) : undefined,
				cancelled: run.cancelled,
				counts: { ...run.counts },
				usage: structuredClone(run.reviewUsage),
			});
		} finally {
			endRun(run);
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
				this.#observe(run, update);
				break;
			case "tool_call_update":
				this.#observe(run, update);
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

	#permission(worker, params) {
		const run = worker.run;
		// Every tool call Cursor asked about is remembered, whether or not its decision could be recorded.
		const toolCallId = typeof params?.toolCall?.toolCallId === "string" ? params.toolCall.toolCallId.slice(0, 200) : undefined;
		if (run && toolCallId && run.requestedToolCallIds.size < MAX_REQUESTED_IDS) run.requestedToolCallIds.add(toolCallId);
		if (!run || run.phase !== "prompt" || run.cancelled || run.finished || params?.sessionId !== worker.sessionId) return { outcome: { outcome: "cancelled" } };
		// Pending handlers are tracked so the end-of-turn history flush can wait for them (bounded) or report them.
		const pending = this.#decidePermission(worker, run, params, toolCallId);
		run.pending.add(pending);
		pending.finally(() => run.pending.delete(pending)).catch(() => {});
		return pending;
	}

	async #decidePermission(worker, run, params, toolCallId) {
		const cancelled = { outcome: { outcome: "cancelled" } };
		const options = Array.isArray(params?.options) ? params.options : [];
		const pick = (kind) => {
			const option = options.find((o) => o?.kind === kind && typeof o.optionId === "string");
			return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : cancelled;
		};
		const hasAllowOnce = options.some((o) => o?.kind === "allow_once" && typeof o.optionId === "string");
		run.counts.permissionRequests++;
		const policy = this.opts.permissionPolicy;
		const id = newId("d");
		// Question-shaped requests are cancelled before any rule, reviewer, or dialog sees them, under every policy.
		const unsafe = unsafePermissionReason(params);
		const decision = { phase: run.phase, dir: "decision", decisionId: id, policy, reviewProfile: policy === "review" ? run.reviewProfile : undefined, unsafe };
		const action = this.#actionInfo(worker, run, params);
		// intended: what the rules/policy/review decided. The reply actually prepared is decided below and recorded apart.
		let intended;
		let onceRule;
		const block = (reason, provenance, extra) => (intended = { decision: "block", reason, provenance, ...extra });
		const approve = (reason, provenance, extra) => (intended = { decision: "approve", reason, provenance, ...extra });
		if (unsafe) block(`question-shaped or ambiguous request (${unsafe}); never answered`, "guard");
		else {
			let rules = {};
			try {
				rules = action.fingerprint ? await this.approvals.match({ fingerprint: action.fingerprint, taskKey: action.taskKey }) : {};
			} catch (err) {
				rules = { error: String(err?.message ?? err).slice(0, 200) };
			}
			if (rules.error) block(`your /approvals rules for this action could not be read (${rules.error}); blocked`, "rules-unreadable");
			else if (rules.block) {
				run.counts.ruleBlocked++;
				block(`blocked by your /approvals rule ${rules.block.id}`, "user-rule", { ruleId: rules.block.id });
			} else if (rules.allow && action.complete && policy !== "deny") {
				// A once-rule is claimed only after the delivery checks below, so a late or unanswerable request never spends it.
				if (rules.allow.scope === "once") onceRule = rules.allow;
				approve(`allowed by your /approvals rule ${rules.allow.id} (${rules.allow.scope})`, "user-rule", { ruleId: rules.allow.id, ruleScope: rules.allow.scope });
			}
		}
		let final = intended;
		if (!intended) {
			if (policy === "allow") approve("PI_CURSOR_PERMISSIONS=allow", "policy-allow");
			else if (policy === "deny") block("PI_CURSOR_PERMISSIONS=deny", "policy-deny");
			else if (policy === "ask") {
				const request = { worker: worker.name, cwd: worker.cwd, title: params.toolCall?.title ?? "Cursor tool request", message: describePermission(params) };
				decision.human = run.askPermission ? await this.#askHuman(run, request) : "unavailable";
				if (decision.human === true) {
					run.counts.humanApproved++;
					approve("approved by the user in a PI_CURSOR_PERMISSIONS=ask dialog", "human");
				} else block(decision.human === "unavailable" ? "PI_CURSOR_PERMISSIONS=ask without a dialog UI" : "rejected by the user in a PI_CURSOR_PERMISSIONS=ask dialog", "human");
			} else {
				// review: the model approves or the request is blocked. No human dialog, ever.
				const review = await this.#review(worker, run, params);
				decision.review = review;
				run.counts.permissionReviews++;
				if (review.decision === "approve") {
					run.counts.reviewApproved++;
					approve(review.reason, "pi-review");
				} else if (review.decision === "deny") {
					run.counts.reviewDenied++;
					block(review.reason, "pi-review");
				} else {
					run.counts.reviewUncertain++;
					block(`${review.passes?.length === 2 ? "uncertain after a second opinion" : "not approved"}: ${review.reason}`, "pi-review");
				}
			}
		}
		final = intended;
		// Delivery: from here on, `final` is what Cursor is actually answered. Any failed check withdraws an allow.
		let allow = intended.decision === "approve";
		const withdraw = (reason, provenance) => {
			allow = false;
			final = { decision: "block", reason, provenance };
		};
		// A late answer (after the turn ended, a timeout, abort, shutdown, or a dropped worker) is never applied.
		const isStale = () => run.cancelled || run.finished || run.dialogs.signal.aborted || worker.run !== run || run.phase !== "prompt";
		const late = () => withdraw(lateReason(run, worker), "late");
		if (allow && !hasAllowOnce) withdraw("Cursor offered no allow_once option; only allow_once is ever selected", "guard");
		if (allow && isStale()) late();
		// The intended decision is persisted before Cursor hears anything; an allow that cannot be recorded is not given.
		try {
			await this.approvals.recordDecision(this.#decisionRecord(worker, run, id, action, decision, intended, params?.toolCall), action.payload);
			decision.recorded = true;
		} catch (err) {
			decision.historyError = String(err?.message ?? err).slice(0, 200);
			if (allow) withdraw(`the decision could not be written to the approval history (${decision.historyError}); blocked`, "history-error");
			run.notes.push(`Warning: permission decision ${id} could not be written to the approval history: ${decision.historyError}`);
		}
		if (allow && isStale()) late();
		if (allow && onceRule) {
			let claimed = false;
			try {
				claimed = await this.approvals.claimOnce(onceRule, id);
			} catch {
				claimed = false;
			}
			if (!claimed) withdraw(`your once-rule ${onceRule.id} was already used by another request or could not be claimed; blocked`, "user-rule");
		}
		// No await from here to the return: the run identity checked now is the one the reply goes to.
		const stale = isStale();
		if (allow && stale) late();
		let response = decision.unsafe || stale ? cancelled : pick(allow ? "allow_once" : "reject_once");
		if (decision.recorded) {
			try {
				this.approvals.recordResponseSync(id, this.#responseRecord(intended, final, response, allow, stale));
				decision.responseRecorded = true;
			} catch (err) {
				decision.responseError = String(err?.message ?? err).slice(0, 200);
				if (allow) {
					withdraw(`the reply could not be written to the approval history (${decision.responseError}); blocked`, "history-error");
					response = pick("reject_once");
				}
				run.notes.push(`Warning: the reply to permission decision ${id} could not be recorded (its history shows no known reply): ${decision.responseError}`);
			}
		}
		const applied = Boolean(allow && response.outcome.optionId);
		if (applied) {
			run.counts.permissionsAllowed++;
			if (final.provenance === "user-rule") run.counts.ruleAllowed++;
		} else {
			run.counts.permissionsBlocked++;
			if (run.blocked.length < 50) run.blocked.push({ id, reason: final.reason, recorded: decision.recorded === true });
		}
		if (toolCallId && decision.recorded) run.decisionsByToolCallId.set(toolCallId, { id, allowed: applied });
		run.artifacts.logEvent({ ...decision, intended, final, allow: applied, response });
		run.emit();
		return response;
	}

	#responseRecord(intended, final, response, allow, stale) {
		const o = response.outcome;
		return {
			outcome: o.outcome === "cancelled" ? "cancelled" : allow ? "allow_once" : "reject_once",
			optionId: o.optionId,
			allowGranted: Boolean(allow && o.optionId),
			intendedDecision: intended.decision,
			reason: final.reason,
			provenance: final.provenance,
			stale,
		};
	}

	/** Canonical identity and completeness of one request. Only complete requests may be matched by allow rules. */
	#actionInfo(worker, run, params) {
		const toolCall = params?.toolCall && typeof params.toolCall === "object" ? params.toolCall : undefined;
		const info = { complete: false, payload: undefined, payloadStored: false, fingerprint: undefined, taskKey: undefined };
		info.taskKey = taskKey({ piSessionId: this.opts.piSessionId, worker: worker.name, task: run.task });
		if (!toolCall) {
			info.incompleteReason = "Cursor sent no tool call details";
			return info;
		}
		try {
			info.fingerprint = actionFingerprint({ toolCall, cwd: worker.cwd, mode: worker.mode });
			const payload = { toolCall, options: params.options };
			const chars = JSON.stringify(payload).length;
			if (chars <= MAX_PAYLOAD_CHARS) {
				info.payload = payload;
				info.payloadStored = true;
			} else info.incompleteReason = `request larger than ${MAX_PAYLOAD_CHARS} chars; not stored in full`;
		} catch {
			info.fingerprint = undefined;
			info.incompleteReason = "the request could not be serialized";
			return info;
		}
		const hasDetail = toolCall.rawInput !== undefined || (Array.isArray(toolCall.content) && toolCall.content.length > 0);
		if (!hasDetail) info.incompleteReason ??= "Cursor sent no command, input, or diff";
		info.complete = info.payloadStored && hasDetail;
		return info;
	}

	#decisionRecord(worker, run, id, action, decision, intended, toolCall) {
		const review = decision.review;
		const task = String(run.task);
		return {
			id,
			createdAt: new Date().toISOString(),
			piSessionId: this.opts.piSessionId,
			worker: worker.name,
			cursorSessionId: worker.sessionId,
			cwd: worker.cwd,
			mode: worker.mode,
			task: { sha256: taskSha(task), chars: task.length, preview: task.slice(0, 500), truncated: task.length > 500 },
			taskKey: action.taskKey,
			fingerprint: action.fingerprint,
			complete: action.complete,
			incompleteReason: action.complete ? undefined : action.incompleteReason,
			payloadStored: action.payloadStored,
			guard: decision.unsafe,
			policy: decision.policy,
			reviewProfile: decision.reviewProfile,
			request: summarizeToolCall(toolCall),
			passes: review?.passes?.map((p) => ({ pass: p.pass, decision: p.decision, reason: p.reason, model: p.model, error: p.error, timedOut: p.timedOut, aborted: p.aborted, durationMs: p.durationMs })),
			reviewSkipped: review?.skipped ? review.reason : undefined,
			human: decision.policy === "ask" ? decision.human : undefined,
			intended,
			eventsPath: run.artifacts.eventsPath,
			artifactDir: run.artifacts.dir,
			note: DECISION_NOTE,
		};
	}

	/** After the turn: Cursor-reported statuses go to decided records as evidence; the rest are Cursor-observed only. */
	async #flushHistory(run) {
		// Handlers still deciding when the turn ended answer "cancelled" (stale) and record that; give them a bounded moment.
		if (run.pending.size) {
			let timer;
			await Promise.race([Promise.allSettled([...run.pending]), new Promise((r) => (timer = setTimeout(r, PENDING_FLUSH_WAIT_MS)))]);
			clearTimeout(timer);
			if (run.pending.size) run.notes.push(`Warning: ${run.pending.size} permission decision(s) were still being handled when the run's history was saved; their outcome may be missing from it.`);
		}
		if (!run.observed.size) return;
		const unreviewed = [];
		const askedUnrecorded = [];
		for (const call of run.observed.values()) {
			const decided = run.decisionsByToolCallId.get(call.toolCallId);
			if (!decided) {
				// Cursor asked Pi about this call, but its decision was not recorded: not a native, unasked call.
				if (run.requestedToolCallIds.has(call.toolCallId)) askedUnrecorded.push({ ...call, permissionRequested: true, decisionRecorded: false });
				else unreviewed.push(call);
				continue;
			}
			try {
				await this.approvals.writeEvidence(decided.id, {
					toolCallId: call.toolCallId,
					permissionAllowed: decided.allowed,
					lastReportedStatus: call.status,
					updates: call.updates,
					firstSeen: call.firstSeen,
					lastSeen: call.lastSeen,
					note: "Status as reported by Cursor. Cursor marks some failed or rejected tool calls completed; this does not prove execution or success.",
				});
			} catch (err) {
				run.notes.push(`Warning: Cursor-reported status for decision ${decided.id} was not saved: ${err.message}`);
			}
		}
		if (!unreviewed.length && !askedUnrecorded.length) return;
		try {
			await this.approvals.writeObserved(path.basename(run.artifacts.dir), {
				worker: run.name,
				piSessionId: this.opts.piSessionId,
				cwd: run.worker?.cwd,
				eventsPath: run.artifacts.eventsPath,
				recordedAt: new Date().toISOString(),
				calls: unreviewed,
				omitted: run.observedOmitted,
				askedPiButNotRecorded: askedUnrecorded.length ? askedUnrecorded.slice(0, MAX_OBSERVED_CALLS) : undefined,
				askedPiButNotRecordedNote: askedUnrecorded.length
					? "Cursor asked Pi about these calls, but the decision could not be written to the history (so none was allowed by Pi). Statuses are only what Cursor reported."
					: undefined,
			});
			run.counts.cursorObservedUnreviewed = unreviewed.length ? unreviewed.length + run.observedOmitted : 0;
		} catch (err) {
			run.notes.push(`Warning: Cursor-observed tool calls were not saved to the approval history: ${err.message}`);
		}
	}

	#observe(run, update) {
		const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId.slice(0, 200) : undefined;
		if (!toolCallId) return;
		const now = new Date().toISOString();
		let call = run.observed.get(toolCallId);
		if (!call) {
			if (run.observed.size >= MAX_OBSERVED_CALLS) {
				// Count each dropped call once, on its first tool_call, not again for its updates.
				if (update.sessionUpdate === "tool_call") run.observedOmitted++;
				return;
			}
			call = { toolCallId, firstSeen: now, updates: 0, reviewedByPi: false };
			run.observed.set(toolCallId, call);
		}
		call.updates++;
		call.lastSeen = now;
		if (typeof update.status === "string") call.status = update.status.slice(0, 40);
		if (typeof update.title === "string" || typeof update.kind === "string" || update.rawInput !== undefined) {
			const s = summarizeToolCall({ ...update, title: update.title ?? call.title, kind: update.kind ?? call.kind });
			call.title = s.title;
			call.kind = s.kind;
			if (s.input) call.input = s.input;
			if (s.locations.length) call.locations = s.locations;
		}
	}

	/** Human dialogs are serialized across all workers of this manager so prompts never overlap. */
	async #askHuman(run, request) {
		const previous = this.dialogQueue;
		let release;
		this.dialogQueue = new Promise((r) => (release = r));
		let acquired = false;
		try {
			await untilAborted(previous, run.dialogs.signal);
			acquired = true;
			return (await untilAborted(Promise.resolve().then(() => run.askPermission(request, run.dialogs.signal)), run.dialogs.signal)) === true;
		} catch {
			return false;
		} finally {
			// A waiter that gives up before its turn must not let the next one skip the dialog still open ahead of it.
			if (acquired) release();
			else previous.then(release);
		}
	}

	/**
	 * At most two bounded model reviews of one request under one shared deadline. Never rejects: oversize or missing
	 * details skip the model, and a missing reviewer, failure, timeout, or abort all become decision "ask". Only a valid
	 * first "ask" gets a second opinion; a first deny, any error, and a second ask are final. The deadline holds even if
	 * the reviewer ignores its abort signal.
	 */
	async #review(worker, run, params) {
		const started = Date.now();
		const profile = run.reviewProfile;
		const input = {
			task: run.task,
			worker: worker.name,
			cwd: worker.cwd,
			mode: worker.mode,
			constraints: TASK_PREAMBLE,
			params,
			profile,
			scratchDir: run.scratchDir,
			stateDir: this.opts.stateDir,
			userContext: run.userContext,
		};
		const built = buildReviewPrompt(input);
		if (built.escalate) return { decision: "ask", reason: built.escalate, skipped: true, inputChars: built.chars, passes: [] };
		if (typeof run.reviewPermission !== "function") return { decision: "ask", reason: "no Pi reviewer is available (no active Pi model)", skipped: true, passes: [] };
		const dialogs = run.dialogs.signal;
		if (dialogs.aborted) return { decision: "ask", reason: "review was cancelled", aborted: true, passes: [] };
		const ac = new AbortController();
		const onAbort = () => ac.abort();
		dialogs.addEventListener("abort", onAbort, { once: true });
		let timer;
		const deadline = new Promise((resolve) => {
			const seconds = this.opts.reviewTimeoutMs / 1000;
			timer = setTimeout(() => resolve({ decision: "ask", reason: `review timed out after ${seconds}s`, timedOut: true }), this.opts.reviewTimeoutMs);
			ac.signal.addEventListener("abort", () => resolve({ decision: "ask", reason: "review was cancelled", aborted: true }), { once: true });
		});
		const reviewer = run.reviewPermission;
		if (typeof reviewer.model === "string") run.reviewModel = reviewer.model;
		const passes = [];
		let result;
		let inputChars = built.chars;
		try {
			for (let pass = 1; pass <= 2; pass++) {
				let prompt = built.prompt;
				if (pass === 2) {
					const second = buildReviewPrompt({ ...input, firstReview: { decision: "ask", reason: result.reason } });
					if (second.escalate) {
						result = { decision: "ask", reason: `no second opinion: ${second.escalate}`, skipped: true };
						break;
					}
					prompt = second.prompt;
					inputChars = second.chars;
					run.counts.secondOpinions++;
				}
				const passStarted = Date.now();
				const call = Promise.resolve().then(() => reviewer({ prompt, profile, pass, worker: worker.name, cwd: worker.cwd, scratchDir: run.scratchDir }, ac.signal));
				// Usage counts whenever the reviewer reports it, including failed or late answers that arrive before the run ends.
				call.then(
					(r) => {
						if (!run.finished) run.reviewUsage = addUsage(run.reviewUsage, r?.usage);
					},
					() => {},
				);
				result = await Promise.race([
					call.then(normalizeReview, (err) => ({ decision: "ask", reason: `reviewer failed: ${String(err?.message ?? err).slice(0, 200)}`, error: true })),
					deadline,
				]);
				if (result.model) run.reviewModel = result.model;
				passes.push({ pass, ...result, model: run.reviewModel, durationMs: Date.now() - passStarted });
				if (result.decision !== "ask" || result.error || result.timedOut || result.aborted) break;
			}
			return { ...result, model: run.reviewModel, profile, passes, inputChars, durationMs: Date.now() - started };
		} finally {
			clearTimeout(timer);
			dialogs.removeEventListener("abort", onAbort);
			ac.abort();
		}
	}

	async #prompt(worker, run, task, onProgress) {
		this.#checkRun(run);
		run.phase = "prompt";
		const started = Date.now();
		let last = 0;
		run.emit = () => {
			const now = Date.now();
			if (!onProgress || run.finished || now - last < 1000) return;
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
			worker.conn.request("session/prompt", { sessionId: worker.sessionId, prompt: [{ type: "text", text: buildPrompt(task, { scratchDir: run.scratchDir }) }] }, { timeoutMs: 0 }),
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
		endRun(run);
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
		const permissions = permissionSummary(run, a.eventsPath, this.approvals.dir);
		if (permissions) lines.push("", permissions);
		if (run.counts.cursorObservedUnreviewed) {
			lines.push("", `Cursor also reported ${run.counts.cursorObservedUnreviewed} tool call(s) it ran or attempted without asking Pi (Cursor-observed, not Pi-reviewed; see /approvals).`);
		}
		lines.push("", `Artifacts: ${a.dir} (run scratch: ${path.relative(a.dir, run.scratchDir) || run.scratchDir}, kept)`);
		return {
			usage: structuredClone(run.reviewUsage),
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
				permissionPolicy: this.opts.permissionPolicy,
				reviewProfile: this.opts.permissionPolicy === "review" ? run.reviewProfile : undefined,
				blockedDecisionIds: run.blocked.length ? run.blocked.slice(0, BLOCKED_SHOWN).map((b) => b.id) : undefined,
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
