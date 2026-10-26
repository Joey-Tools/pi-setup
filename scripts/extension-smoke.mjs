// Offline check that extensions/cursor.ts loads in Pi's real extension loader and works end to end
// against the fake ACP agent. No model calls and no real Cursor process.
// Needs the Pi package: set PI_PACKAGE_DIR=/path/to/node_modules/@earendil-works/pi-coding-agent
// (or have it resolvable from this directory).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let entry;
if (process.env.PI_PACKAGE_DIR) entry = pathToFileURL(path.join(process.env.PI_PACKAGE_DIR, "dist", "index.js")).href;
else {
	try {
		entry = import.meta.resolve("@earendil-works/pi-coding-agent");
	} catch {
		console.error("Set PI_PACKAGE_DIR to the @earendil-works/pi-coding-agent package directory.");
		process.exit(2);
	}
}
const pi = await import(entry);

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-cursor-ext-")));
const project = path.join(tmp, "project");
fs.mkdirSync(project);
Object.assign(process.env, {
	PI_CURSOR_COMMAND: process.execPath,
	PI_CURSOR_ARGS: JSON.stringify([path.join(root, "test", "fixtures", "fake-acp.mjs")]),
	PI_CURSOR_STATE_DIR: path.join(tmp, "state"),
	FAKE_ACP_CONFIG: JSON.stringify({ stateDir: path.join(tmp, "fake-sessions") }),
});
delete process.env.PI_CURSOR_PERMISSIONS;

try {
	const result = await pi.discoverAndLoadExtensions([path.join(root, "extensions", "cursor.ts")], project, path.join(tmp, "agent"));
	assert.deepEqual(result.errors, [], JSON.stringify(result.errors));
	const ext = result.extensions.find((e) => e.tools.has("cursor_worker"));
	assert.ok(ext, "cursor_worker tool registered");
	assert.ok(ext.commands.has("cursor-workers"), "/cursor-workers registered");
	const tool = ext.tools.get("cursor_worker").definition;
	assert.ok(tool.promptGuidelines.length > 0);
	assert.equal(tool.parameters.additionalProperties, false);
	for (const forbidden of ["model", "context", "effort", "fast", "permissions"]) assert.ok(!(forbidden in tool.parameters.properties), forbidden);

	// Pi binds action methods when a session starts; mirror that for the thinking level the reviewer reads.
	result.runtime.getThinkingLevel = () => "xhigh";
	// Stub of the active Pi model and ctx.modelRegistry.streamSimple: no network, answers from a queue.
	const piModel = { provider: "smoke-provider", id: "smoke-active-model", reasoning: true };
	const reviewCalls = [];
	const answers = [];
	const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } };
	const modelRegistry = {
		streamSimple(model, context, options) {
			reviewCalls.push({ model, context, options });
			const text = answers.shift() ?? "not json";
			return { result: async () => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage, model: model.id, provider: model.provider }) };
		},
	};
	const notes = [];
	const confirms = [];
	const ctx = {
		cwd: project,
		hasUI: false,
		mode: "print",
		model: piModel,
		modelRegistry,
		sessionManager: { getSessionId: () => "ext-smoke-session" },
		ui: { notify: (msg, type) => notes.push([type, msg]), confirm: async (title, message) => (confirms.push(message), true) },
	};
	const updates = [];
	let res = await tool.execute("c1", { action: "run", name: "w", task: "REMEMBER fig" }, undefined, (u) => updates.push(u), ctx);
	assert.match(res.content[0].text, /model=claude-opus-5-5 context=1m effort=high fast=false/);

	// Default policy review: the active Pi model approves once, with no tools, no history, low thinking.
	answers.push('{"decision":"approve","reason":"routine cleanup inside the task"}');
	res = await tool.execute("c2", { action: "run", name: "w", task: "PERMISSION" }, undefined, undefined, ctx);
	assert.match(res.content[0].text, /"optionId":"ao"/, "review approval selects allow_once");
	assert.match(res.content[0].text, /Pi's model \(smoke-provider\/smoke-active-model\) reviewed 1 Cursor permission request\(s\): 1 approved/);
	assert.deepEqual(res.usage, usage, "reviewer usage is reported on the tool result");
	const call = reviewCalls[0];
	assert.equal(call.model, piModel, "reviewer uses ctx.model");
	assert.equal(call.context.tools, undefined);
	assert.equal(call.context.messages.length, 1);
	assert.match(call.context.messages[0].content[0].text, /rm -rf build/);
	assert.equal(call.options.reasoning, "low");
	assert.ok(call.options.maxTokens > 0 && call.options.maxTokens <= 4096);
	assert.ok(call.options.signal instanceof AbortSignal);

	answers.push('{"decision":"ask","reason":"deletes files"}');
	res = await tool.execute("c2b", { action: "run", name: "w", task: "PERMISSION" }, undefined, undefined, ctx);
	assert.match(res.content[0].text, /"optionId":"ro"/, "escalation without UI fails closed even though confirm would say yes");
	answers.push("```json\n{}\n```");
	res = await tool.execute("c2c", { action: "run", name: "w", task: "PERMISSION" }, undefined, undefined, ctx);
	assert.match(res.content[0].text, /"optionId":"ro"/, "malformed review fails closed");

	answers.push('{"decision":"ask","reason":"deletes files"}');
	res = await tool.execute("c2d", { action: "run", name: "w", task: "PERMISSION" }, undefined, undefined, { ...ctx, hasUI: true, mode: "tui" });
	assert.match(res.content[0].text, /"optionId":"ao"/, "escalation goes to the UI");
	assert.match(confirms.at(-1), /Pi reviewer \(smoke-provider\/smoke-active-model\) escalated this to you: deletes files/);

	const before = reviewCalls.length;
	res = await tool.execute("c2e", { action: "run", name: "w", task: "PERMISSION" }, undefined, undefined, { ...ctx, model: undefined });
	assert.match(res.content[0].text, /"optionId":"ro"/, "no active Pi model fails closed");
	assert.equal(reviewCalls.length, before);

	// Legacy ask policy (explicit env override, read when the manager for a new Pi session is created).
	process.env.PI_CURSOR_PERMISSIONS = "ask";
	const askCtx = { ...ctx, sessionManager: { getSessionId: () => "ext-smoke-ask" } };
	res = await tool.execute("c2f", { action: "run", name: "w", task: "PERMISSION" }, undefined, undefined, askCtx);
	assert.match(res.content[0].text, /"optionId":"ro"/, "legacy ask without UI fails closed");
	assert.equal(reviewCalls.length, before, "legacy ask never calls the reviewer");
	delete process.env.PI_CURSOR_PERMISSIONS;
	res = await tool.execute("c2g", { action: "run", name: "w", task: "ECHO back" }, undefined, undefined, ctx);
	assert.match(res.content[0].text, /back/);
	res = await tool.execute("c3", { action: "list" }, undefined, undefined, ctx);
	assert.match(res.content[0].text, /- w \[live\]/);
	await assert.rejects(tool.execute("c4", { action: "run", name: "../w", task: "x" }, undefined, undefined, ctx), /Invalid worker name/);
	await ext.commands.get("cursor-workers").handler("", ctx);
	assert.match(notes.at(-1)[1], /State: .*ext-smoke-session/);

	const shutdown = ext.handlers.get("session_shutdown");
	for (const h of shutdown) await h({ type: "session_shutdown", reason: "quit" }, ctx);
	for (const h of shutdown) await h({ type: "session_shutdown", reason: "quit" }, ctx);
	res = await tool.execute("c5", { action: "run", name: "w", task: "RECALL" }, undefined, undefined, ctx);
	assert.match(res.content[0].text, /secret=fig/, "resumed after shutdown via session/load");
	res = await tool.execute("c6", { action: "close", name: "w", forget: true }, undefined, undefined, ctx);
	assert.match(res.content[0].text, /local worker record deleted.*Cursor's own history and run artifacts remain/);
	for (const h of shutdown) await h({ type: "session_shutdown", reason: "quit" }, ctx);
	console.log("extension smoke: PASS");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
