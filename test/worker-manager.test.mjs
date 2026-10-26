import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveProfile } from "../lib/index.mjs";
import { alive, setup } from "./helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const promptStarted = async (env) => {
	for (let i = 0; i < 200 && !env.methods().includes("session/prompt"); i++) await sleep(25);
	await sleep(50);
};

test("handshake applies and verifies the required profile, then mode, before prompting", async (t) => {
	const env = setup(t);
	const m = env.manager();
	const res = await m.run({ name: "w1", task: "ECHO hello world" });
	assert.match(res.text, /hello world/);
	assert.match(res.text, /model=claude-opus-5-5 context=1m effort=high fast=false/);
	assert.deepEqual(res.details.profile, { model: "claude-opus-5-5", context: "1m", effort: "high", fast: "false" });

	const log = env.log();
	const init = log.find((e) => e.method === "initialize");
	assert.equal(init.params.clientCapabilities._meta.parameterizedModelPicker, true);
	assert.equal(init.params.clientCapabilities.fs, undefined, "must not advertise fs");
	assert.equal(init.params.clientCapabilities.terminal, undefined, "must not advertise terminal");
	const setup_ = log.filter((e) => e.method === "session/set_config_option").map((e) => `${e.configId}=${e.value}`);
	assert.deepEqual(setup_, ["model=claude-opus-5-5", "context=1m", "effort=high", "fast=false"]);
	assert.deepEqual(env.methods(), ["initialize", "session/new", "session/set_mode", ...Array(4).fill("session/set_config_option"), "session/prompt"]);
	const prompt = log.find((e) => e.method === "session/prompt");
	assert.deepEqual(prompt.config, { model: "claude-opus-5-5", context: "1m", effort: "high", fast: "false" });
	assert.equal(prompt.mode, "agent");
	assert.equal(prompt.preamble, true);

	const recordFile = path.join(m.registry.workersDir, "w1.json");
	const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
	assert.equal(record.sessionId, res.details.sessionId);
	assert.equal(record.cwd, env.projectDir);
	assert.equal(record.lastRun.status, "completed");
	assert.equal(fs.statSync(recordFile).mode & 0o777, 0o600);
	assert.equal(fs.statSync(m.registry.workersDir).mode & 0o777, 0o700);
	assert.ok(fs.readFileSync(res.details.eventsPath, "utf8").includes("session/set_config_option"));
});

test("user-configured effort xhigh is applied; lower efforts are rejected at config time", async (t) => {
	const env = setup(t);
	const m = env.manager({ profile: resolveProfile({ effort: "xhigh" }) });
	await m.run({ name: "w", task: "ECHO x" });
	assert.equal(env.log().find((e) => e.method === "session/prompt").config.effort, "xhigh");
	assert.throws(() => resolveProfile({ effort: "medium" }), /PI_CURSOR_EFFORT/);
	assert.throws(() => resolveProfile({ effort: "low" }), /PI_CURSOR_EFFORT/);
});

test("profile fails closed when 1m context is not offered (no prompt sent)", async (t) => {
	const env = setup(t, { contextOptions: ["300k"] });
	const m = env.manager();
	await assert.rejects(m.run({ name: "w", task: "ECHO x" }), /does not offer context=1m.*refusing to downgrade/s);
	assert.ok(!env.methods().includes("session/prompt"));
	assert.equal((await m.list())[0].live, false);
});

test("profile fails closed when the agent does not apply a value", async (t) => {
	const env = setup(t, { effortStuck: true });
	await assert.rejects(env.manager().run({ name: "w", task: "ECHO x" }), /verification failed: effort: "medium" \(expected high\)/);
	assert.ok(!env.methods().includes("session/prompt"));
});

test("multi-turn conversation on one worker keeps one process and session", async (t) => {
	const env = setup(t);
	const m = env.manager();
	await m.run({ name: "w", task: "REMEMBER zebra42" });
	const res = await m.run({ name: "w", task: "RECALL" });
	assert.match(res.text, /secret=zebra42/);
	assert.equal(env.methods().filter((x) => x === "initialize").length, 1);
	assert.equal(env.methods().filter((x) => x === "session/new").length, 1);
	assert.equal(new Set(env.log().map((e) => e.pid)).size, 1);
});

test("restart resumes with session/load, re-applies the profile, and filters replayed history", async (t) => {
	const env = setup(t);
	const m1 = env.manager();
	const first = await m1.run({ name: "w", task: "REMEMBER otter7" });
	await m1.shutdown();
	const m2 = env.manager();
	const res = await m2.run({ name: "w", task: "RECALL" });
	assert.match(res.text, /secret=otter7/);
	assert.doesNotMatch(res.text, /\bOK\b/, "replayed agent message must not leak into the result");
	assert.equal(fs.readFileSync(res.details.resultPath, "utf8"), "secret=otter7");
	assert.equal(res.details.sessionId, first.details.sessionId);
	const methods = env.methods();
	assert.equal(methods.filter((x) => x === "session/new").length, 1);
	const afterLoad = methods.slice(methods.indexOf("session/load"));
	assert.deepEqual(afterLoad, ["session/load", "session/set_mode", ...Array(4).fill("session/set_config_option"), "session/prompt"]);
	const events = fs.readFileSync(res.details.eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.ok(events.some((e) => e.phase === "load" && e.msg?.params?.update?.sessionUpdate === "agent_message_chunk"));
});

test("independent Pi sessions get independent workers", async (t) => {
	const env = setup(t);
	await env.manager().run({ name: "w", task: "REMEMBER a" });
	const other = env.manager({ piSessionId: "pi-session-2" });
	const res = await other.run({ name: "w", task: "RECALL" });
	assert.match(res.text, /secret=none/);
	assert.equal(env.methods().filter((x) => x === "session/new").length, 2);
});

test("session/load failure is reported and never falls back to a fresh session", async (t) => {
	const env = setup(t);
	const m1 = env.manager();
	const first = await m1.run({ name: "w", task: "ECHO x" });
	await m1.shutdown();
	const m2 = env.manager({ fake: { loadFail: true } });
	await assert.rejects(m2.run({ name: "w", task: "ECHO y" }), /session\/load failed.*Not creating a fresh session/s);
	assert.equal(env.methods().filter((x) => x === "session/new").length, 1);
	assert.equal((await m2.registry.read("w")).sessionId, first.details.sessionId);
});

test("missing loadSession capability refuses to resume", async (t) => {
	const env = setup(t);
	const m1 = env.manager();
	await m1.run({ name: "w", task: "ECHO x" });
	await m1.shutdown();
	await assert.rejects(env.manager({ fake: { noLoad: true } }).run({ name: "w", task: "ECHO y" }), /does not advertise loadSession/);
	assert.equal(env.methods().filter((x) => x === "session/new").length, 1);
});

test("permissions: ask via injected handler, allow_once only, deny and no-UI fail closed", async (t) => {
	const env = setup(t);
	const seen = [];
	const ask = (answer) => async (req) => {
		seen.push(req);
		return answer;
	};
	const askM = env.manager({ permissionPolicy: "ask" });
	let res = await askM.run({ name: "a", task: "PERMISSION", askPermission: ask(true) });
	assert.match(res.text, /permission=\{"outcome":"selected","optionId":"ao"\}/);
	assert.equal(res.details.counts.permissionsAllowed, 1);
	assert.match(seen[0].message, /rm -rf build/);
	assert.equal(seen[0].worker, "a");
	res = await askM.run({ name: "a", task: "PERMISSION", askPermission: ask(false) });
	assert.match(res.text, /"optionId":"ro"/);
	res = await askM.run({ name: "a", task: "PERMISSION" });
	assert.match(res.text, /"optionId":"ro"/, "no UI handler must fail closed");

	const allowM = env.manager({ permissionPolicy: "allow" });
	res = await allowM.run({ name: "b", task: "PERMISSION" });
	assert.match(res.text, /"optionId":"ao"/);
	res = await allowM.run({ name: "b", task: "PERMISSION_NO_ONCE" });
	assert.match(res.text, /permission=\{"outcome":"cancelled"\}/, "allow_always must never be selected");

	const denyM = env.manager({ permissionPolicy: "deny" });
	let called = false;
	res = await denyM.run({ name: "c", task: "PERMISSION", askPermission: async () => (called = true) });
	assert.match(res.text, /"optionId":"ro"/);
	assert.equal(called, false);
});

test("unknown client requests get -32601", async (t) => {
	const env = setup(t);
	const res = await env.manager().run({ name: "w", task: "UNKNOWN_REQ" });
	assert.match(res.text, /unknown=-32601/);
});

test("only assistant message chunks become the result", async (t) => {
	const env = setup(t);
	const res = await env.manager().run({ name: "w", task: "THINK" });
	assert.match(res.text, /visible answer/);
	assert.doesNotMatch(res.text, /private thinking|tool output text/);
	assert.equal(res.details.counts.toolCalls, 1);
	assert.equal(res.details.counts.thoughtChunks, 1);
});

test("abort sends session/cancel; acknowledged cancel keeps the process reusable", async (t) => {
	const env = setup(t);
	const m = env.manager();
	const ac = new AbortController();
	const p = m.run({ name: "w", task: "HANG", signal: ac.signal });
	await promptStarted(env);
	ac.abort();
	await assert.rejects(p, /was cancelled; the agent acknowledged session\/cancel/);
	assert.ok(env.log().some((e) => e.notification === "session/cancel"));
	assert.equal((await m.registry.read("w")).lastRun.status, "cancelled");
	const res = await m.run({ name: "w", task: "ECHO again" });
	assert.match(res.text, /again/);
	assert.equal(new Set(env.log().map((e) => e.pid)).size, 1);
});

test("timeout cancels and reports honestly", async (t) => {
	const env = setup(t);
	await assert.rejects(env.manager().run({ name: "w", task: "HANG", timeoutMs: 1500 }), /timed out after 1\.5s; the agent acknowledged/);
});

test("stubborn agent ignoring cancel and SIGTERM is killed and not reused", async (t) => {
	const env = setup(t);
	const m = env.manager({ cancelGraceMs: 200, killGraceMs: 300 });
	await assert.rejects(m.run({ name: "w", task: "STUBBORN", timeoutMs: 1500 }), /process group was terminated/);
	const pid = env.log().find((e) => e.method === "session/prompt").pid;
	assert.equal(alive(pid), false);
	assert.equal((await m.list())[0].live, false);
	const res = await m.run({ name: "w", task: "ECHO back" });
	assert.match(res.text, /back/);
	assert.ok(env.methods().includes("session/load"), "next run resumes via session/load");
});

test("process crash rejects the pending prompt and drops the worker without retrying", async (t) => {
	const env = setup(t);
	const m = env.manager();
	await assert.rejects(m.run({ name: "w", task: "CRASH" }), /failed during prompt: agent process exited \(code=3.*not retried/s);
	assert.equal(m.workers.size, 0);
	assert.equal(env.methods().filter((x) => x === "session/prompt").length, 1);
	assert.equal((await m.registry.read("w")).lastRun.status, "failed");
});

test("malformed frames are tolerated; oversize frames kill the worker", async (t) => {
	const env = setup(t);
	const m = env.manager({ maxFrameBytes: 10000 });
	assert.match((await m.run({ name: "w", task: "MALFORMED" })).text, /survived/);
	await assert.rejects(m.run({ name: "w", task: "OVERSIZE 20000" }), /protocol failure: unterminated frame exceeds limit/);
	assert.equal(m.workers.size, 0);
});

test("large results are capped for the model with the full text in result.md", async (t) => {
	const env = setup(t);
	const res = await env.manager({ resultLimit: 1000 }).run({ name: "w", task: "BIG 5000" });
	assert.equal(res.details.truncated, true);
	assert.equal(res.details.resultChars, 5000);
	assert.match(res.text, /Result truncated: showing 1000 of 5000 chars\. Full result: .*result\.md/);
	assert.match(res.text, /END/);
	assert.ok(res.text.length < 1900);
	const full = fs.readFileSync(res.details.resultPath, "utf8");
	assert.equal(full.length, 5000);
	assert.ok(full.endsWith("END"));
	assert.ok(JSON.stringify(res.details).length < 1000, "details stay lightweight");
});

test("non-end_turn stop reasons are failures", async (t) => {
	const env = setup(t);
	await assert.rejects(env.manager().run({ name: "w", task: "REFUSE" }), /unsupported stopReason="refusal"/);
});

test("worker names are validated and cwd is immutable", async (t) => {
	const env = setup(t);
	const m = env.manager();
	for (const bad of ["../x", "a b", "", "x".repeat(49), "a/b", "é"]) {
		await assert.rejects(m.run({ name: bad, task: "ECHO" }), /Invalid worker name/);
	}
	await assert.rejects(m.run({ name: "w", task: "ECHO", cwd: "missing" }), /does not exist/);
	await assert.rejects(m.run({ name: "w", task: "ECHO", mode: "yolo" }), /mode must be/);
	await m.run({ name: "w", task: "ECHO x" });
	await assert.rejects(m.run({ name: "w", task: "ECHO x", cwd: "sub" }), /bound to .*refusing to move/);
	const sub = await m.run({ name: "w-sub", task: "ECHO x", cwd: "sub" });
	assert.equal(sub.details.cwd, path.join(env.projectDir, "sub"));
	await m.close("w");
	await assert.rejects(m.run({ name: "w", task: "ECHO x", cwd: "sub" }), /bound to/, "binding survives process release");
});

test("mode is explicit and can be changed per run", async (t) => {
	const env = setup(t);
	const m = env.manager();
	await m.run({ name: "w", task: "ECHO x", mode: "ask" });
	await m.run({ name: "w", task: "ECHO y" });
	await m.run({ name: "w", task: "ECHO z", mode: "plan" });
	assert.deepEqual(env.log().filter((e) => e.method === "session/prompt").map((e) => e.mode), ["ask", "ask", "plan"]);
	assert.equal((await m.registry.read("w")).mode, "plan");
});

test("distinct workers run concurrently; the same worker rejects a concurrent run", async (t) => {
	const env = setup(t);
	const m = env.manager();
	const a = m.run({ name: "a", task: "SLOW 400" });
	const b = m.run({ name: "b", task: "SLOW 400" });
	await assert.rejects(m.run({ name: "a", task: "ECHO x" }), /already running a task/);
	const [ra, rb] = await Promise.all([a, b]);
	assert.notEqual(ra.details.sessionId, rb.details.sessionId);
	assert.equal(new Set(env.log().filter((e) => e.method === "session/prompt").map((e) => e.pid)).size, 2);
	const records = await m.list();
	assert.deepEqual(records.map((r) => r.name).sort(), ["a", "b"]);
});

test("worker cap evicts idle workers and rejects when all are busy", async (t) => {
	const env = setup(t);
	const m = env.manager({ maxWorkers: 1 });
	await m.run({ name: "a", task: "ECHO x" });
	await m.run({ name: "b", task: "ECHO y" });
	const list = Object.fromEntries((await m.list()).map((w) => [w.name, w.live]));
	assert.deepEqual(list, { a: false, b: true });
	const busy = m.run({ name: "b", task: "SLOW 300" });
	await sleep(50);
	await assert.rejects(m.run({ name: "c", task: "ECHO z" }), /are busy/);
	await busy;
});

test("handshake timeout kills the process", async (t) => {
	const env = setup(t, { hangInitialize: true });
	const m = env.manager({ rpcTimeoutMs: 1000 });
	await assert.rejects(m.run({ name: "w", task: "ECHO" }), /initialize timed out after 1000ms/);
	const pid = env.log().find((e) => e.method === "initialize").pid;
	await sleep(100);
	assert.equal(alive(pid), false);
	assert.equal(m.workers.size, 0);
});

test("missing executable is reported", async (t) => {
	const env = setup(t);
	await assert.rejects(env.manager({ command: path.join(env.root, "no-such-agent") }).run({ name: "w", task: "ECHO" }), /failed to start/);
});

test("close releases the process but keeps the session; forget removes it", async (t) => {
	const env = setup(t);
	const m = env.manager();
	await m.run({ name: "w", task: "REMEMBER k1" });
	assert.deepEqual(await m.close("w"), { name: "w", wasLive: true, forgotten: false });
	assert.match((await m.run({ name: "w", task: "RECALL" })).text, /secret=k1/);
	await m.close("w", { forget: true });
	assert.equal(await m.registry.read("w"), undefined);
	assert.match((await m.run({ name: "w", task: "RECALL" })).text, /secret=none/);
});

test("shutdown is idempotent and terminates workers", async (t) => {
	const env = setup(t);
	const m = env.manager();
	await m.run({ name: "w", task: "ECHO x" });
	const pid = env.log()[0].pid;
	await Promise.all([m.shutdown(), m.shutdown()]);
	await m.shutdown();
	await sleep(50);
	assert.equal(alive(pid), false);
	await assert.rejects(m.run({ name: "w", task: "ECHO" }), /shutting down/);
});

test("shutdown during a run terminates it", async (t) => {
	const env = setup(t);
	const m = env.manager();
	const p = m.run({ name: "w", task: "HANG" });
	await promptStarted(env);
	await m.shutdown();
	await assert.rejects(p, /was stopped by Pi session shutdown/);
});

test("the profile is re-applied and verified before every prompt, even without a change notification", async (t) => {
	const env = setup(t, { driftAfterPrompt: true });
	const m = env.manager();
	for (const task of ["ECHO a", "ECHO b", "ECHO c"]) await m.run({ name: "w", task });
	assert.equal(env.methods().filter((x) => x === "session/set_config_option").length, 12);
	for (const p of env.log().filter((e) => e.method === "session/prompt")) assert.equal(p.config.model, "claude-opus-5-5");
});

test("a profile failure on a live worker discards it instead of prompting", async (t) => {
	const env = setup(t);
	const m = env.manager();
	await m.run({ name: "w", task: "ECHO a" });
	m.opts.profile = resolveProfile({ model: "not-offered" });
	await assert.rejects(m.run({ name: "w", task: "ECHO b" }), /does not offer model=not-offered/);
	assert.equal(env.methods().filter((x) => x === "session/prompt").length, 1);
	assert.equal(m.workers.size, 0);
});

test("cursor/ask_question is declined, so Cursor never falls back to answer-as-permission", async (t) => {
	const env = setup(t);
	const res = await env.manager({ permissionPolicy: "allow" }).run({ name: "w", task: "ASK_QUESTION" });
	assert.match(res.text, /question=\{"outcome":\{"outcome":"cancelled"\}\}/);
});

test("question-shaped or ambiguous permission requests are cancelled under every policy without asking or reviewing", async (t) => {
	const env = setup(t);
	let asked = 0;
	let reviewed = 0;
	const ask = async () => {
		asked++;
		return true;
	};
	const reviewPermission = async () => {
		reviewed++;
		return { decision: "approve", reason: "fine" };
	};
	for (const policy of ["review", "allow", "ask", "deny"]) {
		const m = env.manager({ permissionPolicy: policy });
		for (const task of ["QUESTION_FALLBACK", "MULTI_ALLOW"]) {
			const res = await m.run({ name: `w-${policy}`, task, askPermission: ask, reviewPermission });
			assert.match(res.text, /permission=\{"outcome":"cancelled"\}/, `${policy} ${task}`);
		}
		const res = await m.run({ name: `w-${policy}`, task: "ASK_QUESTION", askPermission: ask, reviewPermission });
		assert.match(res.text, /question=\{"outcome":\{"outcome":"cancelled"\}\}/, `${policy} ASK_QUESTION`);
	}
	assert.equal(asked, 0);
	assert.equal(reviewed, 0);
});

test("Cursor in-band errors with end_turn fail; a trailing error paragraph is flagged", async (t) => {
	const env = setup(t);
	const m = env.manager();
	await assert.rejects(m.run({ name: "w", task: "INBAND_ERROR" }), /replied with an error although stopReason=end_turn: Error: \[unauthenticated\]/);
	assert.equal((await m.registry.read("w")).lastRun.status, "failed");
	const res = await m.run({ name: "w", task: "TRAILING_ERROR" });
	assert.match(res.text, /Warning: the reply ends with an error reported by Cursor: Error: tool exploded/);
	assert.match(res.text, /end_turn only means the turn ended/);
});

test("an already-aborted signal never sends the prompt", async (t) => {
	const env = setup(t);
	const m = env.manager();
	await m.run({ name: "w", task: "ECHO a" });
	const ac = new AbortController();
	ac.abort();
	await assert.rejects(m.run({ name: "w", task: "REMEMBER should-not-be-sent", signal: ac.signal }), /was cancelled during .*before the task was sent/);
	assert.equal(env.methods().filter((x) => x === "session/prompt").length, 1);
});

test("abort during setup stops before prompting and kills the uncertain process", async (t) => {
	const env = setup(t, { slowConfigMs: 300 });
	const m = env.manager();
	const ac = new AbortController();
	const p = m.run({ name: "w", task: "ECHO a", signal: ac.signal });
	for (let i = 0; i < 200 && !env.methods().includes("session/set_config_option"); i++) await sleep(25);
	ac.abort();
	await assert.rejects(p, /was cancelled during setup, before the task was sent/);
	assert.ok(!env.methods().includes("session/prompt"));
	assert.equal(m.workers.size, 0);
	await sleep(100);
	assert.equal(alive(env.log()[0].pid), false);
});

test("the run timeout covers setup, not just the prompt", async (t) => {
	const env = setup(t, { slowConfigMs: 400 });
	await assert.rejects(env.manager().run({ name: "w", task: "ECHO a", timeoutMs: 600 }), /timed out after 0\.6s during setup, before the task was sent/);
	assert.ok(!env.methods().includes("session/prompt"));
});

test("timeout while a permission dialog is pending dismisses it and cancels", async (t) => {
	const env = setup(t);
	let dismissed = false;
	const ask = (_req, signal) =>
		new Promise((resolve) =>
			signal.addEventListener("abort", () => {
				dismissed = true;
				resolve(true);
			}),
		);
	const m = env.manager({ permissionPolicy: "ask" });
	await assert.rejects(m.run({ name: "w", task: "PERMISSION", timeoutMs: 1500, askPermission: ask }), /timed out after 1\.5s; the agent acknowledged session\/cancel/);
	assert.equal(dismissed, true);
	const events = fs.readFileSync(fs.readdirSync(m.registry.runsDir).map((d) => path.join(m.registry.runsDir, d, "events.jsonl"))[0], "utf8");
	assert.match(events, /"dir":"decision".*"outcome":"cancelled"/, "a late dialog answer is not applied");
});

test("shutdown racing startup leaves no live worker or process", async (t) => {
	const env = setup(t);
	const m = env.manager();
	const p = m.run({ name: "w", task: "SLOW 3000" });
	const s = m.shutdown();
	await assert.rejects(p, /stopped by Pi session shutdown/);
	await s;
	assert.equal(m.workers.size, 0);
	assert.ok(!env.methods().includes("session/prompt"));
	await sleep(100);
	for (const e of env.log()) assert.equal(alive(e.pid), false);
});

test("shutdown during connect terminates the starting process", async (t) => {
	const env = setup(t, { slowConfigMs: 2000 });
	const m = env.manager();
	const p = m.run({ name: "w", task: "ECHO a" });
	for (let i = 0; i < 200 && !env.methods().includes("session/set_config_option"); i++) await sleep(25);
	await m.shutdown();
	await assert.rejects(p, /stopped by Pi session shutdown/);
	assert.equal(m.workers.size, 0);
	await sleep(100);
	assert.equal(alive(env.log()[0].pid), false);
});

test("omitting cwd reuses the worker's bound cwd", async (t) => {
	const env = setup(t);
	const m = env.manager();
	await m.run({ name: "w", task: "ECHO a", cwd: "sub" });
	assert.equal((await m.run({ name: "w", task: "ECHO b" })).details.cwd, path.join(env.projectDir, "sub"));
	await m.close("w");
	assert.equal((await m.run({ name: "w", task: "ECHO c" })).details.cwd, path.join(env.projectDir, "sub"));
});

test("artifact backlog is bounded and surfaced instead of silently advertised", async (t) => {
	const env = setup(t);
	const res = await env.manager({ artifactMaxPendingBytes: 1 }).run({ name: "w", task: "ECHO a" });
	assert.match(res.text, /Warning: run artifacts are incomplete \(artifact write backlog exceeded 1 bytes/);
	assert.match(res.details.artifactError, /backlog/);
});
