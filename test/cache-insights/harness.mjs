// Test harness for cache insights: synthetic session history, the CLI, and the extension's public hooks/command.
// All fixtures are synthetic. SENTINEL marks content, ids, and paths that must never reach storage or output.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerCacheInsights, STATUS_KEY } from "../../lib/cache-insights/index.mjs";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI = path.join(REPO, "scripts", "cache-insights.mjs");
export const SENTINEL = "SENTINEL-PRIVATE-7f3a";
export const MIN = 60_000;
export const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);
export const SOL = { provider: "github-copilot", model: "gpt-6.1-sol" };

/** Fresh temp layout: agent dir (with sessions/), and a separate workspace cwd. */
export function tmpEnv(t) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ci-")));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const agentDir = path.join(dir, "agent");
	const sessionsDir = path.join(agentDir, "sessions", `--${SENTINEL}-project--`);
	const workspace = path.join(dir, "workspace");
	fs.mkdirSync(sessionsDir, { recursive: true });
	fs.mkdirSync(workspace);
	return { dir, agentDir, sessionsRoot: path.join(agentDir, "sessions"), sessionsDir, workspace, root: path.join(agentDir, "cache-insights"), dbPath: path.join(agentDir, "cache-insights", "cache-insights.sqlite") };
}

export function usage(input, cacheRead, cacheWrite, output = 100) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + cacheRead + cacheWrite + output,
		cost: { input: input * 2e-6, output: output * 8e-6, cacheRead: cacheRead * 2e-7, cacheWrite: 0, total: input * 2e-6 + output * 8e-6 + cacheRead * 2e-7 },
	};
}

const iso = (ms) => new Date(ms).toISOString();

/** Builds a Pi-style session JSONL file (header + id/parentId tree), with content fields full of SENTINEL. */
export class SessionFile {
	constructor({ legacy = false, tag = "s" } = {}) {
		this.legacy = legacy;
		this.tag = tag;
		this.lines = [{ type: "session", version: legacy ? 1 : 3, id: `${SENTINEL}-session-${tag}`, timestamp: iso(T0 - 600 * MIN), cwd: `/Users/${SENTINEL}/project` }];
		this.leaf = null;
		this.n = 0;
		this.lastStart = null;
	}
	add(entry) {
		const id = `${SENTINEL}-${this.tag}-${++this.n}`;
		this.lines.push(this.legacy ? entry : { id, parentId: this.leaf, ...entry });
		this.leaf = id;
		return id;
	}
	user(at) {
		return this.add({ type: "message", timestamp: iso(at), message: { role: "user", content: [{ type: "text", text: `${SENTINEL} prompt` }], timestamp: at } });
	}
	toolResult(at) {
		return this.add({ type: "message", timestamp: iso(at), message: { role: "toolResult", toolCallId: `${SENTINEL}-call`, toolName: "bash", content: [{ type: "text", text: `${SENTINEL} output` }], isError: false, timestamp: at } });
	}
	assistant({ start, end, usage: u, stop = "toolUse", provider = SOL.provider, model = SOL.model, responseModel }) {
		const message = { role: "assistant", content: [{ type: "text", text: `${SENTINEL} answer` }, { type: "toolCall", id: `${SENTINEL}-call`, name: "bash", arguments: { command: `cat /Users/${SENTINEL}/secret` } }], api: "openai-responses", provider, model, usage: u, stopReason: stop, timestamp: start };
		if (responseModel) message.responseModel = responseModel;
		if (stop === "error") message.errorMessage = `${SENTINEL} 401 Authorization: Bearer ${SENTINEL}`;
		this.lastStart = start;
		return this.add({ type: "message", timestamp: iso(end), message });
	}
	/** One user turn: user message, then a response `gap` after the previous response's start, lasting `dur`. */
	turn({ gap, dur = 30_000, u = usage(200, 10_000, 0), stop, provider, model, start }) {
		const s = start ?? this.lastStart + gap;
		this.user(s - 1000);
		this.assistant({ start: s, end: s + dur, usage: u, stop, provider, model });
		return s;
	}
	modelChange(at, provider, model) {
		return this.add({ type: "model_change", timestamp: iso(at), provider, modelId: model });
	}
	thinkingChange(at, level) {
		return this.add({ type: "thinking_level_change", timestamp: iso(at), thinkingLevel: level });
	}
	system(at) {
		return this.add({ type: "message", timestamp: iso(at), message: { role: "system", content: `${SENTINEL} system prompt`, timestamp: at } });
	}
	compaction(at) {
		return this.add({ type: "compaction", timestamp: iso(at), summary: `${SENTINEL} summary`, firstKeptEntryId: this.leaf, tokensBefore: 50_000 });
	}
	warm(at, u = usage(1, 10_000, 0, 1)) {
		return this.add({ type: "usage", timestamp: iso(at), kind: "cache_warm", provider: SOL.provider, model: SOL.model, usage: u, note: `${SENTINEL} note` });
	}
	custom(at) {
		return this.add({ type: "custom", timestamp: iso(at), customType: "progress-updates-state", data: { enabled: true, note: SENTINEL } });
	}
	branchFrom(id) {
		this.leaf = id;
	}
	/** Entries on the current branch (root → leaf), as ctx.sessionManager.getBranch() returns. */
	branch() {
		const byId = new Map(this.lines.filter((e) => e.id).map((e) => [e.id, e]));
		const out = [];
		for (let id = this.leaf; id; id = byId.get(id)?.parentId) out.unshift(byId.get(id));
		return out;
	}
	write(dir, name = `${SENTINEL}-${this.tag}.jsonl`) {
		const file = path.join(dir, name);
		fs.writeFileSync(file, `${this.lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		return file;
	}
}

/** Runs the CLI in the workspace with an explicit --agent-dir; never the real home. */
export function cli(env, args, { json = true } = {}) {
	const childEnv = { ...process.env };
	delete childEnv.PI_CODING_AGENT_DIR;
	const r = spawnSync(process.execPath, [CLI, ...args, "--agent-dir", env.agentDir, ...(json ? ["--json"] : [])], { cwd: env.workspace, env: childEnv, encoding: "utf8" });
	let data;
	if (json && r.status === 0) data = JSON.parse(r.stdout);
	return { status: r.status, stdout: r.stdout, stderr: r.stderr, data };
}

/**
 * Loads the extension through its public registration with a mocked Pi API and context. `pi` throws on any
 * call that could send a model request or change Pi state; the model registry has no usable methods.
 */
export function loadExtension(t, env, { mode = "tui", hasUI = mode === "tui" || mode === "rpc", model = { ...SOL }, branch = [], confirm = true, thinking = "high", loadSqlite, baseline = { status: "unchanged" }, menuUI = true, theme } = {}) {
	const clock = { w: T0, m: 1_000_000 };
	// `baseline` is the injected startup/resume configuration check: an object result, or a function (ctx, pi) => result.
	const h = { env, clock, branch, notes: [], statuses: [], confirms: [], uiErrors: [], timers: new Set(), baseline, baselineCalls: 0 };
	// Scripted dialogs: answers are shifted from h.queue[kind]; a string, a RegExp matched against the offered choices,
	// or { defer: true } for a promise resolved later through h.pending. An empty queue answers undefined (Esc).
	Object.assign(h, { queue: { select: [], input: [], confirm: [], editor: [] }, pending: [], selects: [], inputs: [], editors: [] });
	h.script = ({ select = [], input = [], confirm: c = [], editor = [] } = {}) => {
		h.queue.editor.push(...editor);
		h.queue.select.push(...select);
		h.queue.input.push(...input);
		h.queue.confirm.push(...c);
	};
	const answer = (kind, choices) => {
		const a = h.queue[kind].shift();
		if (a && typeof a === "object" && a.defer) return new Promise((resolve) => h.pending.push({ kind, resolve }));
		if (a instanceof RegExp) return choices?.find((c) => a.test(c));
		return a;
	};
	const handlers = new Map();
	const commands = new Map();
	const forbidden = (name) => () => {
		throw new Error(`forbidden ${name}`);
	};
	const pi = {
		on: (event, fn) => (handlers.has(event) ? handlers.get(event) : handlers.set(event, []).get(event)).push(fn),
		registerCommand: (name, options) => commands.set(name, options),
		getThinkingLevel: () => thinking,
		...Object.fromEntries(["sendMessage", "sendUserMessage", "appendEntry", "setModel", "setThinkingLevel", "setActiveTools", "exec", "registerTool"].map((n) => [n, forbidden(n)])),
	};
	const ui = {
		notify: (message, level) => {
			if (!hasUI) h.uiErrors.push("notify without UI");
			h.notes.push([level, message]);
		},
		setStatus: (key, text) => {
			if (mode !== "tui") h.uiErrors.push(`setStatus in ${mode}`);
			h.statuses.push([key, text]);
		},
		confirm: async (title, message) => {
			h.confirms.push([title, message]);
			return h.queue.confirm.length ? answer("confirm") : confirm;
		},
	};
	if (theme) ui.theme = theme;
	if (menuUI) {
		ui.select = async (title, choices, opts) => {
			if (mode !== "tui") h.uiErrors.push(`select in ${mode}`);
			h.selects.push({ title, choices, signal: opts?.signal });
			return answer("select", choices);
		};
		ui.input = async (title, placeholder, opts) => {
			if (mode !== "tui") h.uiErrors.push(`input in ${mode}`);
			h.inputs.push({ title, placeholder, signal: opts?.signal });
			return answer("input");
		};
		ui.editor = async (title, text) => {
			if (mode !== "tui") h.uiErrors.push(`editor in ${mode}`);
			h.editors.push({ title, text });
			return h.queue.editor.length ? answer("editor") : `${text}\nEDITED BY USER`;
		};
	}
	h.ctx = {
		mode,
		hasUI,
		cwd: env.workspace,
		ui,
		model: model && { provider: model.provider, id: model.model, api: "openai-responses", cost: model.cost },
		modelRegistry: { streamSimple: forbidden("streamSimple"), getApiKey: forbidden("getApiKey"), find: forbidden("find") },
		sessionManager: { getSessionId: () => `${SENTINEL}-session`, getBranch: () => h.branch },
	};
	// Fake scheduler on the monotonic clock, like real timers: callbacks run only when due (see h.tick).
	const schedule = (fn, ms, every) => {
		const handle = { fn, due: clock.m + ms, every, unref() {} };
		h.timers.add(handle);
		return handle;
	};
	const cancel = (handle) => h.timers.delete(handle);
	const timers = { setInterval: (fn, ms) => schedule(fn, ms, ms), clearInterval: cancel, setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: cancel };
	h.insights = registerCacheInsights(pi, { env: { PI_CODING_AGENT_DIR: env.agentDir }, sessionsDir: env.sessionsRoot, clock: { wall: () => clock.w, mono: () => clock.m }, timers, loadSqlite, resolveBaseline: (...a) => (h.baselineCalls++, typeof h.baseline === "function" ? h.baseline(...a) : h.baseline) });
	h.handlers = handlers;
	h.commands = commands;
	h.advance = (ms) => {
		clock.w += ms;
		clock.m += ms;
	};
	h.at = (wall) => {
		h.advance(wall - clock.w);
	};
	h.emit = async (type, event = {}) => {
		const out = [];
		for (const fn of handlers.get(type) ?? []) out.push(await fn({ type, ...event }, h.ctx));
		return out;
	};
	h.command = (args) => commands.get("cache").handler(args, h.ctx);
	/** Runs every timer that is due at the current monotonic time, in due order, and returns the status text. */
	h.tick = async () => {
		for (let i = 0; i < 1000; i++) {
			let next = null;
			for (const t of h.timers) if (t.due <= clock.m && (!next || t.due < next.due)) next = t;
			if (!next) break;
			// Like Node: an overdue interval fires once, then reschedules from the time it fired.
			if (next.every) next.due = next.due + next.every > clock.m ? next.due + next.every : clock.m + next.every;
			else h.timers.delete(next);
			await next.fn();
		}
		return h.status();
	};
	h.status = () => h.statuses.filter(([k]) => k === STATUS_KEY).at(-1)?.[1];
	h.lastNote = () => h.notes.at(-1)?.[1];
	/** A live provider call: message_start, then message_end `dur` later; returns the request start. */
	h.respond = async ({ dur = 30_000, u = usage(200, 10_000, 0), stop = "toolUse", provider = SOL.provider, model: m = SOL.model, responseModel } = {}) => {
		const start = clock.w;
		const message = { role: "assistant", content: [{ type: "text", text: `${SENTINEL} live` }], api: "openai-responses", provider, model: m, usage: u, stopReason: stop, timestamp: start };
		if (responseModel) message.responseModel = responseModel;
		if (stop === "error") message.errorMessage = `${SENTINEL} failure`;
		await h.emit("message_start", { message: { ...message, content: [] } });
		h.advance(dur);
		await h.emit("message_end", { message });
		return start;
	};
	return h;
}

/** Every byte of the database file, decoded loosely, for sentinel scans. */
export const dbBytes = (env) => (fs.existsSync(env.dbPath) ? fs.readFileSync(env.dbPath).toString("latin1") : "");
