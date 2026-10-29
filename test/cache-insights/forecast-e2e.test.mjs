// End to end: synthetic history → CLI import/seed/settings → extension hooks and /cache → visible status.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { cli, loadExtension, MIN, SENTINEL, SessionFile, SOL, T0, tmpEnv, usage } from "./harness.mjs";

/** History with a latest Sol response that started at T0-10min and ended at T0-9min; seeded 25/30, UTC, cost off. */
function seeded(t, { extra } = {}) {
	const env = tmpEnv(t);
	const s = new SessionFile({ tag: "a" });
	s.turn({ start: T0 - 70 * MIN, dur: 60_000 });
	s.toolResult(T0 - 68 * MIN);
	s.turn({ start: T0 - 10 * MIN, dur: 60_000 });
	extra?.(s);
	s.write(env.sessionsDir);
	assert.equal(cli(env, ["seed", "github-copilot/gpt-6.1-sol", "25", "30"]).status, 0);
	assert.equal(cli(env, ["import", "--sessions-dir", env.sessionsRoot]).status, 0, "imports the seeded models");
	assert.equal(cli(env, ["settings", "--time", "utc", "--cost", "off"]).status, 0);
	return { env, s };
}

test("startup recovers the anchor from the current branch and applies both clocks with inclusive edges", async (t) => {
	const { env, s } = seeded(t);
	// A more recent response in another session must not be used: only the current branch counts.
	const other = new SessionFile({ tag: "b" });
	other.turn({ start: T0 - 2 * MIN });
	other.write(env.sessionsDir);
	assert.equal(cli(env, ["import", "--sessions-dir", env.sessionsRoot]).data.summary.responses.added, 1);

	const h = loadExtension(t, env, { branch: s.branch() });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.status(), "cache hit · until 12:15 UTC");
	await h.emit("model_select", { model: { provider: SOL.provider, id: SOL.model }, source: "restore" });
	assert.equal(h.status(), "cache hit · until 12:15 UTC", "a startup model restore without a previous model is not a change");
	h.at(T0 + 15 * MIN - 1);
	assert.equal(await h.tick(), "cache hit · until 12:15 UTC");
	h.at(T0 + 15 * MIN);
	// The minute timer is not due 1 ms later; the edge-aligned refresh changes the label exactly at the boundary.
	assert.equal(await h.tick(), "uncertain · expired after 12:21 UTC", "exactly 25 min since request start is uncertain");
	h.at(T0 + 21 * MIN);
	assert.equal(await h.tick(), "uncertain · expired after 12:21 UTC", "exactly 30 min since response end is uncertain");
	h.at(T0 + 21 * MIN + 1);
	assert.equal(await h.tick(), "cache expired");

	await h.command("status");
	const text = h.lastNote();
	assert.match(text, /seeded, provisional: a local estimate, not provider confirmation/);
	assert.match(text, /recovered from the current branch; end = saved entry time \(proxy\)/);
	assert.match(text, /since request start: 31\.0 min/);
	assert.match(text, /since response end: {2}30\.0 min/);
	assert.match(text, /Forecast for the next request: cache expired/);
	assert.match(text, /Active profile \(seed\): cache hit while both clocks are under 25\.0 min; cache expired once both are over 30\.0 min/);
	await h.emit("session_shutdown", { reason: "quit" });
	const rendered = h.statuses.length;
	h.at(T0 + 90 * MIN);
	await h.tick();
	assert.equal(h.statuses.length, rendered, "no renders after shutdown");
	assert.equal(h.timers.size, 0, "shutdown cancels every timer");
});

test("live anchors use message_end receipt; a long stream disagrees between clocks and stays uncertain", async (t) => {
	const { env } = seeded(t);
	const h = loadExtension(t, env, { branch: [] });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.status(), "uncertain · no usable previous response yet");
	await h.respond({ dur: 26 * MIN });
	assert.match(h.status(), /^uncertain · expired after /, "started 26 min ago, ended now: not a hit");
	await h.respond({ dur: 30_000 });
	assert.match(h.status(), /^cache hit · until /);
	h.advance(10 * MIN);
	await h.emit("message_start", { message: { role: "user" } });
	assert.match(await h.tick(), /^cache hit/, "ordinary user/tool appends do not reset the clocks");
	await h.respond({ responseModel: "gpt-6.1-sol-2026-10-01" });
	assert.match(h.status(), /^cache hit/, "a dated variant of the requested model is the same model");
	await h.respond({ responseModel: "gpt-4.1" });
	assert.equal(h.status(), "uncertain · provider answered with a different model");
	await h.respond();
	await h.respond({ responseModel: "gpt-6.1-sol-mini" });
	assert.equal(h.status(), "uncertain · provider answered with a different model", "a different model with the same prefix is not the same model");
});

test("an unknown provider/model never inherits another model's seed", async (t) => {
	const { env, s } = seeded(t);
	for (const model of [{ provider: "openai", model: SOL.model }, { provider: SOL.provider, model: "gpt-6-astra" }]) {
		const h = loadExtension(t, env, { branch: s.branch(), model });
		await h.emit("session_start", { reason: "startup" });
		assert.equal(h.status(), "uncertain · no seeded profile for this model");
		await h.respond({ provider: model.provider, model: model.model });
		assert.equal(h.status(), "uncertain · no seeded profile for this model");
		await h.emit("session_shutdown", { reason: "quit" });
	}
});

test("transitions make the forecast uncertain until the next usable response", async (t) => {
	const { env } = seeded(t);
	const h = loadExtension(t, env, { branch: [] });
	await h.emit("session_start", { reason: "startup" });
	await h.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { selectedTools: ["read"] } });
	const cases = [
		["model changed", () => h.emit("model_select", { model: { provider: SOL.provider, id: "gpt-6-astra" }, previousModel: { provider: SOL.provider, id: SOL.model } })],
		["thinking level changed", () => h.emit("thinking_level_select", { level: "xhigh", previousLevel: "high" })],
		["context compacted", () => h.emit("session_compact", { compactionEntry: { summary: SENTINEL }, reason: "threshold" })],
		["moved in the session tree", () => h.emit("session_tree", { newLeafId: "x", oldLeafId: "y" })],
		["system prompt or tools changed", () => h.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { selectedTools: ["read", "bash"] } })],
		["previous request failed", () => h.respond({ stop: "error", u: usage(0, 0, 0, 0) })],
		["previous request aborted", () => h.respond({ stop: "aborted" })],
		[
			"cache warm with unknown start",
			async () => {
				h.branch.push({ type: "usage", id: "w1", timestamp: new Date(h.clock.w).toISOString(), kind: "cache_warm", provider: SOL.provider, model: SOL.model, usage: usage(1, 10_000, 0, 1), note: SENTINEL });
				await h.emit("agent_settled", { aborted: false });
			},
		],
	];
	for (const [reason, apply] of cases) {
		await h.respond();
		assert.match(h.status(), /^cache hit/);
		await apply();
		assert.equal(h.status(), `uncertain · ${reason}`, reason);
		h.advance(MIN);
		assert.equal(await h.tick(), `uncertain · ${reason}`, `${reason} persists until the next response`);
	}
	await h.respond();
	assert.match(h.status(), /^cache hit/);
});

test("branch boundaries after a recovered anchor, forks, and new sessions are uncertain; plain appends are not", async (t) => {
	const cases = [
		["context compacted", (s) => s.compaction(T0 - 5 * MIN)],
		["model changed", (s) => s.modelChange(T0 - 5 * MIN, SOL.provider, "gpt-6-astra")],
		["thinking level changed", (s) => s.thinkingChange(T0 - 5 * MIN, "low")],
		["cache warm with unknown start", (s) => s.warm(T0 - 5 * MIN)],
		["previous request failed", (s) => s.turn({ start: T0 - 4 * MIN, stop: "error", u: usage(0, 0, 0, 0) })],
		["system prompt or tools changed", (s) => s.system(T0 - 5 * MIN)],
	];
	for (const [reason, extra] of cases) {
		const { env, s } = seeded(t, { extra });
		const h = loadExtension(t, env, { branch: s.branch() });
		await h.emit("session_start", { reason: "resume" });
		assert.equal(h.status(), `uncertain · ${reason}`, reason);
	}
	const { env, s } = seeded(t, {
		extra: (x) => {
			x.user(T0 - 3 * MIN);
			x.custom(T0 - 2 * MIN);
			x.toolResult(T0 - MIN);
		},
	});
	for (const [reason, expected] of [
		["resume", "cache hit · until 12:15 UTC"],
		["reload", "uncertain · extension reloaded"],
		["fork", "uncertain · forked session"],
		["new", "uncertain · new session"],
	]) {
		const h = loadExtension(t, env, { branch: reason === "new" ? [] : s.branch() });
		await h.emit("session_start", { reason });
		assert.equal(h.status(), expected, reason);
	}
});

test("clock sanity: negative or backward wall time is uncertain; time that passed while asleep is not hidden", async (t) => {
	const { env } = seeded(t);
	const h = loadExtension(t, env, { branch: [] });
	await h.emit("session_start", { reason: "startup" });
	await h.respond();
	h.clock.w -= 60 * MIN;
	h.clock.m += MIN;
	assert.equal(await h.tick(), "uncertain · clock anomaly");
	await h.respond();
	h.clock.m += 10 * MIN;
	h.clock.w += 2 * MIN;
	assert.equal(await h.tick(), "uncertain · wall clock moved backward");
	await h.respond();
	h.clock.m += MIN;
	h.clock.w += 45 * MIN;
	assert.equal(await h.tick(), "cache expired");
	await h.command("status");
	assert.match(h.lastNote(), /clock check: wall_ahead/);
});

test("approximate input cost ranges: units, host pricing tiers, cache-write pricing, context size, and unpriced models", async (t) => {
	const { env, s } = seeded(t);
	const status = async (cost, mode, extra = {}) => {
		assert.equal(cli(env, ["settings", "--cost", mode]).status, 0);
		const h = loadExtension(t, env, { branch: s.branch(), model: { ...SOL, cost } });
		Object.assign(h.ctx, extra);
		await h.emit("session_start", { reason: "startup" });
		return h;
	};
	const flat = { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 };
	// Anchor usage: 200 input + 10,000 cache read; next prompt ≈ 10,300 tokens (anchor prompt + its 100 output).
	assert.equal((await status(flat, "usd")).status(), "cache hit · until 12:15 UTC · miss ≈$0.021");
	assert.equal((await status(flat, "credits")).status(), "cache hit · until 12:15 UTC · miss ≈2.1 cr");
	assert.equal((await status(flat, "both")).status(), "cache hit · until 12:15 UTC · miss ≈$0.021 (2.1 cr)");
	assert.equal((await status(flat, "off")).status(), "cache hit · until 12:15 UTC");
	assert.equal((await status({ ...flat, cacheWrite: 2.5 }, "usd")).status(), "cache hit · until 12:15 UTC · miss ≈$0.021–$0.026");
	assert.equal((await status(flat, "usd", { getContextUsage: () => ({ tokens: 50_000 }) })).status(), "cache hit · until 12:15 UTC · miss ≈$0.100");

	// Pi's host shape: tiers replace all prices for prompts above inputTokensAbove.
	const tiered = { input: 2, output: 8, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272_000, input: 4, output: 16, cacheRead: 0.2, cacheWrite: 5 }] };
	const ctxTokens = (tokens) => ({ getContextUsage: () => ({ tokens }) });
	assert.equal((await status(tiered, "usd", ctxTokens(200_000))).status(), "cache hit · until 12:15 UTC · miss ≈$0.400–$0.500");
	assert.equal((await status(tiered, "usd", ctxTokens(272_000))).status(), "cache hit · until 12:15 UTC · miss ≈$0.544–$0.680", "the tier starts strictly above its threshold");
	assert.equal((await status(tiered, "usd", ctxTokens(300_000))).status(), "cache hit · until 12:15 UTC · miss ≈$1.20–$1.50");
	assert.equal((await status({ ...flat, tiers: [{ above: 10_000, input: 4 }] }, "usd")).status(), "cache hit · until 12:15 UTC", "an unrecognized tier shape is unknown, not guessed");

	const readFree = await status({ input: 2, output: 8, cacheRead: 0, cacheWrite: 0 }, "usd");
	await readFree.command("status");
	assert.match(readFree.lastNote(), /hit \$0\.0002, miss \$0\.021/, "a zero cache-read price with a positive input price is a real price");
	for (const cost of [{ output: 8 }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, undefined]) {
		const unknown = await status(cost, "usd");
		assert.equal(unknown.status(), "cache hit · until 12:15 UTC", "missing or all-zero prices show no cost, never $0");
		await unknown.command("status");
		assert.match(unknown.lastNote(), /Approximate input cost: unknown/);
	}
	const shown = await status(flat, "both");
	await shown.command("status");
	assert.match(shown.lastNote(), /response generation excluded; Pi catalog estimate, not a bill\): hit \$0\.0022 \(0\.2 cr\), miss \$0\.021 \(2\.1 cr\)\. Credits use 1 credit = \$0\.01 and apply only to credit-based plans; they are not your balance\./);
});

test("without a database nothing is created, no timer runs, and writes need the TUI plus confirmation", async (t) => {
	const env = tmpEnv(t);
	const h = loadExtension(t, env, { branch: [], confirm: false });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.status(), undefined);
	assert.equal(h.timers.size, 0, "no timer without a database");
	await h.respond();
	await h.command("status");
	assert.match(h.lastNote(), /Not set up: no database yet/);
	await h.command("seed github-copilot/gpt-6.1-sol 25 30");
	assert.equal(h.lastNote(), "Cancelled; nothing changed.");
	for (const bad of ["settings time pst", "settings cost", "settings time utc time local", "seed github-copilot/gpt-6.1-sol 25", "seed github-copilot/gpt-6.1-sol 30 25", "seed nomodel 25 30", "import", "import bad", "migrate now", "bogus"]) {
		await h.command(bad);
		assert.equal(h.notes.at(-1)[0], "warning", bad);
	}
	assert.match(h.lastNote(), /^Usage: \/cache/);
	assert.ok(!fs.existsSync(env.root), "nothing created by loading, status, a cancelled seed, or invalid commands");

	for (const mode of ["print", "json", "rpc"]) {
		const r = loadExtension(t, env, { mode, branch: [] });
		await r.emit("session_start", { reason: "startup" });
		for (const args of ["on", "seed github-copilot/gpt-6.1-sol 25 30", "import", "settings time utc", "status", "history", "learn", "settings"]) await r.command(args);
		assert.ok(!fs.existsSync(env.root), `${mode}: read-only`);
		assert.deepEqual(r.uiErrors, []);
		assert.deepEqual(r.statuses, []);
		if (mode === "rpc") assert.match(r.notes[0][1], /only available in the interactive TUI; nothing changed/);
	}

	const tui = loadExtension(t, env, { branch: [] });
	await tui.emit("session_start", { reason: "startup" });
	await tui.command("seed github-copilot/gpt-6.1-sol 25 30");
	assert.match(tui.confirms[0][1], /writes only the cache-insights database/);
	assert.equal(fs.statSync(env.dbPath).mode & 0o777, 0o600);
	await tui.command("seed github-copilot/gpt-6.1-sol 30 25");
	assert.match(tui.lastNote(), /Minutes must satisfy 0 < hit <= expire <= 1440; nothing changed/);
	await tui.emit("session_shutdown", { reason: "quit" });
	await tui.emit("session_shutdown", { reason: "quit" });
	assert.equal(tui.timers.size, 0, "shutdown cancels every timer, idempotently");
	await tui.emit("session_start", { reason: "reload" });
	await tui.emit("session_start", { reason: "reload" });
	const before = tui.statuses.length;
	tui.advance(MIN);
	await tui.tick();
	assert.equal(tui.statuses.length - before, 1, "after two reloads one minute renders once, not twice");
});

test("the label changes exactly at the hit edge between minute ticks, and nothing renders after shutdown", async (t) => {
	const env = tmpEnv(t);
	const s = new SessionFile({ tag: "edge" });
	// Started 9.5 min before session start: the 25-minute edge is at T0 + 15.5 min, between minute ticks.
	s.turn({ start: T0 - 9.5 * MIN, dur: 60_000 });
	s.write(env.sessionsDir);
	assert.equal(cli(env, ["seed", "github-copilot/gpt-6.1-sol", "25", "30"]).status, 0);
	assert.equal(cli(env, ["settings", "--time", "utc", "--cost", "off"]).status, 0);
	const h = loadExtension(t, env, { branch: s.branch() });
	await h.emit("session_start", { reason: "startup" });
	h.at(T0 + 15 * MIN);
	assert.equal(await h.tick(), "cache hit · until 12:15 UTC");
	h.at(T0 + 15.5 * MIN - 1);
	assert.equal(await h.tick(), "cache hit · until 12:15 UTC");
	const rendered = h.statuses.length;
	h.at(T0 + 15.5 * MIN);
	assert.equal(await h.tick(), "uncertain · expired after 12:22 UTC", "flips at the edge, 30 s before the next minute tick");
	assert.equal(h.statuses.length, rendered + 1, "one render at the edge");
	await h.emit("session_shutdown", { reason: "quit" });
	const after = h.statuses.length;
	h.at(T0 + 60 * MIN);
	await h.tick();
	assert.equal(h.statuses.length, after, "no renders after shutdown");
});

test("Anthropic and OpenAI snapshot responses count as the requested model; other suffixes do not", async (t) => {
	const env = tmpEnv(t);
	assert.equal(cli(env, ["seed", "github-copilot/claude-opus-5.5", "4", "5"]).status, 0);
	const h = loadExtension(t, env, { branch: [], model: { provider: SOL.provider, model: "claude-opus-5.5" } });
	await h.emit("session_start", { reason: "startup" });
	const opus = { provider: SOL.provider, model: "claude-opus-5.5" };
	for (const [responseModel, label] of [
		["claude-opus-5-5-20261101", /^cache hit/],
		["claude-opus-5.5-2026-11-01", /^cache hit/],
		["claude-opus-5-5-mini", /^uncertain · provider answered with a different model/],
		["claude-opus-5-20261101", /^uncertain · provider answered with a different model/],
		["claude-opus-5-5-2026110", /^uncertain · provider answered with a different model/],
	]) {
		await h.respond({ ...opus, responseModel });
		assert.match(h.status(), label, responseModel);
	}
});

test("the known Opus alias links seed, import, learning, and live anchors; ids are stored as reported", async (t) => {
	const env = tmpEnv(t);
	const s = new SessionFile({ tag: "opus" });
	const model = "claude-opus-5-5";
	s.turn({ start: T0 - 60 * MIN, provider: SOL.provider, model });
	s.turn({ gap: 3 * MIN, provider: SOL.provider, model });
	s.turn({ gap: 3 * MIN, provider: SOL.provider, model, start: T0 - 10 * MIN });
	s.write(env.sessionsDir);
	assert.equal(cli(env, ["seed", "github-copilot/claude-opus-5.5", "25", "30"]).status, 0);
	assert.equal(cli(env, ["settings", "--time", "utc", "--cost", "off"]).status, 0);
	const imported = cli(env, ["import", "--sessions-dir", env.sessionsRoot]).data;
	assert.deepEqual(imported.targets, ["github-copilot/claude-opus-5.5"]);
	assert.equal(imported.summary.responses.added, 3, "the 5-5 history matches the 5.5 seed");
	const [e] = cli(env, ["learn", "--model", "github-copilot/claude-opus-5.5"]).data.envelopes;
	assert.equal(e.model, "claude-opus-5.5");
	assert.deepEqual(e.models, ["claude-opus-5-5"], "raw reported ids are kept");
	assert.equal(e.qualified, 2);
	assert.equal(cli(env, ["seed", "github-copilot/claude-opus-5-5", "25", "35"]).status, 0);
	const { profiles } = cli(env, ["status"]).data;
	assert.deepEqual(
		profiles.map((p) => [p.model, p.expireOverMs]),
		[["claude-opus-5.5", 35 * MIN]],
		"seeding the alias updates the one profile",
	);

	const h = loadExtension(t, env, { branch: s.branch(), model: { provider: SOL.provider, model: "claude-opus-5.5" } });
	await h.emit("session_start", { reason: "resume" });
	assert.equal(h.status(), "cache hit · until 12:15 UTC", "a 5-5 anchor on the branch serves the active 5.5 model");
	await h.respond({ provider: SOL.provider, model });
	assert.match(h.status(), /^cache hit · until 12:25 UTC/);
	const other = loadExtension(t, env, { branch: s.branch(), model: { provider: "anthropic", model: "claude-opus-5.5" } });
	await other.emit("session_start", { reason: "resume" });
	assert.equal(other.status(), "uncertain · no seeded profile for this model", "never across providers");
});

test("a repeated message_end never moves the anchor or pairs a response with itself, with recording on or off", async (t) => {
	for (const recording of [true, false]) {
		const env = tmpEnv(t);
		assert.equal(cli(env, ["seed", "github-copilot/gpt-6.1-sol", "25", "30"]).status, 0);
		assert.equal(cli(env, ["settings", "--time", "utc", "--cost", "off"]).status, 0);
		const h = loadExtension(t, env, { branch: [] });
		await h.emit("session_start", { reason: "startup" });
		if (recording) await h.command("on");
		const message = { role: "assistant", content: [], api: "openai-responses", ...SOL, usage: usage(200, 10_000, 0), stopReason: "toolUse", timestamp: h.clock.w };
		h.advance(30_000);
		await h.emit("message_end", { message });
		assert.equal(h.status(), "cache hit · until 12:25 UTC");
		h.advance(5 * MIN);
		await h.emit("message_end", { message });
		await h.emit("message_end", { message: { ...message, usage: usage(200, 10_000, 0) } });
		await h.command("status");
		assert.match(h.lastNote(), /since response end: {2}5\.0 min/, "the end time is the first receipt, not the repeat");
		assert.equal(h.status(), "cache hit · until 12:25 UTC");
		await h.respond({ stop: "error", u: usage(0, 0, 0, 0) });
		assert.equal(h.status(), "uncertain · previous request failed");
		h.advance(MIN);
		await h.respond();
		assert.match(h.status(), /^cache hit/, "a genuinely new response after an error is not mistaken for a repeat");
		if (recording) {
			const { envelopes } = cli(env, ["learn"]).data;
			assert.equal(envelopes[0].pairs, 2, "first→error and error→retry; no self pair");
			assert.deepEqual(envelopes[0].excluded, { cur_not_success: 1, prev_not_success: 1 });
			assert.equal(cli(env, ["status"]).data.counts.live, 3);
		}
	}
});

test("a model select between Opus version-separator aliases is not a model change; a real change still is", async (t) => {
	const env = tmpEnv(t);
	assert.equal(cli(env, ["seed", "github-copilot/claude-opus-5.5", "25", "30"]).status, 0);
	const opus = { provider: SOL.provider, model: "claude-opus-5.5" };
	const h = loadExtension(t, env, { branch: [], model: opus });
	await h.emit("session_start", { reason: "startup" });
	await h.command("on");
	await h.respond(opus);
	await h.emit("model_select", { model: { provider: SOL.provider, id: "claude-opus-5-5" }, previousModel: { provider: SOL.provider, id: "claude-opus-5.5" }, source: "restore" });
	assert.match(h.status(), /^cache hit/, "alias-only select keeps the hit");
	h.advance(MIN);
	await h.respond(opus);
	const [e] = cli(env, ["learn"]).data.envelopes;
	assert.equal(e.qualified, 1, "and does not exclude the learning pair");
	await h.emit("model_select", { model: { provider: "anthropic", id: "claude-opus-5.5" }, previousModel: { provider: SOL.provider, id: "claude-opus-5.5" }, source: "set" });
	assert.equal(h.status(), "uncertain · model changed", "another provider is a change");
	await h.respond(opus);
	await h.emit("model_select", { model: { provider: SOL.provider, id: "claude-opus-5-6" }, previousModel: { provider: SOL.provider, id: "claude-opus-5.5" }, source: "set" });
	assert.equal(h.status(), "uncertain · model changed", "another version is a change");
});

test("startup/resume keeps the history forecast only when the configuration is verified unchanged", async (t) => {
	const { env, s } = seeded(t);
	for (const [baseline, reason, expected] of [
		[{ status: "unchanged" }, "resume", "cache hit · until 12:15 UTC"],
		[{ status: "unknown" }, "startup", "uncertain · configuration not verifiable"],
		[{ status: "changed", reason: "system_or_tools_changed" }, "startup", "uncertain · system prompt or tools changed"],
		[{ status: "changed", reason: "thinking_change" }, "resume", "uncertain · thinking level changed"],
		[null, "startup", "uncertain · configuration not verifiable"],
		[{ status: "unchanged" }, "reload", "uncertain · extension reloaded"],
		[{ status: "unchanged" }, "fork", "uncertain · forked session"],
	]) {
		const h = loadExtension(t, env, { branch: s.branch(), baseline });
		await h.emit("session_start", { reason });
		assert.equal(h.status(), expected, `${reason} with ${JSON.stringify(baseline)}`);
		if (reason === "reload" || reason === "fork") assert.equal(h.baselineCalls, 0, "a verified baseline never clears reload or fork");
	}
});

test("every request re-verifies a recovered anchor until a live response replaces it", async (t) => {
	const { env, s } = seeded(t);
	const config = { changed: false };
	const h = loadExtension(t, env, { branch: s.branch(), baseline: () => (config.changed ? { status: "changed", reason: "system_or_tools_changed" } : { status: "unchanged" }) });
	await h.emit("session_start", { reason: "resume" });
	assert.equal(h.status(), "cache hit · until 12:15 UTC");
	await h.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { selectedTools: ["read"] } });
	assert.equal(h.status(), "cache hit · until 12:15 UTC", "verified unchanged before the first request");
	config.changed = true;
	await h.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { selectedTools: ["read"] } });
	assert.equal(h.status(), "uncertain · system prompt or tools changed", "a change is caught before the request even when the hook payload looks the same");
	await h.respond();
	assert.match(h.status(), /^cache hit/, "a usable live response becomes the anchor");
	const calls = h.baselineCalls;
	await h.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { selectedTools: ["read"] } });
	assert.equal(h.baselineCalls, calls, "live anchors use the in-memory prompt/tool comparison instead");
	assert.match(h.status(), /^cache hit/);
});
