import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import progressUpdates from "../extensions/progress-update.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WIDGET = "pi-progress-updates";
const SECTION = "progress_updates";
const STATE = "progress-updates-state";
const HOOKS = ["session_start", "session_tree", "session_shutdown", "before_agent_start", "agent_start", "message_end", "agent_settled"];

/** Loads the extension against a mocked ExtensionAPI; `mode` and `hasUI` mirror ExtensionContext. */
function load({ mode = "tui", hasUI = mode === "tui" || mode === "rpc", branch = [] } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const h = { entries: [...branch], widgets: [], notes: [], appended: [], uiErrors: [] };
	const pi = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
			return () => {};
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		appendEntry(customType, data) {
			h.appended.push({ customType, data });
			h.entries.push({ type: "custom", customType, data });
		},
	};
	const ui = {
		setWidget(key, content) {
			if (mode !== "tui") h.uiErrors.push(`setWidget in ${mode}`);
			h.widgets.push([key, content]);
		},
		notify(message, level) {
			if (!hasUI) h.uiErrors.push(`notify without UI: ${message}`);
			h.notes.push([level, message]);
		},
	};
	const ctx = { mode, hasUI, ui, sessionManager: { getBranch: () => h.entries } };
	progressUpdates(pi);
	h.handlers = handlers;
	h.commands = commands;
	h.ctx = ctx;
	h.emit = async (type, event = {}) => {
		const results = [];
		for (const handler of handlers.get(type) ?? []) results.push(await handler({ type, ...event }, ctx));
		return results;
	};
	h.command = (args) => commands.get("progress").handler(args, ctx);
	h.widget = () => h.widgets.filter(([key]) => key === WIDGET).at(-1)?.[1];
	h.lastNote = () => h.notes.at(-1);
	h.beforeStart = async (sections = {}) => {
		const systemPromptOptions = { sections, promptGuidelines: ["Use cursor_worker to delegate expensive exploration"], selectedTools: ["read", "cursor_worker"] };
		const results = await h.emit("before_agent_start", { messageType: "user", prompt: "do it", systemPrompt: "base prompt", systemPromptOptions });
		return { results, systemPromptOptions };
	};
	h.newRun = async () => {
		await h.beforeStart();
		await h.emit("agent_start");
	};
	return h;
}

let clock = 1_000;
const sig = (phase) => JSON.stringify({ v: 1, id: `msg_${clock}`, phase });
function assistant(content, { stopReason = "toolUse", timestamp = ++clock } = {}) {
	return { role: "assistant", content, stopReason, timestamp, api: "test", provider: "test", model: "m", usage: {} };
}
const text = (t, textSignature) => ({ type: "text", text: t, ...(textSignature ? { textSignature } : {}) });
const toolCall = { type: "toolCall", id: "call_1", name: "cursor_worker", arguments: { action: "run", name: "w", task: "secret args" } };
const updatesIn = (widget) => (widget ?? []).filter((line) => line.startsWith("› ")).map((line) => line.slice(2));

test("manifest auto-loads the progress extension alongside the Cursor bridge", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi.extensions, ["./extensions/cursor.ts", "./extensions/progress-update.ts", "./extensions/approval-history.ts", "./extensions/cache-insights/index.ts"]);
	for (const ext of manifest.pi.extensions) assert.ok(fs.existsSync(path.join(root, ext)), ext);
	assert.ok(manifest.files.includes("extensions"));
	const source = fs.readFileSync(path.join(root, "extensions", "progress-update.ts"), "utf8");
	assert.doesNotMatch(source, /cursor|\.\.\/lib/i, "independent of the Cursor bridge");
	assert.doesNotMatch(source, /streamSimple|setInterval|setTimeout|sendMessage|sendUserMessage/, "no extra model requests or polling");
});

test("registers /progress and its hooks, enabled by default without writing state", async () => {
	const h = load();
	assert.ok(h.commands.has("progress"));
	assert.match(h.commands.get("progress").description, /on\|off\|clear\|status/);
	for (const hook of HOOKS) assert.equal(h.handlers.get(hook)?.length, 1, hook);
	await h.emit("session_start", { reason: "startup" });
	await h.command("");
	assert.deepEqual(h.lastNote(), ["info", "Progress updates are enabled."]);
	await h.command("status");
	assert.deepEqual(h.lastNote(), ["info", "Progress updates are enabled."]);
	assert.deepEqual(h.appended, []);
});

test("adds its own structured prompt section without forcing the system prompt, and removes it when off", async () => {
	const h = load();
	await h.emit("session_start", { reason: "startup" });
	let { results, systemPromptOptions } = await h.beforeStart({ other_extension: "keep me" });
	assert.deepEqual(results, [undefined], "no forced systemPrompt");
	assert.equal(systemPromptOptions.sections.other_extension, "keep me");
	assert.match(systemPromptOptions.sections[SECTION], /send a concise user-visible progress update/);
	assert.match(systemPromptOptions.sections[SECTION], /separate final answer/);
	assert.deepEqual(systemPromptOptions.promptGuidelines, ["Use cursor_worker to delegate expensive exploration"], "delegation guidance untouched");
	assert.deepEqual(Object.keys(systemPromptOptions.sections).sort(), ["other_extension", SECTION]);

	({ systemPromptOptions } = await h.beforeStart({ other_extension: "keep me", [SECTION]: "stale" }));
	assert.notEqual(systemPromptOptions.sections[SECTION], "stale", "replaces, never duplicates, its own section");

	await h.command("off");
	assert.deepEqual(h.lastNote(), ["info", "Progress updates disabled."]);
	({ results, systemPromptOptions } = await h.beforeStart({ other_extension: "keep me", [SECTION]: "stale" }));
	assert.deepEqual(results, [undefined]);
	assert.deepEqual(systemPromptOptions.sections, { other_extension: "keep me" });

	await h.command("ON");
	({ systemPromptOptions } = await h.beforeStart());
	assert.ok(systemPromptOptions.sections[SECTION]);
	assert.deepEqual(h.appended, [
		{ customType: STATE, data: { enabled: false } },
		{ customType: STATE, data: { enabled: true } },
	]);
});

test("accepts the on/off aliases, writes state only on change, and warns on unknown arguments", async () => {
	const h = load();
	await h.emit("session_start", { reason: "startup" });
	await h.command("enable");
	await h.command("enabled");
	assert.equal(h.appended.length, 0, "already enabled");
	await h.command("disable");
	await h.command("  Disabled ");
	await h.command("status");
	assert.deepEqual(h.lastNote(), ["info", "Progress updates are disabled."]);
	assert.equal(h.appended.length, 1);
	await h.command("enabled");
	assert.equal(h.appended.length, 2);
	await h.command("loud");
	assert.deepEqual(h.lastNote(), ["warning", "Usage: /progress [on|off|clear|status]"]);
});

test("enabled state follows the session branch and defaults to on", async () => {
	const off = { type: "custom", customType: STATE, data: { enabled: false } };
	const on = { type: "custom", customType: STATE, data: { enabled: true } };
	const h = load({ branch: [on, { type: "message" }, off, { type: "custom", customType: "other", data: { enabled: true } }] });
	await h.emit("session_start", { reason: "resume" });
	await h.command("status");
	assert.deepEqual(h.lastNote(), ["info", "Progress updates are disabled."]);

	h.entries.splice(0, h.entries.length);
	await h.emit("session_tree", { newLeafId: "a", oldLeafId: "b" });
	await h.command("status");
	assert.deepEqual(h.lastNote(), ["info", "Progress updates are enabled."], "no branch setting means enabled");

	h.entries.push(off);
	await h.emit("session_tree", { newLeafId: "c", oldLeafId: "a" });
	await h.command("status");
	assert.deepEqual(h.lastNote(), ["info", "Progress updates are disabled."]);
	assert.equal(h.widget(), undefined);

	h.entries.splice(0, h.entries.length);
	await h.emit("session_start", { reason: "new" });
	await h.command("status");
	assert.deepEqual(h.lastNote(), ["info", "Progress updates are enabled."], "a new session does not inherit the old one's setting");
});

test("retries keep the run's history, a new user run resets it, and settled/shutdown clean up", async () => {
	const h = load();
	await h.emit("session_start", { reason: "startup" });
	await h.newRun();
	assert.equal(h.widget(), undefined, "no empty widget at run start");
	await h.emit("message_end", { message: assistant([text("Scouting the repo first."), toolCall]) });
	assert.deepEqual(h.widget(), ["Progress", "› Scouting the repo first."]);

	await h.emit("agent_end", { messages: [] });
	await h.emit("agent_start");
	assert.deepEqual(updatesIn(h.widget()), ["Scouting the repo first."], "retry keeps history");
	await h.emit("message_end", { message: assistant([text("Retry: tests now pass."), toolCall]) });
	await h.emit("agent_settled", { aborted: false });
	assert.deepEqual(updatesIn(h.widget()), ["Scouting the repo first.", "Retry: tests now pass."], "kept after settling");

	await h.emit("message_end", { message: assistant([text("Late, after settle."), toolCall]) });
	assert.equal(updatesIn(h.widget()).length, 2, "nothing collected between runs");

	await h.newRun();
	assert.equal(h.widget(), undefined, "a new user run resets the widget");
	await h.emit("message_end", { message: assistant([text("Second task started."), toolCall]) });
	assert.deepEqual(updatesIn(h.widget()), ["Second task started."]);

	await h.emit("agent_settled", { aborted: true });
	await h.emit("session_shutdown", { reason: "quit" });
	assert.equal(h.widget(), undefined);
	await h.emit("session_shutdown", { reason: "quit" });
	assert.equal(h.widget(), undefined, "shutdown is idempotent");
});

test("collects commentary by phase, falls back to text with tool calls, and never collects reasoning or tool output", async () => {
	const h = load();
	await h.emit("session_start", { reason: "startup" });
	await h.newRun();
	const msgs = [
		assistant([text("Commentary with phase.", sig("commentary")), text("Final answer text.", sig("final_answer")), toolCall]),
		assistant([text("Final only, even with tools.", sig("final_answer")), toolCall]),
		assistant([text("Unphased sibling dropped when a phase exists."), text("Phased commentary.", sig("commentary"))], { stopReason: "stop" }),
		assistant([{ type: "thinking", thinking: "private chain of thought" }, text("Fallback before a tool."), toolCall]),
		assistant([text("Opaque signature falls back.", "opaque-signature-bytes"), toolCall]),
		assistant([text("toolUse stop reason without a tool block.")], { stopReason: "toolUse" }),
		assistant([text("Plain final answer, no tools.")], { stopReason: "stop" }),
		assistant([{ type: "thinking", thinking: "only thinking" }, text("   "), toolCall]),
		{ role: "toolResult", toolCallId: "call_1", toolName: "cursor_worker", content: [text("RAW CURSOR LOG events.jsonl")], timestamp: ++clock },
		{ role: "user", content: [text("user text")], timestamp: ++clock },
	];
	for (const message of msgs) await h.emit("message_end", { message });
	assert.deepEqual(updatesIn(h.widget()), [
		"Commentary with phase.",
		"Phased commentary.",
		"Fallback before a tool.",
		"Opaque signature falls back.",
		"toolUse stop reason without a tool block.",
	]);
	assert.doesNotMatch(JSON.stringify(h.widgets), /private chain|only thinking|RAW CURSOR|user text|Final|secret args/);
});

test("deduplicates a repeated message_end and bounds history and the widget to the newest tail", async () => {
	const h = load();
	await h.emit("session_start", { reason: "startup" });
	await h.newRun();
	const repeated = assistant([text("Same update."), toolCall]);
	await h.emit("message_end", { message: repeated });
	await h.emit("message_end", { message: repeated });
	assert.deepEqual(updatesIn(h.widget()), ["Same update."]);

	for (let i = 2; i <= 9; i++) await h.emit("message_end", { message: assistant([text(`update ${i}`), toolCall]) });
	assert.equal(h.widget().length, 10, "nine updates fit without a marker");
	assert.ok(!h.widget().some((line) => line.includes("truncated")));

	for (let i = 10; i <= 400; i++) await h.emit("message_end", { message: assistant([text(`update ${i}`), toolCall]) });
	const widget = h.widget();
	assert.equal(widget.length, 10, "never exceeds Pi's 10-line array widget");
	assert.deepEqual(widget.slice(0, 2), ["Progress", "... (older progress updates truncated)"]);
	assert.deepEqual(updatesIn(widget), Array.from({ length: 8 }, (_, i) => `update ${393 + i}`));
});

test("sanitizes terminal control sequences and caps each update at 500 characters", async () => {
	const h = load();
	await h.emit("session_start", { reason: "startup" });
	await h.newRun();
	const hostile = [
		"\u001b[31mred\u001b[0m",
		"\u001b]0;evil title\u0007",
		"\u001b]8;;https://example.invalid\u001b\\link\u001b]8;;\u001b\\",
		"\u009b2Jc1",
		"\u001bPdcs payload\u001b\\",
		"\u001b7\u001bc",
		"tab\tand\nnew\r\nlines\u0008\u0000",
		"\u202eoverride\u2069",
	].join(" ");
	await h.emit("message_end", { message: assistant([text(hostile), toolCall]) });
	const [line] = updatesIn(h.widget());
	assert.equal(line, "red link c1 tab and new lines override");
	assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);

	await h.emit("message_end", { message: assistant([text(`${"x".repeat(600)} tail`), toolCall]) });
	const capped = updatesIn(h.widget()).at(-1);
	assert.equal(capped.length, 500);
	assert.ok(capped.endsWith("…"));

	await h.emit("message_end", { message: assistant([text(`${"y".repeat(498)}😀z`), toolCall]) });
	const astral = updatesIn(h.widget()).at(-1);
	assert.ok(astral.length <= 500);
	assert.doesNotMatch(astral, /[\ud800-\udbff](?![\udc00-\udfff])/, "never splits a surrogate pair");
});

test("/progress clear empties history without stopping collection; off stops it", async () => {
	const h = load();
	await h.emit("session_start", { reason: "startup" });
	await h.newRun();
	const first = assistant([text("Before clear."), toolCall]);
	await h.emit("message_end", { message: first });
	await h.command("clear");
	assert.deepEqual(h.lastNote(), ["info", "Progress history cleared."]);
	assert.equal(h.widget(), undefined);
	await h.emit("message_end", { message: first });
	assert.equal(h.widget(), undefined, "a cleared update does not reappear");
	await h.emit("message_end", { message: assistant([text("After clear."), toolCall]) });
	assert.deepEqual(h.widget(), ["Progress", "› After clear."], "still collecting in the active run");
	await h.command("status");
	assert.deepEqual(h.lastNote(), ["info", "Progress updates are enabled."]);

	await h.command("off");
	assert.equal(h.widget(), undefined);
	await h.emit("message_end", { message: assistant([text("Ignored while off."), toolCall]) });
	await h.emit("agent_settled", { aborted: false });
	assert.equal(h.widget(), undefined);
	await h.newRun();
	await h.emit("message_end", { message: assistant([text("Still off."), toolCall]) });
	assert.equal(h.widget(), undefined);
});

for (const mode of ["print", "json", "rpc"]) {
	test(`makes no TUI calls in ${mode} mode but still adds the prompt guidance`, async () => {
		const h = load({ mode });
		await h.emit("session_start", { reason: "startup" });
		const { systemPromptOptions } = await h.beforeStart();
		assert.ok(systemPromptOptions.sections[SECTION]);
		await h.emit("agent_start");
		await h.emit("message_end", { message: assistant([text("Progress text."), toolCall]) });
		await h.emit("agent_settled", { aborted: false });
		for (const args of ["status", "clear", "off", "on", "bogus"]) await h.command(args);
		await h.emit("session_tree", { newLeafId: "x", oldLeafId: "y" });
		await h.emit("session_shutdown", { reason: "quit" });
		assert.deepEqual(h.widgets, []);
		assert.deepEqual(h.uiErrors, []);
		assert.equal(h.notes.length, mode === "rpc" ? 5 : 0, "notifications only where a UI exists");
	});
}
