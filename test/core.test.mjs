import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	AcpConnection,
	applyProfile,
	configFromEnv,
	detectInBandError,
	projectKey,
	ResultBuffer,
	RunArtifacts,
	resolveProfile,
	sessionKey,
	unsafePermissionReason,
	validateWorkerName,
	verifyProfile,
} from "../lib/index.mjs";

test("configFromEnv defaults and user-owned overrides", () => {
	const c = configFromEnv({ PI_CODING_AGENT_DIR: "/tmp/agentdir" });
	assert.equal(c.command, "agent");
	assert.deepEqual(c.args, ["acp"]);
	assert.equal(c.stateDir, path.join("/tmp/agentdir", "cursor-workers"));
	assert.deepEqual(c.profile, { model: "claude-opus-5-5", context: "1m", effort: "high", fast: "false" });
	assert.equal(c.permissionPolicy, "review");
	assert.equal(c.reviewTimeoutMs, 45000);
	assert.equal(c.maxWorkers, 4);
	assert.equal(c.resultLimit, 12000);
	for (const policy of ["ask", "allow", "deny", "REVIEW"]) assert.equal(configFromEnv({ PI_CURSOR_PERMISSIONS: policy }).permissionPolicy, policy.toLowerCase());
	assert.equal(configFromEnv({ PI_CURSOR_REVIEW_TIMEOUT_SECONDS: "120" }).reviewTimeoutMs, 120000);
	assert.throws(() => configFromEnv({ PI_CURSOR_REVIEW_TIMEOUT_SECONDS: "121" }), /PI_CURSOR_REVIEW_TIMEOUT_SECONDS/);

	const o = configFromEnv({
		PI_CURSOR_COMMAND: "/opt/cursor/agent",
		PI_CURSOR_ARGS: '["acp","--flag"]',
		PI_CURSOR_STATE_DIR: "/tmp/s",
		PI_CURSOR_MODEL: "claude-opus-6",
		PI_CURSOR_EFFORT: "max",
		PI_CURSOR_PERMISSIONS: "ALLOW",
		PI_CURSOR_MAX_WORKERS: "2",
	});
	assert.equal(o.command, "/opt/cursor/agent");
	assert.deepEqual(o.args, ["acp", "--flag"]);
	assert.equal(o.stateDir, "/tmp/s");
	assert.deepEqual(o.profile, { model: "claude-opus-6", context: "1m", effort: "max", fast: "false" });
	assert.equal(o.permissionPolicy, "allow");
	assert.equal(o.maxWorkers, 2);
});

test("configFromEnv rejects downgrades and malformed values", () => {
	for (const effort of ["medium", "low", "HIGH ", "fast"]) assert.throws(() => configFromEnv({ PI_CURSOR_EFFORT: effort }), /PI_CURSOR_EFFORT/);
	assert.throws(() => configFromEnv({ PI_CURSOR_PERMISSIONS: "always" }), /PI_CURSOR_PERMISSIONS/);
	assert.throws(() => configFromEnv({ PI_CURSOR_MODEL: "claude[context=300k]" }), /PI_CURSOR_MODEL/);
	assert.throws(() => configFromEnv({ PI_CURSOR_ARGS: "acp --force" }), /JSON array/);
	assert.throws(() => configFromEnv({ PI_CURSOR_MAX_WORKERS: "0" }), /PI_CURSOR_MAX_WORKERS/);
	assert.ok(Object.isFrozen(resolveProfile()));
});

test("worker names and state keys are safe", () => {
	assert.equal(validateWorkerName("impl_1-a"), "impl_1-a");
	assert.throws(() => validateWorkerName("."), /Invalid/);
	assert.match(projectKey("/a/b/my repo"), /^my_repo-[0-9a-f]{16}$/);
	assert.notEqual(projectKey("/a/x"), projectKey("/b/x"));
	assert.equal(sessionKey("0192-abc_D"), "0192-abc_D");
	assert.match(sessionKey("../../etc"), /^h-[0-9a-f]{32}$/);
});

test("ResultBuffer keeps head and tail within the limit", () => {
	const b = new ResultBuffer(100);
	b.append("H".repeat(50));
	b.append("x".repeat(10000));
	b.append("TAIL");
	const r = b.render();
	assert.equal(r.truncated, true);
	assert.equal(r.shown, 100);
	assert.ok(r.text.startsWith("H".repeat(25)));
	assert.ok(r.text.endsWith("TAIL"));
	assert.ok(b.tail.length <= 200);
});

test("verifyProfile and applyProfile handle grouped options and refuse missing options", async () => {
	const profile = resolveProfile();
	assert.deepEqual(verifyProfile([], profile).length, 4);
	const calls = [];
	const config = [
		{ id: "model", currentValue: "x", options: [{ value: "claude-opus-5-5" }] },
		{ id: "context", currentValue: "300k", options: [{ group: "g", options: [{ value: "1m" }] }] },
		{ id: "effort", currentValue: "low", options: [] },
		{ id: "fast", currentValue: true, options: [] },
	];
	const conn = {
		async request(method, params) {
			calls.push(params);
			config.find((o) => o.id === params.configId).currentValue = params.value;
			return { configOptions: structuredClone(config) };
		},
	};
	const final = await applyProfile(conn, "s", structuredClone(config), profile);
	assert.deepEqual(verifyProfile(final, profile), []);
	assert.deepEqual(calls.map((c) => c.value), ["claude-opus-5-5", "1m", "high", "false"]);
	const limited = { request: async () => ({ configOptions: [{ id: "model", currentValue: "claude-opus-5-5" }] }) };
	await assert.rejects(applyProfile(limited, "s", [{ id: "model", currentValue: "x" }], profile), /does not expose config option "context".*parameterizedModelPicker/s);
	await assert.rejects(applyProfile({ request: async () => ({}) }, "s", config, profile), /returned no configOptions/);
});

test("RunArtifacts surfaces disk errors and bounds pending writes", async () => {
	const missing = new RunArtifacts(path.join(os.tmpdir(), `pi-cursor-missing-${process.pid}`, "nope"));
	missing.appendResult("x");
	await missing.close();
	assert.equal(missing.writeError?.code, "ENOENT");

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cursor-art-"));
	const bounded = new RunArtifacts(dir, { maxPendingBytes: 2500 });
	for (let i = 0; i < 10; i++) bounded.appendResult("y".repeat(1000));
	await bounded.close();
	assert.match(bounded.writeError.message, /backlog exceeded 2500 bytes/);
	assert.ok(fs.statSync(bounded.resultPath).size <= 2500);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("detectInBandError and unsafePermissionReason", () => {
	assert.equal(detectInBandError("Error: boom").fatal, true);
	assert.equal(detectInBandError("  Please sign in to continue").fatal, true);
	assert.equal(detectInBandError("all good\n\nError: late failure").fatal, false);
	assert.equal(detectInBandError("The Error: label is fine mid-text"), undefined);
	assert.equal(detectInBandError(""), undefined);
	const opt = (kind, optionId = kind) => ({ kind, optionId });
	assert.equal(unsafePermissionReason({ toolCall: { toolCallId: "t" }, options: [opt("allow_once"), opt("allow_always"), opt("reject_once")] }), undefined);
	assert.match(unsafePermissionReason({ toolCall: { toolCallId: "t_q3" }, options: [opt("allow_once")] }), /_qN/);
	assert.match(unsafePermissionReason({ options: [opt("allow_once"), opt("reject_once", "__ask_question_skip__")] }), /skip/);
	assert.match(unsafePermissionReason({ options: [opt("allow_once", "a"), opt("allow_once", "b")] }), /multiple/);
	assert.match(unsafePermissionReason({ options: [opt("approve_everything")] }), /unknown/);
});

const script = (code) => ({ command: process.execPath, args: ["-e", code] });

test("AcpConnection rejects pending requests when the process exits and includes stderr", async () => {
	const conn = new AcpConnection({ ...script("process.stderr.write('boom-diagnostic'); setTimeout(() => process.exit(7), 100)"), cwd: process.cwd() }).start();
	await assert.rejects(conn.request("initialize", {}), /exited \(code=7.*boom-diagnostic/s);
	assert.equal(conn.pending.size, 0);
	await assert.rejects(conn.request("x", {}), /exited/);
	assert.equal(conn.notify("x", {}), false);
	await conn.terminate();
	await conn.terminate();
});

test("AcpConnection request timeout and abort clean up pending entries", async () => {
	const conn = new AcpConnection({ ...script("process.stdin.resume()"), cwd: process.cwd() }).start();
	await assert.rejects(conn.request("slow", {}, { timeoutMs: 100 }), /timed out after 100ms/);
	const ac = new AbortController();
	const p = conn.request("slow", {}, { timeoutMs: 0, signal: ac.signal });
	ac.abort();
	await assert.rejects(p, /aborted/);
	assert.equal(conn.pending.size, 0);
	await conn.terminate();
	assert.ok(conn.exitInfo);
});

test("AcpConnection answers agent requests and routes notifications", async () => {
	const agent = `
		const rl = require('readline').createInterface({ input: process.stdin });
		const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
		rl.on('line', (l) => {
			const m = JSON.parse(l);
			if (m.method === 'go') { send({ method: 'note', params: { n: 1 } }); send({ id: 'r1', method: 'unknown/thing', params: {} }); }
			if (m.id === 'r1') send({ id: 1, result: { got: m.error.code } });
		});`;
	const notes = [];
	const conn = new AcpConnection({ ...script(agent), cwd: process.cwd(), onNotification: (method, params) => notes.push([method, params]) }).start();
	const result = await conn.request("go", {});
	assert.deepEqual(result, { got: -32601 });
	assert.deepEqual(notes, [["note", { n: 1 }]]);
	await conn.terminate();
});
