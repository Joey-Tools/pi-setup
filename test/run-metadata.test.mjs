import assert from "node:assert/strict";
import { test } from "node:test";
import { describeProfile, formatProfile, profileStatusText, resolveProfile, WorkerError } from "../lib/index.mjs";
import { setup } from "./helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULT = { model: "claude-opus-5-5", context: "1m", effort: "high", fast: "false" };
const LABEL = "model=claude-opus-5-5 context=1m effort=high fast=false";

/** Progress events, each with how many set_config_option calls the fake agent had logged when it arrived. */
function recorder(env) {
	const events = [];
	const onProgress = (p) => events.push({ ...p, configCalls: env.methods().filter((x) => x === "session/set_config_option").length });
	return { events, onProgress, steps: () => events.map((e) => `${e.phase}/${e.profileStatus}`) };
}

async function failure(promise) {
	try {
		await promise;
	} catch (err) {
		assert.ok(err instanceof WorkerError, String(err));
		return err;
	}
	assert.fail("expected the run to fail");
}

/** The details survive structured clone and JSON (how Pi stores tool results) and never claim a false verification. */
function assertFailureMetadata(err, { profile = DEFAULT, status, phase }) {
	for (const details of [structuredClone(err.details), JSON.parse(JSON.stringify(err.details))]) {
		assert.deepEqual(details.profile, profile);
		assert.equal(details.profileStatus, status);
		assert.equal(details.phase, phase);
		assert.ok(details.counts);
	}
	const line = err.message.split("\n").find((l) => l.startsWith("Cursor profile: "));
	assert.equal(line, `Cursor profile: ${describeProfile(profile, status)}; phase=${phase}.`);
	assert.ok(err.message.split("\n").indexOf(line) <= 2, "profile line sits near the top");
	if (status !== "verified") assert.doesNotMatch(err.message, /verified before prompt/);
}

test("profile label formatter keeps the existing layout and is honest about status", () => {
	assert.equal(formatProfile(resolveProfile()), LABEL);
	assert.equal(formatProfile(resolveProfile({ model: "gpt-x", effort: "max" })), "model=gpt-x context=1m effort=max fast=false");
	assert.equal(profileStatusText("verified"), "verified before prompt");
	for (const s of ["configured", undefined, "bogus"]) assert.equal(profileStatusText(s), "configured; not yet verified");
	assert.equal(describeProfile(DEFAULT, "verified"), `${LABEL} (verified before prompt)`);
});

test("the first progress update is synchronous, before the agent process is initialized", async (t) => {
	const env = setup(t, { hangInitialize: true });
	const m = env.manager({ rpcTimeoutMs: 800 });
	const r = recorder(env);
	const p = m.run({ name: "w", task: "ECHO x", onProgress: r.onProgress });
	assert.equal(r.events.length, 1, "emitted before run() yields");
	assert.deepEqual(r.events[0].profile, DEFAULT);
	assert.equal(r.events[0].profileStatus, "configured");
	assert.equal(r.events[0].phase, "connect");
	assert.equal(r.events[0].status, "running");
	assert.equal(typeof r.events[0].elapsedMs, "number");
	assert.equal(r.events[0].toolCalls, 0);
	assert.equal(r.events[0].resultChars, 0);
	assert.deepEqual(env.methods(), []);
	const err = await failure(p);
	assert.match(err.message, /^ACP request initialize timed out after 800ms/);
	assertFailureMetadata(err, { status: "configured", phase: "connect" });
	assert.ok(r.events.every((e) => e.profileStatus === "configured"));
});

test("phase and profile-status transitions are forced through; verified only after the last set_config_option", async (t) => {
	const env = setup(t, { slowConfigMs: 150 });
	const m = env.manager();
	const r = recorder(env);
	const res = await m.run({ name: "w", task: "ECHO hi", onProgress: r.onProgress });
	assert.deepEqual(r.steps().slice(0, 4), ["connect/configured", "setup/configured", "setup/verified", "prompt/verified"]);
	assert.ok(r.steps().slice(4).every((s) => s === "prompt/verified"));
	for (const e of r.events) {
		if (e.profileStatus === "verified") assert.equal(e.configCalls, 4, "verified only after every option was set");
		else assert.ok(e.configCalls < 4, "configured until verification succeeds");
		assert.deepEqual(e.profile, DEFAULT);
	}
	const elapsed = r.events.map((e) => e.elapsedMs);
	assert.deepEqual(elapsed, [...elapsed].sort((a, b) => a - b), "elapsed is measured from the run start");
	assert.ok(r.events.find((e) => e.phase === "prompt").elapsedMs >= 4 * 150, "includes setup time");
	assert.equal(res.details.profileStatus, "verified");
	assert.equal(res.details.phase, "prompt");
	assert.deepEqual(res.details.profile, DEFAULT);
	assert.match(res.text.split("\n")[0], new RegExp(`${LABEL} \\(verified before prompt\\)`));
});

test("reused and resumed workers start every run configured again", async (t) => {
	const env = setup(t);
	const m1 = env.manager();
	await m1.run({ name: "w", task: "ECHO a" });
	const reused = recorder(env);
	await m1.run({ name: "w", task: "ECHO b", onProgress: reused.onProgress });
	assert.deepEqual(reused.steps().slice(0, 4), ["connect/configured", "setup/configured", "setup/verified", "prompt/verified"]);
	await m1.shutdown();
	const m2 = env.manager();
	const resumed = recorder(env);
	await m2.run({ name: "w", task: "ECHO c", onProgress: resumed.onProgress });
	assert.deepEqual(resumed.steps().slice(0, 5), ["connect/configured", "load/configured", "setup/configured", "setup/verified", "prompt/verified"]);
});

test("output during the prompt produces a throttled update that still carries the profile", async (t) => {
	const env = setup(t);
	const r = recorder(env);
	await env.manager().run({ name: "w", task: "SLOW 1200", onProgress: r.onProgress });
	const withOutput = r.events.filter((e) => e.resultChars > 0);
	assert.equal(withOutput.length, 1);
	assert.equal(withOutput[0].messageChunks, 1);
	assert.equal(withOutput[0].phase, "prompt");
	assert.equal(withOutput[0].profileStatus, "verified");
	assert.deepEqual(withOutput[0].profile, DEFAULT);

	const fast = recorder(env);
	await env.manager().run({ name: "w2", task: "BIG 5000", onProgress: fast.onProgress });
	const fromPrompt = fast.events.slice(fast.events.findIndex((e) => e.phase === "prompt"));
	assert.ok(fromPrompt.length >= 1);
	for (let i = 1; i < fromPrompt.length; i++) {
		assert.ok(fromPrompt[i].elapsedMs - fromPrompt[i - 1].elapsedMs >= 1000, "output-driven updates are at least 1s apart");
	}
});

test("aborting from the first prompt-phase update never sends the prompt", async (t) => {
	const env = setup(t);
	const m = env.manager();
	const ac = new AbortController();
	const r = recorder(env);
	const onProgress = (p) => {
		r.onProgress(p);
		if (p.phase === "prompt") ac.abort();
	};
	const err = await failure(m.run({ name: "w", task: "ECHO never", signal: ac.signal, onProgress }));
	assert.match(err.message, /^Cursor worker "w" was cancelled during prompt, before the task was sent; no prompt was started\./);
	assertFailureMetadata(err, { status: "verified", phase: "prompt" });
	assert.equal(err.details.cancelled, "cancelled");
	assert.ok(!env.methods().includes("session/prompt"));
	assert.ok(!env.log().some((e) => e.notification === "session/cancel"), "nothing to cancel: no prompt was sent");
	assert.equal(r.events.at(-1).phase, "prompt");
	assert.equal((await m.registry.read("w")).lastRun.status, "cancelled");
	assert.match((await m.run({ name: "w", task: "ECHO later" })).text, /later/, "the unprompted worker stays usable");
	assert.deepEqual(env.log().filter((e) => e.method === "session/prompt").map((e) => e.task), ["ECHO later"]);
});

test("shutdown from the first prompt-phase update never sends the prompt", async (t) => {
	const env = setup(t);
	const m = env.manager();
	const err = await failure(m.run({ name: "w", task: "ECHO never", onProgress: (p) => p.phase === "prompt" && void m.shutdown() }));
	assert.match(err.message, /was stopped by Pi session shutdown during prompt, before the task was sent/);
	assertFailureMetadata(err, { status: "verified", phase: "prompt" });
	assert.ok(!env.methods().includes("session/prompt"));
});

test("aborting at each setup checkpoint is reported honestly and sends no prompt", async (t) => {
	for (const [at, status] of [
		["setup/configured", "configured"],
		["setup/verified", "verified"],
	]) {
		const env = setup(t);
		const ac = new AbortController();
		const onProgress = (p) => `${p.phase}/${p.profileStatus}` === at && ac.abort();
		const err = await failure(env.manager().run({ name: "w", task: "ECHO never", signal: ac.signal, onProgress }));
		assert.match(err.message, /was cancelled during setup, before the task was sent; no prompt was started\./, at);
		assertFailureMetadata(err, { status, phase: "setup" });
		assert.ok(!env.methods().includes("session/prompt"), at);
		if (status === "configured") assert.ok(env.methods().filter((x) => x === "session/set_config_option").length < 4, at);
		else assert.equal(env.methods().filter((x) => x === "session/set_config_option").length, 4, at);
	}
});

test("a user-configured model and effort are reported, not the defaults", async (t) => {
	const env = setup(t, { requireProfile: false });
	const profile = resolveProfile({ model: "gpt-x", effort: "max" });
	const r = recorder(env);
	const res = await env.manager({ profile }).run({ name: "w", task: "ECHO x", onProgress: r.onProgress });
	const expected = { model: "gpt-x", context: "1m", effort: "max", fast: "false" };
	for (const e of r.events) assert.deepEqual(e.profile, expected);
	assert.deepEqual(res.details.profile, expected);
	assert.match(res.text, /model=gpt-x context=1m effort=max fast=false \(verified before prompt\)/);
	assert.deepEqual(env.log().find((e) => e.method === "session/prompt").config, expected);
});

test("each run keeps its own profile snapshot when the manager's options change", async (t) => {
	const env = setup(t, { slowConfigMs: 100 });
	const m = env.manager();
	const r = recorder(env);
	const p = m.run({ name: "w", task: "ECHO x", onProgress: r.onProgress });
	m.opts.profile = resolveProfile({ effort: "max" });
	const res = await p;
	assert.deepEqual(res.details.profile, DEFAULT);
	for (const e of r.events) assert.deepEqual(e.profile, DEFAULT);
	assert.equal(env.log().find((e) => e.method === "session/prompt").config.effort, "high");
});

test("failures before verification keep the configured profile and never claim verification", async (t) => {
	const env = setup(t, { contextOptions: ["300k"] });
	let err = await failure(env.manager().run({ name: "w", task: "ECHO x" }));
	assert.match(err.message, /^Cursor ACP does not offer context=1m/);
	assertFailureMetadata(err, { status: "configured", phase: "setup" });

	const stuck = setup(t, { effortStuck: true });
	err = await failure(stuck.manager().run({ name: "w", task: "ECHO x" }));
	assert.match(err.message, /^Cursor profile verification failed/);
	assertFailureMetadata(err, { status: "configured", phase: "setup" });

	const slow = setup(t, { slowConfigMs: 400 });
	const r = recorder(slow);
	err = await failure(slow.manager().run({ name: "w", task: "ECHO x", timeoutMs: 600, onProgress: r.onProgress }));
	assert.match(err.message, /timed out after 0\.6s during setup, before the task was sent/);
	assertFailureMetadata(err, { status: "configured", phase: "setup" });
	assert.ok(r.events.every((e) => e.profileStatus === "configured"));
});

test("a session/load failure reports the load phase, still configured", async (t) => {
	const env = setup(t);
	const m1 = env.manager();
	await m1.run({ name: "w", task: "ECHO x" });
	await m1.shutdown();
	const err = await failure(env.manager({ fake: { loadFail: true } }).run({ name: "w", task: "ECHO y" }));
	assert.match(err.message, /^session\/load failed/);
	assertFailureMetadata(err, { status: "configured", phase: "load" });
});

test("failures after verification keep the verified label: crash, timeout, cancel", async (t) => {
	const env = setup(t);
	const m = env.manager();
	let err = await failure(m.run({ name: "c", task: "CRASH" }));
	assert.match(err.message, /failed during prompt/);
	assertFailureMetadata(err, { status: "verified", phase: "prompt" });

	err = await failure(m.run({ name: "t", task: "HANG", timeoutMs: 1200 }));
	assert.match(err.message, /timed out after 1\.2s/);
	assertFailureMetadata(err, { status: "verified", phase: "prompt" });
	assert.equal(err.details.cancelled, "timeout");

	const ac = new AbortController();
	const r = recorder(env);
	const p = m.run({ name: "a", task: "HANG", signal: ac.signal, onProgress: r.onProgress });
	for (let i = 0; i < 200 && !r.events.some((e) => e.phase === "prompt"); i++) await sleep(25);
	ac.abort();
	err = await failure(p);
	assertFailureMetadata(err, { status: "verified", phase: "prompt" });
	const count = r.events.length;
	await sleep(300);
	assert.equal(r.events.length, count, "no update after the run was cancelled");
});

test("a throwing progress callback never breaks or leaks a run", async (t) => {
	const env = setup(t);
	const m = env.manager();
	let calls = 0;
	const onProgress = () => {
		calls++;
		throw new Error("renderer exploded");
	};
	const res = await m.run({ name: "w", task: "SLOW 1100", onProgress });
	assert.match(res.text, /slow done/);
	assert.ok(calls >= 5);
	const err = await failure(m.run({ name: "w", task: "REFUSE", onProgress }));
	assertFailureMetadata(err, { status: "verified", phase: "prompt" });
	assert.equal(m.activeRuns.size, 0);
	assert.equal(m.reserved.size, 0);
	assert.match((await m.run({ name: "w", task: "ECHO again" })).text, /again/);
});

test("no progress update arrives after the run ended", async (t) => {
	const env = setup(t);
	const r = recorder(env);
	const res = await env.manager({ permissionPolicy: "allow" }).run({ name: "w", task: "PERM_NOWAIT", onProgress: r.onProgress });
	assert.match(res.text, /first=/);
	const count = r.events.length;
	await sleep(1200);
	assert.equal(r.events.length, count);
	assert.ok(r.events.every((e) => e.status === "running"));
});
