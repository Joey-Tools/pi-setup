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

	const notes = [];
	const ctx = {
		cwd: project,
		hasUI: false,
		mode: "print",
		sessionManager: { getSessionId: () => "ext-smoke-session" },
		ui: { notify: (msg, type) => notes.push([type, msg]), confirm: async () => true },
	};
	const updates = [];
	let res = await tool.execute("c1", { action: "run", name: "w", task: "REMEMBER fig" }, undefined, (u) => updates.push(u), ctx);
	assert.match(res.content[0].text, /model=claude-opus-5-5 context=1m effort=high fast=false/);
	res = await tool.execute("c2", { action: "run", name: "w", task: "PERMISSION" }, undefined, undefined, ctx);
	assert.match(res.content[0].text, /"optionId":"ro"/, "no UI must fail closed even though confirm would say yes");
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
