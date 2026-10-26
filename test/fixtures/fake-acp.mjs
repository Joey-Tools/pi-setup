// Deterministic fake Cursor ACP agent. Behavior is driven by FAKE_ACP_CONFIG (JSON) and by commands in the task text.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const cfg = JSON.parse(process.env.FAKE_ACP_CONFIG || "{}");
const log = (obj) => cfg.logFile && fs.appendFileSync(cfg.logFile, `${JSON.stringify({ pid: process.pid, ...obj })}\n`);
// One file per session so concurrent fake processes never overwrite each other's sessions.
const sessionFile = (id) => path.join(cfg.stateDir, `${id}.json`);
const loadSession = (id) => {
	try {
		return JSON.parse(fs.readFileSync(sessionFile(id), "utf8"));
	} catch {
		return undefined;
	}
};
const saveSession = (id, data) => {
	fs.mkdirSync(cfg.stateDir, { recursive: true });
	const tmp = `${sessionFile(id)}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data));
	fs.renameSync(tmp, sessionFile(id));
};
let sessionCounter = 0;
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const say = (sessionId, text) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextId = 1000;
const pendingClient = new Map();
const requestClient = (method, params) =>
	new Promise((resolve) => {
		const id = nextId++;
		pendingClient.set(id, resolve);
		send({ id, method, params });
	});

let paramPicker = false;
let stubborn = false;
const live = new Map();
const MODES = { currentModeId: "agent", availableModes: ["agent", "plan", "ask"].map((id) => ({ id, name: id })) };

function makeConfig() {
	const opts = (values) => values.map((value) => ({ value, name: value }));
	const config = [{ id: "model", name: "Model", type: "select", currentValue: "composer-2", options: opts(["composer-2", "claude-opus-5-5", "gpt-x"]) }];
	if (paramPicker) {
		config.push(
			{ id: "context", type: "select", currentValue: "300k", options: opts(cfg.contextOptions ?? ["300k", "1m"]) },
			{ id: "effort", type: "select", currentValue: "medium", options: [{ group: "levels", name: "Effort", options: opts(["low", "medium", "high", "xhigh", "max"]) }] },
			{ id: "fast", type: "select", currentValue: "true", options: opts(["true", "false"]) },
		);
	}
	return config;
}

const questionFallback = (sessionId) => ({
	sessionId,
	toolCall: { toolCallId: "tc9_q0", title: "Delete the database?" },
	options: [
		{ optionId: "yes", name: "yes", kind: "allow_once" },
		{ optionId: "no", name: "no", kind: "allow_once" },
		{ optionId: "__ask_question_skip__", name: "Skip", kind: "reject_once" },
	],
});

const current = (s) => Object.fromEntries(s.config.map((o) => [o.id, o.currentValue]));

function openSession(id) {
	const s = { id, config: makeConfig(), mode: "agent", cancel: undefined };
	live.set(id, s);
	return s;
}

async function prompt(s, text) {
	const task = /<task>\n([\s\S]*)\n<\/task>/.exec(text)?.[1] ?? text;
	const stored = loadSession(s.id);
	const c = current(s);
	log({ method: "session/prompt", task, config: c, mode: s.mode, preamble: text.includes("concise handoff") });
	if (cfg.requireProfile !== false && (c.model !== "claude-opus-5-5" || c.context !== "1m" || !["high", "xhigh", "max"].includes(c.effort) || c.fast !== "false")) {
		throw Object.assign(new Error(`profile not applied: ${JSON.stringify(c)}`), { code: -32000 });
	}
	const [cmd, ...rest] = task.trim().split(/\s+/);
	const arg = rest.join(" ");
	let reply = "";
	let stopReason = "end_turn";
	s.cancelled = false;
	const out = (t) => {
		reply += t;
		say(s.id, t);
	};
	switch (cmd) {
		case "REMEMBER":
			stored.memory = arg;
			out("OK");
			break;
		case "RECALL":
			out(`secret=${stored.memory ?? "none"}`);
			break;
		case "ECHO":
			out(arg.slice(0, Math.ceil(arg.length / 2)));
			out(arg.slice(Math.ceil(arg.length / 2)));
			break;
		case "THINK":
			update(s.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private thinking" } });
			update(s.id, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read", status: "pending" });
			update(s.id, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "tool output text" } }] });
			out("visible answer");
			break;
		case "PERMISSION":
		case "PERMISSION_NO_ONCE": {
			const options =
				cmd === "PERMISSION"
					? [
							{ optionId: "aa", name: "Always", kind: "allow_always" },
							{ optionId: "ao", name: "Once", kind: "allow_once" },
							{ optionId: "ro", name: "Reject", kind: "reject_once" },
						]
					: [
							{ optionId: "aa", name: "Always", kind: "allow_always" },
							{ optionId: "ra", name: "Reject always", kind: "reject_always" },
						];
			const res = await requestClient("session/request_permission", {
				sessionId: s.id,
				toolCall: { toolCallId: "p1", title: "Run rm -rf build", kind: "execute", rawInput: { command: "rm -rf build" } },
				options,
			});
			out(`permission=${JSON.stringify(res.result?.outcome ?? res.error)}`);
			break;
		}
		case "ASK_QUESTION": {
			// Mirrors Cursor: an error reply to cursor/ask_question falls back to a permission request offering the answers.
			const res = await requestClient("cursor/ask_question", { sessionId: s.id, toolCallId: "tc9", questions: [{ question: "Delete the database?", options: ["yes", "no"] }] });
			if (!res.error) {
				out(`question=${JSON.stringify(res.result)}`);
				break;
			}
			const fb = await requestClient("session/request_permission", questionFallback(s.id));
			out(`fallback=${JSON.stringify(fb.result?.outcome)}`);
			break;
		}
		case "QUESTION_FALLBACK":
		case "MULTI_ALLOW": {
			const params =
				cmd === "QUESTION_FALLBACK"
					? questionFallback(s.id)
					: {
							sessionId: s.id,
							toolCall: { toolCallId: "p2", title: "Pick one" },
							options: [
								{ optionId: "a", kind: "allow_once" },
								{ optionId: "b", kind: "allow_once" },
								{ optionId: "r", kind: "reject_once" },
							],
						};
			const res = await requestClient("session/request_permission", params);
			out(`permission=${JSON.stringify(res.result?.outcome)}`);
			break;
		}
		case "INBAND_ERROR":
			out("Error: [unauthenticated] Please sign in to continue");
			break;
		case "TRAILING_ERROR":
			out("did some work");
			out("\n\nError: tool exploded");
			break;
		case "UNKNOWN_REQ": {
			const res = await requestClient("fs/read_text_file", { sessionId: s.id, path: "/etc/hosts" });
			out(`unknown=${res.error?.code}`);
			break;
		}
		case "HANG":
			out("starting...");
			await new Promise((r) => (s.cancel = r));
			stopReason = "cancelled";
			break;
		case "STUBBORN":
			stubborn = true;
			process.on("SIGTERM", () => log({ event: "ignored SIGTERM" }));
			out("never stopping");
			await new Promise(() => {});
			break;
		case "CRASH":
			out("about to crash");
			setTimeout(() => process.exit(3), 20);
			await new Promise(() => {});
			break;
		case "MALFORMED":
			process.stdout.write("this is not json\n");
			process.stdout.write('{"jsonrpc":"1.0","id":1}\n');
			out("survived");
			break;
		case "OVERSIZE":
			process.stdout.write("x".repeat(Number(arg)));
			await new Promise(() => {});
			break;
		case "BIG": {
			const n = Number(arg);
			for (let i = 0; i < n; i += 1000) out("A".repeat(Math.min(1000, n - i - 3)));
			out("END");
			break;
		}
		case "SLOW":
			await sleep(Number(arg));
			out("slow done");
			break;
		case "REFUSE":
			out("no");
			stopReason = "refusal";
			break;
		default:
			out(`did: ${task}`);
	}
	if (s.cancelled) stopReason = "cancelled";
	// Cursor can change the model behind the client's back (e.g. session/load restores the last model); no notification.
	if (cfg.driftAfterPrompt) s.config.find((o) => o.id === "model").currentValue = "composer-2";
	stored.history.push({ user: task, agent: reply });
	saveSession(s.id, stored);
	return { stopReason };
}

async function handle(msg) {
	const p = msg.params ?? {};
	switch (msg.method) {
		case "initialize":
			paramPicker = p.clientCapabilities?._meta?.parameterizedModelPicker === true;
			log({ method: "initialize", params: p });
			if (cfg.hangInitialize) return new Promise(() => {});
			return { protocolVersion: 1, agentCapabilities: { loadSession: !cfg.noLoad }, authMethods: [] };
		case "session/new": {
			const id = `sess-${process.pid}-${Date.now()}-${++sessionCounter}`;
			saveSession(id, { cwd: p.cwd, history: [] });
			const s = openSession(id);
			log({ method: "session/new", cwd: p.cwd, sessionId: id });
			return { sessionId: id, modes: MODES, models: { currentModelId: "composer-2" }, configOptions: s.config };
		}
		case "session/load": {
			log({ method: "session/load", sessionId: p.sessionId, cwd: p.cwd });
			if (cfg.loadFail) throw Object.assign(new Error("Session not found"), { code: -32002 });
			const stored = /^[\w-]+$/.test(p.sessionId ?? "") ? loadSession(p.sessionId) : undefined;
			if (!stored) throw Object.assign(new Error("unknown session"), { code: -32002 });
			for (const h of stored.history) {
				update(p.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: h.user } });
				say(p.sessionId, h.agent);
			}
			const s = openSession(p.sessionId);
			return { modes: MODES, models: { currentModelId: "composer-2" }, configOptions: s.config };
		}
		case "session/set_config_option": {
			if (cfg.slowConfigMs) await sleep(cfg.slowConfigMs);
			const s = live.get(p.sessionId);
			const option = s?.config.find((o) => o.id === p.configId);
			log({ method: "session/set_config_option", configId: p.configId, value: p.value });
			const offered = (option?.options ?? []).flatMap((o) => (o.options ? o.options : [o])).map((o) => o.value);
			if (!option || typeof p.value !== "string" || !offered.includes(p.value)) throw Object.assign(new Error("Invalid value"), { code: -32602 });
			if (!(cfg.effortStuck && p.configId === "effort")) option.currentValue = p.value;
			if (p.configId === "model") s.config.find((o) => o.id === "context") && (s.config.find((o) => o.id === "context").currentValue = "300k");
			return { configOptions: s.config };
		}
		case "session/set_mode": {
			const s = live.get(p.sessionId);
			log({ method: "session/set_mode", modeId: p.modeId });
			if (!MODES.availableModes.some((m) => m.id === p.modeId)) throw Object.assign(new Error("bad mode"), { code: -32602 });
			s.mode = p.modeId;
			return {};
		}
		case "session/prompt":
			return prompt(live.get(p.sessionId), p.prompt?.[0]?.text ?? "");
		default:
			throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
	}
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const msg = JSON.parse(line);
	if (msg.id !== undefined && !msg.method) {
		pendingClient.get(msg.id)?.(msg);
		pendingClient.delete(msg.id);
		return;
	}
	if (msg.id === undefined) {
		log({ notification: msg.method, params: msg.params });
		if (msg.method === "session/cancel") {
			const s = live.get(msg.params?.sessionId);
			if (s) s.cancelled = true;
			s?.cancel?.();
		}
		return;
	}
	Promise.resolve()
		.then(() => handle(msg))
		.then(
			(result) => send({ id: msg.id, result }),
			(err) => send({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } }),
		);
});
rl.on("close", () => stubborn || process.exit(0));
