// Import and learner behaviour through the stable CLI and public API, on synthetic session files.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { importHistory, openCacheDb } from "../../lib/cache-insights/index.mjs";
import { cli, dbBytes, loadExtension, MIN, SENTINEL, SessionFile, SOL, T0, tmpEnv, usage } from "./harness.mjs";

const pos = () => usage(200, 10_000, 0);
const zero = () => usage(10_200, 0, 10_000);

/** Positive reads up to 25.5 min (start clock), an early 40 s zero, and zeros from 30.5 min on; responses last 30 s. */
function envelopeSession() {
	const s = new SessionFile({ tag: "env" });
	s.turn({ start: T0 - 2000 * MIN, u: zero() });
	for (const g of [2, 5, 8, 12, 15, 18, 20, 22, 24, 25.5]) s.turn({ gap: g * MIN, u: pos() });
	s.turn({ gap: 40_000, u: zero() });
	for (const g of [31, 30.5, 45, 60]) {
		s.turn({ gap: 3 * MIN, u: pos() });
		s.turn({ gap: g * MIN, u: zero() });
	}
	return s;
}

/** One file per exclusion; each would otherwise add a 40-minute positive read beyond the envelope. */
function noiseSessions(dir) {
	const files = [];
	const scenario = (tag, k, build, opts) => {
		const s = new SessionFile({ tag, ...opts });
		s.turn({ start: T0 - k * 1000 * MIN });
		build(s);
		files.push(s.write(dir));
		return s;
	};
	const late = (s, extra = {}) => s.turn({ gap: 40 * MIN, u: pos(), ...extra });
	scenario("warm", 3, (s) => (s.warm(s.lastStart + 5 * MIN), late(s)));
	scenario("compact", 4, (s) => (s.compaction(s.lastStart + 5 * MIN), late(s)));
	scenario("model", 5, (s) => (s.modelChange(s.lastStart + 5 * MIN, SOL.provider, SOL.model), late(s)));
	scenario("branch", 6, (s) => {
		const a = s.leaf;
		s.turn({ gap: 2 * MIN });
		s.branchFrom(a);
		late(s);
	});
	scenario("error", 7, (s) => (s.turn({ gap: MIN, stop: "error", u: usage(0, 0, 0, 0) }), late(s)));
	scenario("legacy", 9, (s) => late(s), { legacy: true });
	scenario("nousage", 10, (s) => s.turn({ gap: 2 * MIN, u: null }));
	scenario("clock", 11, (s) => s.turn({ start: s.lastStart - 5 * MIN }));
	// "other": the previous response used a different model in the same file.
	const other = new SessionFile({ tag: "other2" });
	other.turn({ start: T0 - 12_000 * MIN, provider: "anthropic", model: "claude-sonnet-5" });
	late(other);
	files.push(other.write(dir));
	return files;
}

test("the learner reproduces the longest-hit / next-zero envelope and ignores an early zero as an expiry frontier", async (t) => {
	const env = tmpEnv(t);
	envelopeSession().write(env.sessionsDir);
	noiseSessions(env.sessionsDir);
	assert.equal(cli(env, ["seed", "github-copilot/gpt-6.1-sol", "25", "30"]).status, 0);
	const imported = cli(env, ["import", "--sessions-dir", env.sessionsRoot]);
	assert.equal(imported.status, 0, imported.stderr);

	const { envelopes, profiles } = cli(env, ["learn", "--model", "github-copilot/gpt-6.1-sol"]).data;
	assert.equal(envelopes.length, 1);
	const e = envelopes[0];
	assert.deepEqual(e.clocks.start, { hitObservedMs: 25.5 * MIN, expiryObservedMs: 30.5 * MIN, positives: 10, zeros: 5, contradictoryZeros: 1, longZeros: 4 });
	assert.deepEqual(e.clocks.end, { hitObservedMs: 25 * MIN, expiryObservedMs: 30 * MIN, positives: 10, zeros: 5, contradictoryZeros: 1, longZeros: 4 });
	assert.equal(e.strong, 15);
	assert.equal(e.weak, 5, "pairs after a zero read are weak and not used for the envelope");
	assert.deepEqual(e.excluded, { warm_between: 1, boundary: 2, ancestry_break: 1, cur_not_success: 1, prev_not_success: 1, model_changed: 1, legacy_ambiguous: 1, usage_missing: 1, clock_anomaly: 1 });
	assert.deepEqual(e.origins, { historical: e.pairs, live: 0, both: 0 });
	assert.deepEqual(
		profiles.map((p) => [p.provider, p.model, p.hitUnderMs, p.expireOverMs]),
		[[SOL.provider, SOL.model, 25 * MIN, 30 * MIN]],
		"candidates never change the active profile",
	);

	const h = loadExtension(t, env, { branch: [] });
	await h.emit("session_start", { reason: "startup" });
	await h.command("learn");
	const text = h.lastNote();
	assert.match(text, /start clock: longest positive-read gap 25\.5 min; earliest longer zero-read gap 30\.5 min; 10 positive, 5 zero \(4 beyond, 1 contradictory, not expiry\)/);
	assert.match(text, /end clock: longest positive-read gap 25\.0 min; earliest longer zero-read gap 30\.0 min/);
	assert.match(text, /Active profile: 25\.0 min \/ 30\.0 min \(seed\)/);
	assert.match(text, /not a 95% guarantee/);
	await h.command("status");
	assert.match(h.lastNote(), /Observed candidate \(not active\): 15 strong pairs/);
	assert.equal(cli(env, ["status"]).data.profiles[0].hitUnderMs, 25 * MIN);
});

test("re-imports, copied sessions, and hard-link aliases are idempotent; symlinks are skipped; parse errors are counted without text", async (t) => {
	const env = tmpEnv(t);
	const file = envelopeSession().write(env.sessionsDir);
	const legacy = new SessionFile({ tag: "leg", legacy: true });
	legacy.turn({ start: T0 - 9000 * MIN });
	legacy.turn({ gap: 2 * MIN });
	legacy.write(env.sessionsDir);
	const sol = ["--model", "github-copilot/gpt-6.1-sol"];
	const first = cli(env, ["import", "--sessions-dir", env.sessionsRoot, ...sol]).data.summary;
	assert.equal(first.responses.added, 22);
	assert.equal(first.pairs.added, 20);

	fs.copyFileSync(file, path.join(env.sessionsDir, `${SENTINEL}-fork-copy.jsonl`));
	fs.linkSync(file, path.join(env.sessionsDir, "alias.jsonl"));
	fs.symlinkSync(file, path.join(env.sessionsDir, "link.jsonl"));
	fs.writeFileSync(path.join(env.sessionsDir, "broken.jsonl"), `{"type":"session"}\nnot json ${SENTINEL}\n[1,2]\n"${SENTINEL}"\n{"type":"message","message":{"role":"assistant","provider":"github-copilot","model":"gpt-6.1-sol"}}\n`);
	const again = cli(env, ["import", "--sessions-dir", env.sessionsRoot, ...sol]);
	const s = again.data.summary;
	assert.equal(s.responses.added, 1, "only the new response without a request start (kept, keyed by import position)");
	assert.equal(s.pairs.added, 0);
	assert.equal(s.responses.duplicate, 3 * 20 + 2, "original, copy, and alias deduplicate (legacy rows too)");
	assert.equal(s.files.symlink, 1);
	assert.deepEqual(s.parseErrors, { invalid_json: 1, oversized_line: 0, not_object: 2 });
	assert.equal(s.responses.missing_start, 1, "a response without a request start is counted and kept");
	const third = cli(env, ["import", "--sessions-dir", env.sessionsRoot, ...sol]);
	assert.equal(third.data.summary.responses.added, 0, "re-imports stay idempotent, including position-keyed rows");
	assert.equal(cli(env, ["status"]).data.counts.samples, 23);
	for (const out of [again.stdout, again.stderr, cli(env, ["import", "--sessions-dir", env.sessionsRoot, ...sol], { json: false }).stdout]) assert.ok(!out.includes(SENTINEL));

	const db = await openCacheDb({ root: env.root, workspaceCwd: env.workspace });
	t.after(() => db.close());
	await assert.rejects(importHistory(db, { sessionsDir: env.sessionsRoot }), (e) => e.code === "no_targets", "no implicit default targets");
	const small = await importHistory(db, { sessionsDir: env.sessionsRoot, targets: ["github-copilot/gpt-6.1-sol"], maxLineBytes: 200 });
	assert.ok(small.parseErrors.oversized_line > 0, "oversized lines are skipped by count");
	assert.equal(small.responses.added, 0);
});

test("explicit targets (Opus separators normalized) keep stored ids and preserve zeros vs unknown; no targets creates nothing", async (t) => {
	const env = tmpEnv(t);
	const s = new SessionFile({ tag: "mix" });
	s.turn({ start: T0 - 500 * MIN, provider: SOL.provider, model: "claude-opus-5-5" });
	s.turn({ gap: MIN, provider: SOL.provider, model: "gpt-6-astra" });
	s.turn({ gap: MIN, provider: SOL.provider, model: "gpt-6-mini" });
	s.turn({ gap: MIN, stop: "error", u: usage(0, 0, 0, 0) });
	s.turn({ gap: MIN, u: null });
	s.warm(s.lastStart + 2 * MIN);
	s.write(env.sessionsDir);
	const none = cli(env, ["import", "--sessions-dir", env.sessionsRoot]);
	assert.equal(none.status, 1);
	assert.match(none.stderr, /^cache-insights: no_targets: /);
	assert.ok(!fs.existsSync(env.root), "no database without targets");
	const three = ["github-copilot/gpt-6.1-sol", "github-copilot/gpt-6-astra", "github-copilot/claude-opus-5.5"].flatMap((m) => ["--model", m]);
	const r = cli(env, ["import", "--sessions-dir", env.sessionsRoot, ...three]).data.summary;
	assert.equal(r.responses.matched, 4, "gpt-6-mini was not asked for");
	assert.equal(r.warms.added, 1);
	const only = tmpEnv(t);
	s.write(only.sessionsDir);
	assert.equal(cli(only, ["import", "--sessions-dir", only.sessionsRoot, "--model", "github-copilot/claude-opus-5.5"]).data.summary.responses.added, 1);

	const h = loadExtension(t, env, { branch: [] });
	await h.emit("session_start", { reason: "startup" });
	await h.command("history 10");
	const lines = h.lastNote().split("\n");
	assert.match(lines[1], /historical response github-copilot\/claude-opus-5-5 stop=toolUse in=200 cacheRead=10000/);
	assert.match(lines[3], /gpt-6\.1-sol stop=error in=0 cacheRead=0 cacheWrite=0 out=0 cost=\$0\.000000 end=entry_timestamp_proxy/, "reported zeros stay zero");
	assert.match(lines[4], /gpt-6\.1-sol stop=toolUse in=\? cacheRead=\? cacheWrite=\? out=\? cost=\? end=entry_timestamp_proxy/, "missing usage stays unknown");
	assert.match(lines[5], /historical warm github-copilot\/gpt-6\.1-sol stop=-/);
	const { envelopes } = cli(env, ["learn"]).data;
	assert.ok(envelopes.every((e) => e.qualified === 0 || e.model !== "gpt-6-mini"));
	assert.ok(!dbBytes(env).includes(SENTINEL));
});

test("live recording adds samples and pairs, persists across sessions, and stores no content", async (t) => {
	const env = tmpEnv(t);
	assert.equal(cli(env, ["seed", "github-copilot/gpt-6.1-sol", "25", "30"]).status, 0);
	const h = loadExtension(t, env, { branch: [] });
	await h.emit("session_start", { reason: "startup" });
	await h.command("on");
	assert.match(h.lastNote(), /Recording is on \(saved for future sessions\)\. Pi stores metadata only/);
	await h.respond();
	h.advance(3 * MIN);
	await h.respond();
	await h.emit("session_compact", {});
	h.advance(MIN);
	await h.respond();
	await h.emit("session_shutdown", { reason: "quit" });

	const next = loadExtension(t, env, { branch: [] });
	await next.emit("session_start", { reason: "resume" });
	next.at(T0 + 60 * MIN);
	await next.respond();
	next.advance(MIN);
	await next.respond();
	await next.command("off");
	await next.respond();
	const { envelopes } = cli(env, ["learn"]).data;
	assert.equal(envelopes[0].origins.live, 3);
	assert.equal(envelopes[0].qualified, 2);
	assert.deepEqual(envelopes[0].excluded, { boundary: 1 });
	assert.equal(cli(env, ["status"]).data.counts.live, 5, "nothing recorded after /cache off");
	assert.equal(cli(env, ["status"]).data.recording, false);
	assert.ok(!dbBytes(env).includes(SENTINEL));
	assert.ok(!JSON.stringify([h.notes, h.statuses, next.notes, next.statuses]).includes(SENTINEL));
});

test("live and imported observations of the same pair merge order-independently; an exclusion from either wins", async (t) => {
	for (const liveFirst of [true, false]) {
		const env = tmpEnv(t);
		assert.equal(cli(env, ["seed", "github-copilot/gpt-6.1-sol", "25", "30"]).status, 0);
		const s1 = T0 - 30 * MIN;
		const s2 = T0 - 20 * MIN;
		const file = new SessionFile({ tag: "merge" });
		file.turn({ start: s1 });
		file.turn({ start: s2 });
		file.write(env.sessionsDir);
		const live = async () => {
			const h = loadExtension(t, env, { branch: [] });
			await h.emit("session_start", { reason: "startup" });
			await h.command("on");
			h.at(s1);
			await h.respond();
			await h.emit("session_compact", {});
			h.at(s2);
			await h.respond();
			await h.emit("session_shutdown", { reason: "quit" });
		};
		const imported = () => assert.equal(cli(env, ["import", "--sessions-dir", env.sessionsRoot]).status, 0);
		if (liveFirst) {
			await live();
			imported();
		} else {
			imported();
			await live();
		}
		const [e] = cli(env, ["learn"]).data.envelopes;
		assert.equal(e.pairs, 1, `${liveFirst ? "live" : "import"} first: one pair`);
		assert.equal(e.qualified, 0, "the live boundary keeps it excluded");
		assert.deepEqual(e.excluded, { boundary: 1 });
		assert.deepEqual(e.origins, { historical: 0, live: 0, both: 1 });
	}
});

test("pair gates: a model mismatch, an inverted response time, or missing previous usage never qualifies", async (t) => {
	const env = tmpEnv(t);
	assert.equal(cli(env, ["seed", "github-copilot/gpt-6.1-sol", "25", "30"]).status, 0);
	const s = new SessionFile({ tag: "gates" });
	s.turn({ start: T0 - 100 * MIN });
	s.user(T0 - 89 * MIN);
	s.assistant({ start: T0 - 88 * MIN, end: T0 - 87 * MIN, usage: usage(200, 10_000, 0), responseModel: "gpt-6.1-sol-mini" });
	s.turn({ gap: 2 * MIN });
	s.user(T0 - 79 * MIN);
	s.assistant({ start: T0 - 78 * MIN, end: T0 - 79 * MIN, usage: usage(200, 10_000, 0) });
	s.turn({ gap: 2 * MIN, u: { input: 5, output: 1 } });
	s.turn({ gap: 2 * MIN });
	s.turn({ gap: 2 * MIN, u: { ...usage(200, 10_000, 0), cacheRead: undefined } });
	s.turn({ gap: 2 * MIN });
	s.write(env.sessionsDir);
	assert.equal(cli(env, ["import", "--sessions-dir", env.sessionsRoot]).status, 0);
	const [e] = cli(env, ["learn"]).data.envelopes;
	assert.deepEqual(e.excluded, { model_mismatch: 2, clock_anomaly: 1, usage_missing: 2, prev_usage_missing: 2 });
});
