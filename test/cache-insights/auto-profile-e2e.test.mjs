// Automatic (derived, never stored) profiles and footer progress, end to end: synthetic history → CLI import →
// registered hooks, timers, /cache, and the menu → the real footer text. A seed always wins; nothing is ever stored.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AUTO_MIN_LATER_MISSES, AUTO_MIN_REUSE_PAIRS, AUTO_POLICY, autoDecision } from "../../lib/cache-insights/index.mjs";
import { cli, loadExtension, MIN, REPO, SENTINEL, SessionFile, SOL, T0, tmpEnv, usage } from "./harness.mjs";

const ASTRA = { provider: "github-copilot", model: "gpt-6-astra" };
const ASTRA_REF = "github-copilot/gpt-6-astra";
const pos = () => usage(200, 10_000, 0);
const cold = () => usage(10_200, 0, 10_000);
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const recorder = { fg: (token, text) => `<${token}:${text}>` };

/** A cold start, a reuse 2 min later, a reuse `hit` min later, then (unless null) a later miss `zero` min later. */
function chain(dir, tag, ref, { start, hit = 12, zero = 50, dur = 30_000 } = {}) {
	const s = new SessionFile({ tag });
	s.turn({ start, u: cold(), dur, ...ref });
	s.turn({ gap: 2 * MIN, u: pos(), dur, ...ref });
	s.turn({ gap: hit * MIN, u: pos(), dur, ...ref });
	if (zero !== null) s.turn({ gap: zero * MIN, u: cold(), dur, ...ref });
	s.write(dir);
	return s;
}
/** Two chains: 2 strong reuses at `hit` min and 2 strong later misses at `zero` min; the second ends at `lastStart`. */
function eligible(env, ref, { hit = 12, zero = 50, lastStart = T0 - 10 * MIN, tag = "e" } = {}) {
	chain(env.sessionsDir, `${tag}1`, ref, { start: lastStart - 3000 * MIN, hit, zero });
	return chain(env.sessionsDir, `${tag}2`, ref, { start: lastStart - (2 + hit + zero) * MIN, hit, zero });
}
const importModels = (env, ...refs) => {
	const r = cli(env, ["import", "--sessions-dir", env.sessionsRoot, ...refs.flatMap((m) => ["--model", m])]);
	assert.equal(r.status, 0, r.stderr);
	return r.data.summary;
};
const evidenceOf = (env, ref) => cli(env, ["learn", "--model", ref]).data.evidence[0];
const profiles = (env) => cli(env, ["status"]).data.profiles;
const utcOff = (env) => assert.equal(cli(env, ["settings", "--time", "utc", "--cost", "off"]).status, 0);

test("the policy is a fixed, exported 2 + 2 rule over bounded counts; the pure decision fails closed and never clamps", () => {
	assert.deepEqual([AUTO_MIN_REUSE_PAIRS, AUTO_MIN_LATER_MISSES], [2, 2]);
	assert.deepEqual(AUTO_POLICY, { minReusePairs: 2, minLaterMissesPerClock: 2, maxMinutes: 1440 });
	const clock = (hitObservedMs, firstLaterMissMs, reuses = 2, laterMisses = 2) => ({ hitObservedMs, reuses, laterMisses, firstLaterMissMs });
	const decide = (start, end = start) => autoDecision({ start, end });
	assert.deepEqual(decide(clock(12 * MIN, 50 * MIN), clock(11.5 * MIN, 49.5 * MIN)).profile, { hitUnderMs: 11.5 * MIN, expireOverMs: 50 * MIN, source: "auto" }, "hit = shorter clock's H, expired = later clock's first bounded miss");
	assert.deepEqual(decide(clock(0, 50 * MIN)).blockers, ["nonpositive_hit"]);
	assert.deepEqual(decide(clock(1500 * MIN, null, 2, 0)).blockers, ["later_misses:start", "later_misses:end", "beyond_limit"], "an unsupported H is never ignored");
	assert.deepEqual(decide(clock(12 * MIN, 50 * MIN), clock(11.5 * MIN, 49.5 * MIN, 2, 1)).blockers, ["later_misses:end"], "each clock needs its own 2 later misses");
	assert.deepEqual(decide(clock(12 * MIN, 50 * MIN, 1)).blockers, ["reuse_pairs"]);

	// Malformed or impossible input: pending, never a profile, never Infinity, never a throw.
	const invalid = [
		undefined,
		null,
		{},
		{ start: clock(12 * MIN, 50 * MIN) },
		{ clocks: { start: clock(12 * MIN, 50 * MIN), end: clock(12 * MIN, 50 * MIN) } },
		...[Number.NaN, undefined, null, -1, 1.5, "2", Infinity].flatMap((n) => [
			{ start: { ...clock(12 * MIN, 50 * MIN), reuses: n }, end: clock(12 * MIN, 50 * MIN) },
			{ start: clock(12 * MIN, 50 * MIN), end: { ...clock(12 * MIN, 50 * MIN), laterMisses: n } },
		]),
		{ start: { ...clock(12 * MIN, 50 * MIN), hitObservedMs: "12" }, end: clock(12 * MIN, 50 * MIN) },
	];
	for (const input of invalid) {
		const d = autoDecision(input);
		assert.deepEqual([d.status, d.profile, d.blockers], ["pending", null, ["invalid_evidence"]], JSON.stringify(input) ?? String(input));
	}
	const impossible = [
		[clock(null, null), "counts without any H"],
		[clock(12 * MIN, null), "counts without a first later miss"],
		[clock(12 * MIN, 10 * MIN), "a reversed range"],
		[clock(12 * MIN, 12 * MIN), "a miss not strictly beyond H"],
		[clock(12 * MIN, 1441 * MIN), "a first miss beyond the limit"],
		[clock(12 * MIN, Infinity), "a non-finite first miss"],
		[clock(12 * MIN, -5 * MIN), "a negative first miss"],
		[clock(Infinity, null, 2, 0), "a non-finite H"],
		[clock(-MIN, 50 * MIN), "a negative H"],
	];
	for (const [c, why] of impossible) {
		const d = decide(c);
		assert.equal(d.profile, null, why);
		assert.equal(d.status, "pending", why);
		assert.ok(d.blockers.length > 0, why);
	}
});

test("no database: no footer and nothing created; a database with no evidence shows real learning state, not a quota", async (t) => {
	const env = tmpEnv(t);
	const h = loadExtension(t, env, { model: ASTRA });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.status(), undefined, "automatic profiles never create a database or a footer");
	await h.respond(ASTRA);
	assert.ok(!fs.existsSync(env.root));

	utcOff(env);
	const g = loadExtension(t, env, { model: ASTRA });
	await g.emit("session_start", { reason: "startup" });
	assert.equal(g.status(), "uncertain · learning: no pairs yet · recording off · /cache");
	assert.deepEqual(profiles(env), [], "no profile is created");
});

test("counters count specific pair types, not responses, and show which clock lags", async (t) => {
	const env = tmpEnv(t);
	utcOff(env);
	const many = new SessionFile({ tag: "many" });
	many.turn({ start: T0 - 100 * MIN, u: cold(), ...ASTRA });
	for (let i = 0; i < 40; i++) many.turn({ gap: MIN, u: pos(), ...ASTRA });
	many.write(env.sessionsDir);
	importModels(env, ASTRA_REF);
	const h = loadExtension(t, env, { branch: many.branch(), model: ASTRA });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.status(), "uncertain · learning: reuses 2/2, later misses 0/2 · recording off · /cache", "41 responses with short gaps never locate expiry");
	await h.command("status");
	assert.match(h.lastNote(), /this model has reuses 39 \(need 2\), later misses start 0 \(need 2\), end 0 \(need 2\)/, "status shows the full counts");

	// Start clock: two later misses beyond H; end clock: one, because the second miss follows a 10-minute response.
	const lag = tmpEnv(t);
	utcOff(lag);
	const s = new SessionFile({ tag: "lag" });
	s.turn({ start: T0 - 300 * MIN, u: cold(), ...ASTRA });
	s.turn({ gap: 2 * MIN, u: pos(), ...ASTRA });
	s.turn({ gap: 20 * MIN, u: pos(), ...ASTRA });
	s.turn({ gap: 25 * MIN, u: cold(), ...ASTRA });
	s.turn({ gap: 2 * MIN, u: pos(), ...ASTRA });
	s.turn({ gap: 2 * MIN, dur: 10 * MIN, u: pos(), ...ASTRA });
	s.turn({ gap: 25 * MIN, u: cold(), ...ASTRA });
	s.write(lag.sessionsDir);
	importModels(lag, ASTRA_REF);
	const e = evidenceOf(lag, ASTRA_REF);
	assert.deepEqual(e.automatic.requirements, { reusePairs: { have: 2, need: 2 }, laterMisses: { start: { have: 2, need: 2 }, end: { have: 1, need: 2 } } });
	const l = loadExtension(t, lag, { branch: s.branch(), model: ASTRA });
	await l.emit("session_start", { reason: "startup" });
	assert.equal(l.status(), "uncertain · learning: reuses 2/2, later misses start 2/2, end 1/2 · recording off · /cache");
});

test("once eligible, the automatic profile forecasts hit, the full uncertain band, and expired, tagged provisional and never stored", async (t) => {
	const env = tmpEnv(t);
	utcOff(env);
	const last = eligible(env, ASTRA);
	importModels(env, ASTRA_REF);
	const hash = sha(env.dbPath);
	const e = evidenceOf(env, ASTRA_REF);
	assert.deepEqual([e.effective, e.profile, e.effectiveProfile], ["auto", null, { hitUnderMs: 11.5 * MIN, expireOverMs: 50 * MIN, source: "auto" }]);
	const status = cli(env, ["status"]).data;
	assert.deepEqual([status.profiles, status.settings.auto, status.autoPolicy], [[], "on", AUTO_POLICY], "stored profiles stay manual-only");
	assert.deepEqual(status.effectiveProfiles, [{ provider: ASTRA.provider, model: ASTRA.model, kind: "auto", hitUnderMs: 11.5 * MIN, expireOverMs: 50 * MIN, source: "auto" }]);
	assert.match(cli(env, ["status"], { json: false }).stdout, /Automatic profiles in use:\n {2}github-copilot\/gpt-6-astra: hit < 11\.5 min, expired > 50\.0 min \(automatic, provisional; not stored\)/);

	const h = loadExtension(t, env, { branch: last.branch(), model: ASTRA, theme: recorder });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.status(), "<dim:cache hit · until 12:01 UTC · auto (provisional)>");
	h.at(T0 + 5 * MIN);
	assert.equal(await h.tick(), "<dim:uncertain · expired after 12:41 UTC · auto (provisional) 11.5–50.0 min>", "the whole observed band stays uncertain");
	h.at(T0 + 41 * MIN);
	assert.equal(await h.tick(), "<warning:cache expired><dim: · auto (provisional)>", "only the expired label uses the warning colour");
	await h.command("status");
	const text = h.lastNote();
	assert.match(text, /Active profile \(automatic, provisional; derived from stored evidence, never stored\): cache hit while both clocks are under 11\.5 min; cache expired once both are over 50\.0 min/);
	assert.match(text, /Forecast for the next request: cache expired \(automatic, provisional\)\./);
	assert.match(text, /Observed candidate \(in use as the automatic profile\)/);
	assert.match(text, /Automatic profile in use \(provisional;[^\n]*band 38\.5 min\)\. It meets the eligibility rule \(reuses 2 \(need 2\), later misses start 2 \(need 2\), end 2 \(need 2\)\)[^\n]*That is an engineering rule, not a confidence level, a count of independent trials, or a confirmed cache lifetime/);
	assert.doesNotMatch(text, /%|\bETA\b|ready|unlock/);
	await h.command("learn");
	assert.match(h.lastNote(), /Active profile: 11\.5 min \/ 50\.0 min \(automatic, provisional\)\./);
	assert.match(h.lastNote(), /Contradictory zeros \(zero reads at or below the longest reuse\) do not block it/);
	await h.emit("session_shutdown", { reason: "quit" });

	const again = loadExtension(t, env, { branch: last.branch(), model: ASTRA });
	await again.emit("session_start", { reason: "resume" });
	assert.equal(again.status(), "cache hit · until 12:01 UTC · auto (provisional)", "derived again after a restart from the same metadata");
	assert.deepEqual(profiles(env), []);
	assert.equal(sha(env.dbPath), hash, "footer, status, learn, and restart wrote nothing");
	assert.ok(!JSON.stringify([h.notes, h.statuses]).includes(SENTINEL));
});

test("a wide band activates as-is, with the cost suffix kept, and is uncertain across its width", async (t) => {
	const env = tmpEnv(t);
	assert.equal(cli(env, ["settings", "--time", "utc", "--cost", "usd"]).status, 0);
	const last = eligible(env, ASTRA, { hit: 28, zero: 540 });
	importModels(env, ASTRA_REF);
	const h = loadExtension(t, env, { branch: last.branch(), model: { ...ASTRA, cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 } } });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.status(), "cache hit · until 12:17 UTC · auto (provisional) · miss ≈$0.041");
	h.at(T0 + 120 * MIN);
	assert.equal(await h.tick(), "uncertain · expired after 20:51 UTC · auto (provisional) 27.5–540.0 min · miss ≈$0.041", "two hours later: still inside the observed band, not expired");
});

test("a seed always wins (including the Opus alias) and is never changed; providers never share", async (t) => {
	const env = tmpEnv(t);
	utcOff(env);
	const opus = { provider: "github-copilot", model: "claude-opus-5-5" };
	const last = eligible(env, opus);
	importModels(env, "github-copilot/claude-opus-5-5");
	const h = loadExtension(t, env, { branch: last.branch(), model: opus });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.status(), "cache hit · until 12:01 UTC · auto (provisional)");
	assert.equal(cli(env, ["seed", "github-copilot/claude-opus-5.5", "20", "30"]).status, 0);
	const seeded = profiles(env);
	h.advance(MIN);
	assert.equal(await h.tick(), "cache hit · until 12:10 UTC", "the alias seed replaces the automatic profile; the footer is the exact manual format");
	await h.command("status");
	assert.match(h.lastNote(), /Active profile \(seed\): cache hit while both clocks are under 20\.0 min/);
	assert.match(h.lastNote(), /Automatic profiles never replace a seed\./);
	for (let i = 0; i < 3; i++) {
		h.advance(MIN);
		await h.tick();
	}
	assert.deepEqual(profiles(env), seeded, "the stored seed is never touched by derivation");
	assert.equal(evidenceOf(env, "github-copilot/claude-opus-5-5").effective, "manual");

	const other = loadExtension(t, env, { branch: last.branch(), model: { provider: "anthropic", model: "claude-opus-5.5" } });
	await other.emit("session_start", { reason: "startup" });
	assert.equal(other.status(), "uncertain · learning: no pairs yet · recording off · /cache", "another provider never uses this evidence or seed");
});

test("the automatic choice is a saved setting: TUI, CLI, and menu can turn it off; other modes cannot write", async (t) => {
	const env = tmpEnv(t);
	utcOff(env);
	const last = eligible(env, ASTRA);
	importModels(env, ASTRA_REF);
	for (const mode of ["print", "json", "rpc"]) {
		const r = loadExtension(t, env, { mode, branch: last.branch(), model: ASTRA });
		await r.emit("session_start", { reason: "startup" });
		await r.command("settings auto off");
		if (r.notes.length) assert.match(r.lastNote(), /only available in the interactive TUI; nothing changed/);
	}
	assert.equal(cli(env, ["settings"]).data.settings.auto, "on", "non-TUI modes changed nothing");

	const h = loadExtension(t, env, { branch: last.branch(), model: ASTRA });
	await h.emit("session_start", { reason: "startup" });
	await h.command("settings auto off");
	assert.match(h.lastNote(), /Settings saved: time utc, cost off, automatic profiles off\./);
	assert.equal(h.status(), "uncertain · no seeded profile for this model", "off restores the manual-only footer at once");
	await h.command("settings auto maybe");
	assert.match(h.lastNote(), /^Usage: \/cache settings \[time local\|utc\] \[cost off\|usd\|credits\|both\] \[auto on\|off\]; nothing changed\./);
	h.script({ select: ["Display settings", /^Automatic profiles: off/, "On", "Back", "Close"] });
	await h.command("");
	assert.equal(h.selects[2].title, "Automatic, provisional profiles for models without a seed (derived from stored evidence; a seed always wins)");
	assert.equal(cli(env, ["settings"]).data.settings.auto, "on");
	assert.equal(h.status(), "cache hit · until 12:01 UTC · auto (provisional)");
	assert.equal(cli(env, ["settings", "--auto", "off"]).status, 0);
	h.advance(MIN);
	assert.equal(await h.tick(), "uncertain · no seeded profile for this model", "a CLI change from another process applies at the next refresh");
	assert.equal(cli(env, ["learn", "--model", ASTRA_REF]).data.evidence[0].effective, "off");
});

test("recording off still uses stored evidence; new live responses add nothing until recording or an import", async (t) => {
	const env = tmpEnv(t);
	utcOff(env);
	const last = eligible(env, ASTRA);
	importModels(env, ASTRA_REF);
	const h = loadExtension(t, env, { branch: last.branch(), model: ASTRA });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.status(), "cache hit · until 12:01 UTC · auto (provisional)", "no recording-off marker once eligible");
	const before = evidenceOf(env, ASTRA_REF).responses.total;
	h.advance(MIN);
	await h.respond(ASTRA);
	assert.match(h.status(), /^cache hit · until 12:12 UTC · auto \(provisional\)$/, "a live response is the next anchor under the same derived profile");
	assert.equal(evidenceOf(env, ASTRA_REF).responses.total, before, "recording off adds no evidence");
});

test("a later, longer hit withdraws the automatic profile instead of keeping a stale expiry", async (t) => {
	const env = tmpEnv(t);
	utcOff(env);
	const last = eligible(env, ASTRA);
	importModels(env, ASTRA_REF);
	const h = loadExtension(t, env, { branch: last.branch(), model: ASTRA });
	await h.emit("session_start", { reason: "startup" });
	assert.match(h.status(), /auto \(provisional\)$/);
	chain(env.sessionsDir, "longer", ASTRA, { start: T0 - 6000 * MIN, hit: 60, zero: null });
	importModels(env, ASTRA_REF);
	h.advance(MIN);
	assert.equal(await h.tick(), "uncertain · learning: reuses 2/2, later misses 0/2 · recording off · /cache", "H grew past both misses, which now count as contradictory");
	const e = evidenceOf(env, ASTRA_REF);
	assert.deepEqual([e.effective, e.clocks.start.hitObservedMs, e.clocks.start.contradictoryZeros], ["pending", 60 * MIN, 2]);
});

test("a same-connection merge that excludes a pair (no new row) invalidates the cached evidence at once", async (t) => {
	const env = tmpEnv(t);
	utcOff(env);
	const lastStart = T0 - 10 * MIN;
	eligible(env, ASTRA, { lastStart });
	importModels(env, ASTRA_REF);
	const h = loadExtension(t, env, { model: ASTRA });
	await h.emit("session_start", { reason: "startup" });
	await h.command("on");
	assert.equal(h.status(), "uncertain · no usable previous response yet · auto (provisional)");
	const pairsBefore = cli(env, ["status"]).data.counts.pairs;
	// Replay the second chain's reuse pair live, with a compaction in between: the merged pair becomes excluded.
	const s2 = lastStart - 64 * MIN;
	h.at(s2 + 2 * MIN);
	await h.respond(ASTRA);
	await h.emit("session_compact", {});
	h.at(s2 + 14 * MIN);
	await h.respond(ASTRA);
	assert.equal(cli(env, ["status"]).data.counts.pairs, pairsBefore, "the live pair merged into the imported one: no new row");
	assert.equal(h.status(), "uncertain · learning: reuses 1/2, later misses 2/2 · /cache", "the exclusion from either source wins, and the footer follows without a restart");
	const e = evidenceOf(env, ASTRA_REF);
	assert.deepEqual([e.excluded, e.origins.both], [{ boundary: 1 }, 1]);
});

test("unchanged refreshes reuse the cached evidence; an external commit makes the next refresh recompute once", async (t) => {
	const env = tmpEnv(t);
	utcOff(env);
	const first = chain(env.sessionsDir, "one", ASTRA, { start: T0 - 3000 * MIN });
	importModels(env, ASTRA_REF);
	const h = loadExtension(t, env, { branch: first.branch(), model: ASTRA });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.status(), "uncertain · learning: reuses 1/2, later misses 1/2 · recording off · /cache");
	const db = h.insights.db;
	let scans = 0;
	for (const name of ["pairs", "responseStats"]) {
		const original = db[name].bind(db);
		db[name] = (...args) => (scans++, original(...args));
	}
	for (let i = 0; i < 5; i++) {
		h.advance(MIN);
		await h.tick();
		await h.emit("agent_settled", {});
	}
	assert.equal(scans, 0, "ten unchanged refreshes never rescan stored metadata");
	chain(env.sessionsDir, "two", ASTRA, { start: T0 - 200 * MIN });
	importModels(env, ASTRA_REF);
	h.advance(MIN);
	assert.match(await h.tick(), /auto \(provisional\)/, "another process's import is seen at the next refresh");
	assert.equal(scans, 2, "one recompute: one pair scan and one response aggregate");
	for (let i = 0; i < 3; i++) {
		h.advance(MIN);
		await h.tick();
	}
	assert.equal(scans, 2);
});

test("the seed wizard describes automatic values but never copies them: Enter on an empty entry cancels", async (t) => {
	const env = tmpEnv(t);
	utcOff(env);
	eligible(env, ASTRA);
	importModels(env, ASTRA_REF);
	const hash = sha(env.dbPath);
	const h = loadExtension(t, env, { model: ASTRA });
	h.script({ select: ["Seed or edit a model profile", /^Current model: github-copilot\/gpt-6-astra \(no profile; automatic, provisional: hit < 11\.5 min, expired > 50 min\)$/, "Close"], input: [""] });
	await h.command("");
	assert.match(h.inputs[0].title, /in minutes \(for example 25; automatic now: hit < 11\.5, expired > 50, not copied; Esc cancels\)$/);
	assert.equal(h.notes.at(-1)[1], "Cancelled; nothing changed.");
	assert.deepEqual(profiles(env), []);
	assert.equal(sha(env.dbPath), hash);
});

test("later misses beyond the 24-hour limit are shown but never counted; a reuse gap beyond it means no automatic profile", async (t) => {
	const env = tmpEnv(t);
	utcOff(env);
	const last = eligible(env, ASTRA, { zero: 1500 });
	importModels(env, ASTRA_REF);
	const e = evidenceOf(env, ASTRA_REF);
	assert.deepEqual([e.effective, e.automatic.blockers], ["pending", ["later_misses:start", "later_misses:end"]]);
	assert.deepEqual([e.clocks.start.longZeros, e.clocks.start.expiryObservedMs, e.eligibility.start.laterMisses], [2, 1500 * MIN, 0], "raw envelope unchanged; the bounded count leaves both out");
	const h = loadExtension(t, env, { branch: last.branch(), model: ASTRA });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.status(), "uncertain · learning: reuses 2/2, later misses 0/2 · recording off · /cache");
	await h.command("status");
	assert.match(h.lastNote(), /Not counted: 2 later zero read\(s\) on the start clock beyond the 1440-minute limit or with unusable timing; 2 later zero read\(s\) on the end clock[^\n]*never clamped\)\./);

	const far = tmpEnv(t);
	utcOff(far);
	const reuse = eligible(far, ASTRA, { hit: 1500, zero: 1600 });
	importModels(far, ASTRA_REF);
	assert.ok(evidenceOf(far, ASTRA_REF).automatic.blockers.includes("beyond_limit"));
	const g = loadExtension(t, far, { branch: reuse.branch(), model: ASTRA });
	await g.emit("session_start", { reason: "startup" });
	assert.equal(g.status(), "uncertain · no automatic profile: range over 24 h · /cache", "no promise that waiting helps: H never shrinks");
	await g.command("status");
	assert.match(g.lastNote(), /No automatic profile for this model: its longest reuse gap is beyond the 1440-minute profile limit, and that gap never shrinks, so more data cannot make it eligible \(values are never clamped\)\./);
	assert.match(g.lastNote(), /A manual seed of your own minutes needs no data and always wins: \/cache seed github-copilot\/gpt-6-astra <hitMinutes> <expireMinutes>/);
});

test("one bounded later miss plus one beyond 24 h stays pending; a second miss within the limit activates", async (t) => {
	const env = tmpEnv(t);
	utcOff(env);
	chain(env.sessionsDir, "near", ASTRA, { start: T0 - 9000 * MIN, hit: 12, zero: 50 });
	chain(env.sessionsDir, "far", ASTRA, { start: T0 - 6000 * MIN, hit: 12, zero: 30 * 60 });
	importModels(env, ASTRA_REF);
	const e = evidenceOf(env, ASTRA_REF);
	assert.deepEqual([e.clocks.start.longZeros, e.clocks.end.longZeros], [2, 2], "the raw envelope still reports both zeros");
	assert.deepEqual(e.automatic.requirements.laterMisses, { start: { have: 1, need: 2 }, end: { have: 1, need: 2 } });
	assert.equal(e.effective, "pending", "the 30-hour miss does not count");
	const last = chain(env.sessionsDir, "within", ASTRA, { start: T0 - 84 * MIN, hit: 12, zero: 60 });
	const h = loadExtension(t, env, { branch: last.branch(), model: ASTRA });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.status(), "uncertain · learning: reuses 2/2, later misses 1/2 · recording off · /cache");
	importModels(env, ASTRA_REF);
	h.advance(MIN);
	assert.equal(await h.tick(), "cache hit · until 12:01 UTC · auto (provisional)", "a second later miss within the limit activates it");
	const after = evidenceOf(env, ASTRA_REF);
	assert.deepEqual([after.effectiveProfile.hitUnderMs, after.effectiveProfile.expireOverMs, after.eligibility.start.laterMisses, after.clocks.start.longZeros], [11.5 * MIN, 50 * MIN, 2, 3]);
	assert.deepEqual(profiles(env), []);
});

test("an imported zero read with an out-of-range start and no saved end never counts as a later miss", async (t) => {
	const env = tmpEnv(t);
	utcOff(env);
	chain(env.sessionsDir, "a", ASTRA, { start: T0 - 9000 * MIN });
	const s = new SessionFile({ tag: "bad" });
	s.turn({ start: T0 - 5000 * MIN, u: cold(), ...ASTRA });
	s.turn({ gap: 2 * MIN, u: pos(), ...ASTRA });
	s.turn({ gap: 12 * MIN, u: pos(), ...ASTRA });
	s.add({ type: "message", message: { role: "assistant", provider: ASTRA.provider, model: ASTRA.model, usage: cold(), stopReason: "stop", content: [{ type: "text", text: SENTINEL }], timestamp: 1e20 } });
	s.write(env.sessionsDir);
	importModels(env, ASTRA_REF);
	const e = evidenceOf(env, ASTRA_REF);
	assert.deepEqual([e.clocks.start.longZeros, e.clocks.end.longZeros], [2, 2], "the learner's raw envelope (unchanged) counts the impossible zero");
	assert.deepEqual([e.eligibility.start.laterMisses, e.eligibility.end.laterMisses, e.effective], [1, 1, "pending"], "the bounded count does not, so nothing activates");
	const h = loadExtension(t, env, { model: ASTRA });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.status(), "uncertain · learning: reuses 2/2, later misses 1/2 · recording off · /cache");
	assert.ok(!h.statuses.some(([, text]) => /auto \(provisional\)/.test(text ?? "")));
});

test("an unusable database never shows invented progress", async (t) => {
	const env = tmpEnv(t);
	fs.mkdirSync(env.root, { recursive: true, mode: 0o700 });
	const old = new DatabaseSync(env.dbPath);
	old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; CREATE TABLE events (seq INTEGER PRIMARY KEY, id TEXT, observed_at REAL, kind TEXT, payload BLOB) STRICT; PRAGMA user_version = 1");
	old.close();
	fs.chmodSync(env.dbPath, 0o600);
	const hash = sha(env.dbPath);
	const h = loadExtension(t, env, { model: ASTRA });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.status(), "cache: upgrade needed");
	h.advance(MIN);
	assert.equal(await h.tick(), "cache: upgrade needed");
	assert.equal(sha(env.dbPath), hash);

	const ok = tmpEnv(t);
	utcOff(ok);
	const broken = loadExtension(t, ok, { model: ASTRA, loadSqlite: async () => { throw new Error("no sqlite"); } });
	await broken.emit("session_start", { reason: "startup" });
	assert.equal(broken.status(), "cache: error");
	assert.ok(!broken.statuses.some(([, text]) => /learning/.test(text ?? "")));
});

/** Runs the registered extension in a child process with a fixed TZ and returns its last themed footer. */
function footerUnderTZ(env, branch, tz) {
	const file = path.join(env.dir, `branch-${tz.replace(/\W/g, "_")}.json`);
	fs.writeFileSync(file, JSON.stringify(branch));
	const code = `
		const { registerCacheInsights } = await import(process.env.CI_LIB);
		const handlers = new Map(), statuses = [];
		const pi = { on: (e, fn) => handlers.set(e, fn), registerCommand: () => {}, getThinkingLevel: () => "high" };
		const noop = () => ({ unref() {} });
		registerCacheInsights(pi, { root: process.env.CI_ROOT, clock: { wall: () => Number(process.env.CI_T0), mono: () => 1000 }, timers: { setInterval: noop, clearInterval() {}, setTimeout: noop, clearTimeout() {} }, resolveBaseline: () => ({ status: "unchanged" }) });
		const branch = JSON.parse((await import("node:fs")).readFileSync(process.env.CI_BRANCH, "utf8"));
		const ctx = { mode: "tui", hasUI: true, cwd: process.env.CI_CWD, model: { provider: "github-copilot", id: "gpt-6-astra" }, ui: { setStatus: (k, t) => statuses.push(t), notify() {}, theme: { fg: (tok, text) => "<" + tok + ":" + text + ">" } }, sessionManager: { getBranch: () => branch } };
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		console.log(JSON.stringify(statuses.filter((s) => s !== undefined).at(-1)));`;
	const childEnv = { ...process.env, TZ: tz, CI_LIB: path.join(REPO, "lib", "cache-insights", "index.mjs"), CI_ROOT: env.root, CI_T0: String(T0), CI_BRANCH: file, CI_CWD: env.workspace };
	const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: env.workspace, env: childEnv, encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

test("automatic and learning footers keep each deadline's own local offset and the dim/warning styling", (t) => {
	const env = tmpEnv(t);
	assert.equal(cli(env, ["settings", "--cost", "off"]).status, 0);
	const last = eligible(env, ASTRA);
	importModels(env, ASTRA_REF);
	assert.equal(footerUnderTZ(env, last.branch(), "Asia/Kolkata"), "<dim:cache hit · until 17:31 UTC+5:30 · auto (provisional)>");
	assert.equal(footerUnderTZ(env, last.branch(), "America/New_York"), "<dim:cache hit · until 08:01 UTC-4 · auto (provisional)>");
	assert.equal(footerUnderTZ(env, last.branch(), "UTC"), "<dim:cache hit · until 12:01 UTC · auto (provisional)>");
	const fresh = tmpEnv(t);
	assert.equal(cli(fresh, ["settings", "--cost", "off"]).status, 0);
	assert.equal(footerUnderTZ(fresh, [], "Asia/Tokyo"), "<dim:uncertain · learning: no pairs yet · recording off · /cache>", "learning counters stay dim");
});
