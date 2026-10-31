// Evidence guidance end to end: synthetic history → CLI import/seed → CLI learn, /cache status, /cache learn, and the
// menu's learning view. Counts describe what is stored; they never change a profile or a forecast.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { cli, loadExtension, MIN, SENTINEL, SessionFile, SOL, T0, tmpEnv, usage } from "./harness.mjs";

const ASTRA = { provider: "github-copilot", model: "gpt-6-astra" };
const ASTRA_REF = "github-copilot/gpt-6-astra";
const SOL_REF = "github-copilot/gpt-6.1-sol";
const pos = () => usage(200, 10_000, 0);
const cold = () => usage(10_200, 0, 10_000);
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** A cold start, a hit 2 min later, a hit `hit` min later, then (unless null) a zero read `zero` min later. */
function chain(dir, tag, ref, { start = T0 - 1000 * MIN, hit = 12, zero = 50, dur = 30_000 } = {}) {
	const s = new SessionFile({ tag });
	s.turn({ start, u: cold(), dur, ...ref });
	s.turn({ gap: 2 * MIN, u: pos(), dur, ...ref });
	s.turn({ gap: hit * MIN, u: pos(), dur, ...ref });
	if (zero !== null) s.turn({ gap: zero * MIN, u: cold(), dur, ...ref });
	s.write(dir);
	return s;
}
const importModels = (env, ...refs) => {
	const r = cli(env, ["import", "--sessions-dir", env.sessionsRoot, ...refs.flatMap((m) => ["--model", m])]);
	assert.equal(r.status, 0, r.stderr);
	return r.data.summary;
};
const learn = (env, ref) => {
	const r = cli(env, ["learn", ...(ref ? ["--model", ref] : [])]);
	assert.equal(r.status, 0, r.stderr);
	return r.data;
};
const evidenceOf = (env, ref) => {
	const { evidence } = learn(env, ref);
	assert.equal(evidence.length, 1, `exactly the requested model: ${ref}`);
	return evidence[0];
};
const learnTextOf = (env, ref, extraEnv) => cli(env, ["learn", ...(ref ? ["--model", ref] : [])], { json: false, extraEnv }).stdout;

/** No progress, readiness, unlock, schedule, or validation claims; the only percent sign is the existing disclaimer. */
function assertHonest(text) {
	assert.doesNotMatch(text, /\bready\b|unlock|\bETA\b|remaining|progress|validated|\b\d+\s*\/\s*\d+\s+(?:pairs|responses|samples)\b/i);
	assert.equal((text.match(/%/g) ?? []).length, (text.match(/not a 95% guarantee/g) ?? []).length, "no percentages besides the disclaimer");
	assert.ok(!text.includes(SENTINEL), "no content, ids, or paths from the session files");
}

test("no database, no pairs, or responses only: nothing is invented or created, and counts cover every stored response", async (t) => {
	const env = tmpEnv(t);
	assert.deepEqual(learn(env), { setUp: false });
	const h = loadExtension(t, env, { model: ASTRA });
	await h.emit("session_start", { reason: "startup" });
	await h.command("learn");
	assert.equal(h.lastNote(), "No cache-insights database yet.");
	await h.command("status");
	assert.match(h.lastNote(), /Not set up: no database yet/);
	assert.doesNotMatch(h.lastNote(), /Evidence|responses/);
	assert.ok(!fs.existsSync(env.root), "read-only views create nothing");

	const broken = loadExtension(t, env, { loadSqlite: async () => { throw new Error("no sqlite"); } });
	await broken.emit("session_start", { reason: "startup" });
	await broken.command("seed github-copilot/gpt-6.1-sol 25 30");
	await broken.command("status");
	assert.doesNotMatch(broken.lastNote(), /Evidence|responses|Active profile/, "an unusable store shows no counts or profile");

	assert.equal(cli(env, ["seed", SOL_REF, "25", "30"]).status, 0);
	const none = evidenceOf(env, ASTRA_REF);
	assert.deepEqual(
		{ ...none, clocks: undefined },
		{
			provider: ASTRA.provider, model: ASTRA.model, models: [],
			responses: { total: 0, historical: 0, live: 0, missingStart: 0, cacheReadPositive: 0, cacheReadUnknown: 0, endFallback: 0, timeUnknown: 0, firstMs: null, firstSource: null, lastMs: null, lastSource: null },
			pairs: 0, qualified: 0, strong: 0, weak: 0, excluded: {}, origins: { historical: 0, live: 0, both: 0 },
			clocks: undefined, missing: ["no_pairs"], stage: "none", profile: null,
			eligibility: {
				maxGapMs: 1440 * MIN,
				start: { hitObservedMs: null, reuses: 0, laterMisses: 0, firstLaterMissMs: null },
				end: { hitObservedMs: null, reuses: 0, laterMisses: 0, firstLaterMissMs: null },
			},
			automatic: {
				status: "pending",
				requirements: { reusePairs: { have: 0, need: 2 }, laterMisses: { start: { have: 0, need: 2 }, end: { have: 0, need: 2 } } },
				blockers: ["reuse_pairs", "later_misses:start", "later_misses:end"],
				profile: null,
			},
			auto: "on", effective: "pending", effectiveProfile: null,
		},
		"a requested model with no data is still described",
	);
	assert.deepEqual(none.clocks.start, { hitObservedMs: null, expiryObservedMs: null, positives: 0, zeros: 0, contradictoryZeros: 0, longZeros: 0, bandMs: null });
	const text = learnTextOf(env, ASTRA_REF);
	assert.match(text, /github-copilot\/gpt-6-astra: 0 pairs .*\n {2}0 responses \(0 historical, 0 live\); 0 strong of 0 pairs\./);
	assert.match(text, /evidence: No candidate numbers yet\. Missing: no pairs yet \(a pair needs two successive successful responses/);
	assert.match(text, /Recording is off: stored evidence is still used, but counts change only through an explicit import\. A bare \/cache import covers seeded models only/);
	assertHonest(text);
	assert.deepEqual(learn(env).evidence.map((e) => [e.model, e.profile?.hitUnderMs ?? null, e.missing]), [[SOL.model, 25 * MIN, ["no_pairs"]]], "the all-model view includes a profile-only model");

	// 520 successive hits one minute apart (more than any history window), and a model with a single response.
	const many = new SessionFile({ tag: "many" });
	const first = T0 - 2000 * MIN;
	many.turn({ start: first, u: pos() });
	for (let i = 1; i < 520; i++) many.turn({ gap: MIN, u: pos() });
	many.write(env.sessionsDir);
	const solo = new SessionFile({ tag: "solo" });
	solo.turn({ start: T0 - 3000 * MIN, ...ASTRA });
	solo.write(env.sessionsDir);
	importModels(env, SOL_REF, ASTRA_REF);
	const sol = evidenceOf(env, SOL_REF);
	assert.deepEqual(sol.responses, { total: 520, historical: 520, live: 0, missingStart: 0, cacheReadPositive: 520, cacheReadUnknown: 0, endFallback: 0, timeUnknown: 0, firstMs: first, firstSource: "request_start", lastMs: first + 519 * MIN, lastSource: "request_start" });
	assert.deepEqual([sol.pairs, sol.strong, sol.missing, sol.stage], [519, 519, ["no_long_zero:start", "no_long_zero:end"], "partial"], "many short gaps never locate expiry");
	const only = evidenceOf(env, ASTRA_REF);
	assert.deepEqual([only.responses.total, only.pairs, only.missing], [1, 0, ["no_pairs"]], "responses without pairs are counted");
});

test("weak-only, excluded-only, positive-only, and zero-without-a-hit each name what is missing", (t) => {
	const env = tmpEnv(t);
	const m = (name) => ({ provider: "github-copilot", model: name });
	const weak = new SessionFile({ tag: "weak" });
	for (const [i, gap] of [0, 2, 3].entries()) weak.turn(i ? { gap: gap * MIN, u: cold(), ...m("weak-m") } : { start: T0 - 900 * MIN, u: cold(), ...m("weak-m") });
	weak.write(env.sessionsDir);
	const excl = new SessionFile({ tag: "excl" });
	excl.turn({ start: T0 - 800 * MIN, ...m("excl-m") });
	excl.compaction(excl.lastStart + MIN);
	excl.turn({ gap: 2 * MIN, ...m("excl-m") });
	excl.warm(excl.lastStart + MIN);
	excl.turn({ gap: 2 * MIN, ...m("excl-m") });
	excl.write(env.sessionsDir);
	chain(env.sessionsDir, "posonly", m("pos-m"), { hit: 5, zero: null });
	const zero = new SessionFile({ tag: "zero" });
	zero.turn({ start: T0 - 700 * MIN, u: pos(), ...m("zero-m") });
	zero.turn({ gap: 40 * MIN, u: cold(), ...m("zero-m") });
	zero.write(env.sessionsDir);
	importModels(env, ...["weak-m", "excl-m", "pos-m", "zero-m"].map((x) => `github-copilot/${x}`));

	const by = Object.fromEntries(learn(env).evidence.map((e) => [e.model, e]));
	assert.deepEqual(Object.keys(by), ["excl-m", "pos-m", "weak-m", "zero-m"]);
	assert.deepEqual([by["weak-m"].missing, by["weak-m"].stage, by["weak-m"].weak], [["no_strong"], "none", 2]);
	assert.deepEqual([by["excl-m"].missing, by["excl-m"].excluded], [["no_qualified"], { boundary: 1, warm_between: 1 }]);
	assert.deepEqual([by["pos-m"].missing, by["pos-m"].stage, by["pos-m"].clocks.start.hitObservedMs, by["pos-m"].clocks.start.expiryObservedMs], [["no_long_zero:start", "no_long_zero:end"], "partial", 5 * MIN, null]);
	assert.deepEqual([by["zero-m"].missing, by["zero-m"].stage, by["zero-m"].clocks.start.zeros, by["zero-m"].clocks.start.hitObservedMs], [["no_positive"], "none", 1, null], "a zero without any hit is not an expiry");

	const text = learnTextOf(env);
	assert.match(text, /weak-m[\s\S]*?Missing: no strong pairs \(no qualified pair whose previous response reported a cache read above 0\)/);
	assert.match(text, /excl-m[\s\S]*?excluded: boundary=1, warm_between=1[\s\S]*?Missing: no qualified pairs/);
	assert.match(text, /pos-m[\s\S]*?Partial: start 5\.0 min hit, no longer zero yet; end 4\.5 min hit, no longer zero yet\. Missing: start clock has no strong zero-read gap longer than its longest hit \(5\.0 min\) yet; end clock has no strong zero-read gap longer than its longest hit \(4\.5 min\) yet\./);
	assert.match(text, /zero-m[\s\S]*?No candidate numbers yet\. Missing: no strong pair with a cache read yet/);
	assert.match(text, /"Strong" means the previous response reported a cache read above 0\. It is a pairing rule, not statistical strength or confidence\./);
	assert.match(text, /In theory two such pairs are enough: three successive responses if the first already reports a cache read, usually one more from a cold start\. That is when numbers can exist, not a reliable sample size\./);
	assert.match(text, /no number of responses shows where the cache expires\. Nothing here asks you to wait, probe, or warm the cache\./);
	assertHonest(text);
});

test("one clock bracketed: a long previous response can leave the end clock without a longer zero", (t) => {
	const env = tmpEnv(t);
	const s = new SessionFile({ tag: "oneclock" });
	s.turn({ start: T0 - 600 * MIN, u: cold(), ...ASTRA });
	s.turn({ gap: 2 * MIN, u: pos(), ...ASTRA });
	s.turn({ gap: 20 * MIN, dur: 10 * MIN, u: pos(), ...ASTRA });
	s.turn({ gap: 25 * MIN, u: cold(), ...ASTRA });
	s.write(env.sessionsDir);
	importModels(env, ASTRA_REF);
	const e = evidenceOf(env, ASTRA_REF);
	assert.deepEqual([e.missing, e.stage], [["no_long_zero:end"], "partial"]);
	assert.deepEqual(e.clocks.start, { hitObservedMs: 20 * MIN, expiryObservedMs: 25 * MIN, positives: 1, zeros: 1, contradictoryZeros: 0, longZeros: 1, bandMs: 5 * MIN });
	assert.deepEqual([e.clocks.end.hitObservedMs, e.clocks.end.expiryObservedMs, e.clocks.end.contradictoryZeros, e.clocks.end.bandMs], [19.5 * MIN, null, 1, null]);
	assert.match(learnTextOf(env, ASTRA_REF), /evidence: Partial: start 20\.0 min hit to 25\.0 min zero \(band 5\.0 min\); end 19\.5 min hit, no longer zero yet\. Missing: end clock has no strong zero-read gap longer than its longest hit \(19\.5 min\) yet\./);
});

test("both clocks bracketed but below the 2 + 2 rule: the footer shows real counters, nothing is stored, and the seed hint has no numbers", async (t) => {
	const env = tmpEnv(t);
	const astra = chain(env.sessionsDir, "astra", ASTRA);
	chain(env.sessionsDir, "sol", SOL, { start: T0 - 3000 * MIN });
	assert.equal(cli(env, ["seed", SOL_REF, "25", "30"]).status, 0);
	importModels(env);
	assert.equal(evidenceOf(env, ASTRA_REF).responses.total, 0, "a bare import covers seeded models only");
	importModels(env, ASTRA_REF);
	const e = evidenceOf(env, ASTRA_REF);
	assert.deepEqual([e.stage, e.missing, e.strong, e.weak, e.profile], ["both_clocks", [], 2, 1, null]);
	assert.deepEqual(["start", "end"].map((k) => [e.clocks[k].hitObservedMs, e.clocks[k].expiryObservedMs, e.clocks[k].bandMs]), [[12 * MIN, 50 * MIN, 38 * MIN], [11.5 * MIN, 49.5 * MIN, 38 * MIN]]);
	assert.deepEqual(cli(env, ["status"]).data.profiles.map((p) => p.model), [SOL.model], "no profile was created for the candidate");
	assert.equal(cli(env, ["settings", "--time", "utc"]).status, 0);

	assert.deepEqual([e.automatic.status, e.automatic.blockers, e.effective], ["pending", ["reuse_pairs", "later_misses:start", "later_misses:end"], "pending"], "one reuse and one later miss per clock are below the rule");

	const h = loadExtension(t, env, { branch: astra.branch(), model: ASTRA });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.status(), "uncertain · learning: reuses 1/2, later misses 1/2 · recording off · /cache");
	await h.command("status");
	const status = h.lastNote();
	assert.match(status, /Active profile: none for this model \(other models' seeds are never reused\)\. Automatic profiles are on; this model is still learning/);
	assert.match(status, /Observed candidate \(not active\): 2 strong pairs; start clock hit ≤12\.0 min, first later zero 50\.0 min/);
	assert.match(status, /Evidence for this model \(observations; with automatic profiles on they can derive a provisional profile, never a stored one; \/cache learn explains how to read them\): 4 responses \(4 historical, 0 live\), first 2026-10-28T19:20:00Z, latest 2026-10-28T20:24:00Z; 2 reported a positive cache read; 2 strong of 3 pairs\./);
	assert.match(status, /Both clocks bracketed \(observed, not confirmed\): start 12\.0 min hit to 50\.0 min zero \(band 38\.0 min\); end 11\.5 min hit to 49\.5 min zero \(band 38\.0 min\)\. No eligible strong timing observations between these endpoints \(weak and excluded pairs are not used here\)\./);
	assert.match(status, /No profile yet: automatic profiles are on, and this model has reuses 1 \(need 2\), later misses start 1 \(need 2\), end 1 \(need 2\)\. An automatic, provisional profile needs at least 2 strong reuse pairs/);
	assert.match(status, /These are eligibility requirements, not a confidence level, and there is no date: a later miss appears only when normal use has a pause longer than the longest reuse\./);
	assert.match(status, /A manual seed of your own minutes needs no data and always wins: \/cache seed github-copilot\/gpt-6-astra <hitMinutes> <expireMinutes>, or "Seed or edit a model profile" in the \/cache menu\./);
	assert.doesNotMatch(status, /seed github-copilot\/gpt-6-astra \d/, "no suggested thresholds");
	assertHonest(status);
	await h.command("learn github-copilot/gpt-6-astra");
	assertHonest(h.lastNote());
	assert.match(h.lastNote(), /excluded: none\. Active profile: none\./);

	assert.equal(cli(env, ["settings", "--auto", "off"]).status, 0);
	await h.tick();
	h.advance(MIN);
	assert.equal(await h.tick(), "uncertain · no seeded profile for this model", "automatic off restores the manual-only footer");
	await h.command("status");
	assert.match(h.lastNote(), /Automatic profiles are off \(\/cache settings auto on turns them on\), so without a seed this model stays "uncertain · no seeded profile for this model"\./);
	assert.deepEqual(cli(env, ["status"]).data.profiles.map((p) => p.model), [SOL.model], "views never seed");
});

test("a seeded profile persists unchanged beside candidates; read-only views and re-imports change no byte or count", async (t) => {
	const env = tmpEnv(t);
	const s = chain(env.sessionsDir, "sol", SOL);
	assert.equal(cli(env, ["seed", SOL_REF, "25", "30"]).status, 0);
	importModels(env);
	const before = evidenceOf(env, SOL_REF);
	assert.deepEqual([before.stage, before.profile.hitUnderMs, before.profile.expireOverMs, before.profile.source], ["both_clocks", 25 * MIN, 30 * MIN, "seed"]);
	const hash = sha(env.dbPath);

	const h = loadExtension(t, env, { branch: s.branch() });
	await h.emit("session_start", { reason: "startup" });
	await h.command("status");
	assert.match(h.lastNote(), /The active profile \(seed: 25\.0 min \/ 30\.0 min\) decides the forecast; this evidence is shown for comparison and never changes it\./);
	await h.command("learn");
	assert.match(h.lastNote(), /Active profile: 25\.0 min \/ 30\.0 min \(seed\)\.\n {2}evidence: Both clocks bracketed/);
	h.script({ select: ["Learning candidates", "All models", "Learning candidates", /^Current model/, "Learning candidates", "Other model (type provider/model)", "Close"], input: ["openai/gpt-none"] });
	await h.command("");
	assert.deepEqual(h.editors.map((v) => v.title), Array(3).fill("Learning candidates (read-only; edits are ignored)"));
	assert.match(h.editors[0].text, /github-copilot\/gpt-6\.1-sol: 3 pairs[\s\S]*Both clocks bracketed/);
	assert.match(h.editors[1].text, /^Observed candidate envelopes[\s\S]*github-copilot\/gpt-6\.1-sol: 3 pairs/);
	assert.match(h.editors[2].text, /openai\/gpt-none: 0 pairs[\s\S]*Missing: no pairs yet[\s\S]*\/cache seed openai\/gpt-none <hitMinutes> <expireMinutes>/, "a typed model with no data is described, not hidden");
	for (const v of h.editors) assertHonest(v.text);
	learnTextOf(env);
	assert.equal(sha(env.dbPath), hash, "status, learn, menu views, and CLI learn write nothing");

	const again = importModels(env);
	assert.deepEqual([again.responses.added, again.pairs.added], [0, 0]);
	assert.deepEqual(evidenceOf(env, SOL_REF), before, "a re-import leaves the evidence identical");
	assert.deepEqual(cli(env, ["status"]).data.profiles.map((p) => [p.hitUnderMs, p.expireOverMs]), [[25 * MIN, 30 * MIN]], "candidates never change the seed");
});

test("with a profile, other uncertain causes point to that cause, never to the amount of evidence", async (t) => {
	const env = tmpEnv(t);
	const s = chain(env.sessionsDir, "sol", SOL, { start: T0 - 100 * MIN });
	s.compaction(s.lastStart + MIN);
	assert.equal(cli(env, ["seed", SOL_REF, "25", "30"]).status, 0);
	importModels(env);
	const compacted = loadExtension(t, env, { branch: s.branch() });
	await compacted.emit("session_start", { reason: "startup" });
	assert.equal(compacted.status(), "uncertain · context compacted");
	await compacted.command("status");
	const notThreshold = (reason) =>
		new RegExp(`The current "uncertain" \\(${reason}\\) is separate from the profile and is not a sample-count threshold\\. Depending on its cause, time passing, a new usable response, or a session or configuration change can resolve it\\.`);
	assert.match(compacted.lastNote(), notThreshold("context compacted"));
	assert.match(compacted.lastNote(), /Forecast for the next request: uncertain \(context compacted\)\./, "the actual cause stays visible");
	assert.doesNotMatch(compacted.lastNote(), /No active profile|No profile yet|To activate one|more samples/);

	const unverified = loadExtension(t, env, { branch: s.branch().slice(0, -1), baseline: { status: "unknown" } });
	await unverified.emit("session_start", { reason: "startup" });
	assert.equal(unverified.status(), "uncertain · configuration not verifiable");
	await unverified.command("status");
	assert.match(unverified.lastNote(), notThreshold("configuration not verifiable"));

	// No anchor yet: a new usable live response resolves it, with the same profile and no change to the history counts.
	const fresh = loadExtension(t, env, { branch: [] });
	await fresh.emit("session_start", { reason: "startup" });
	assert.equal(fresh.status(), "uncertain · no usable previous response yet");
	await fresh.command("status");
	assert.match(fresh.lastNote(), notThreshold("no usable previous response yet"));
	const counts = evidenceOf(env, SOL_REF).responses.total;
	await fresh.respond();
	assert.match(fresh.status(), /^cache hit · until /, "the next usable response clears it");
	assert.equal(evidenceOf(env, SOL_REF).responses.total, counts, "recording is off: the hit came from the live anchor, not from more samples");
	assert.deepEqual(cli(env, ["status"]).data.profiles.map((p) => [p.hitUnderMs, p.expireOverMs]), [[25 * MIN, 30 * MIN]], "the profile never changed");
	await fresh.command("status");
	assert.match(fresh.lastNote(), /The active profile \(seed: 25\.0 min \/ 30\.0 min\) decides the forecast/);
});

test("evidence stays per provider/model; only the known Opus separator alias is grouped", (t) => {
	const env = tmpEnv(t);
	const opus = (model, provider = "github-copilot") => ({ provider, model });
	const a = new SessionFile({ tag: "opusa" });
	a.turn({ start: T0 - 900 * MIN, ...opus("claude-opus-5-5") });
	a.turn({ gap: 2 * MIN, ...opus("claude-opus-5-5") });
	a.write(env.sessionsDir);
	const b = new SessionFile({ tag: "opusb" });
	b.turn({ start: T0 - 800 * MIN, ...opus("claude-opus-5.5") });
	b.turn({ gap: 2 * MIN, ...opus("claude-opus-5.5") });
	b.turn({ gap: 2 * MIN, ...opus("claude-opus-5.5") });
	b.write(env.sessionsDir);
	const c = new SessionFile({ tag: "anthropic" });
	c.turn({ start: T0 - 700 * MIN, ...opus("claude-opus-5.5", "anthropic") });
	c.write(env.sessionsDir);
	chain(env.sessionsDir, "astra", ASTRA);
	const mini = new SessionFile({ tag: "mini" });
	mini.turn({ start: T0 - 600 * MIN, ...opus("gpt-6-astra-mini") });
	mini.write(env.sessionsDir);
	importModels(env, "github-copilot/claude-opus-5.5", "anthropic/claude-opus-5.5", ASTRA_REF, "github-copilot/gpt-6-astra-mini");

	const grouped = evidenceOf(env, "github-copilot/claude-opus-5-5");
	assert.deepEqual([grouped.model, grouped.models, grouped.responses.total, grouped.pairs], ["claude-opus-5.5", ["claude-opus-5-5", "claude-opus-5.5"], 5, 3]);
	assert.deepEqual(evidenceOf(env, "github-copilot/claude-opus-5.5"), grouped, "either separator finds the same group");
	assert.deepEqual([evidenceOf(env, "anthropic/claude-opus-5.5").responses.total, evidenceOf(env, "anthropic/claude-opus-5.5").pairs], [1, 0], "never across providers");
	assert.deepEqual([evidenceOf(env, "github-copilot/gpt-6-astra-mini").responses.total, evidenceOf(env, ASTRA_REF).responses.total], [1, 4], "another suffix is another model");
	assert.deepEqual(learn(env).evidence.map((e) => `${e.provider}/${e.model}`), ["anthropic/claude-opus-5.5", "github-copilot/claude-opus-5.5", "github-copilot/gpt-6-astra", "github-copilot/gpt-6-astra-mini"]);
	assert.match(learnTextOf(env, "github-copilot/claude-opus-5.5"), /reported ids: claude-opus-5-5, claude-opus-5\.5\./);
});

test("recording off: live responses add nothing; on: they are added as they happen, and the first response after a restart has no pair", async (t) => {
	const env = tmpEnv(t);
	assert.equal(cli(env, ["seed", SOL_REF, "25", "30"]).status, 0);
	const h = loadExtension(t, env, { model: ASTRA });
	await h.emit("session_start", { reason: "startup" });
	await h.respond(ASTRA);
	h.advance(MIN);
	await h.respond(ASTRA);
	assert.equal(evidenceOf(env, ASTRA_REF).responses.total, 0);
	await h.command("status");
	assert.match(h.lastNote(), /Recording is off: stored evidence is still used, but counts change only through an explicit import\. A bare \/cache import covers seeded models only; name any other model \(\/cache import provider\/model, or the current model in the \/cache menu's import\)\./);
	assert.equal(h.status(), "uncertain · learning: no pairs yet · recording off · /cache", "the footer says counts are paused");

	await h.command("on");
	await h.respond(ASTRA);
	h.advance(MIN);
	await h.respond(ASTRA);
	const on = evidenceOf(env, ASTRA_REF);
	assert.deepEqual([on.responses.live, on.pairs, on.strong, on.origins.live], [2, 1, 1, 1]);
	await h.command("status");
	assert.match(h.lastNote(), /Recording is on: new responses are added as they happen\. This is a snapshot, not a countdown; reopen it for fresh counts\./);
	assert.equal(h.status(), "uncertain · learning: reuses 1/2, later misses 0/2 · /cache", "live pairs advance the counters at once; one pair activates nothing");
	await h.emit("session_shutdown", { reason: "quit" });

	const next = loadExtension(t, env, { model: ASTRA });
	await next.emit("session_start", { reason: "resume" });
	next.advance(MIN);
	await next.respond(ASTRA);
	const after = evidenceOf(env, ASTRA_REF);
	assert.deepEqual([after.responses.live, after.pairs], [3, 1]);
});

test("evidence is not monotonic: a later, longer hit raises H past the old Z and the bracket disappears", (t) => {
	const env = tmpEnv(t);
	chain(env.sessionsDir, "first", ASTRA);
	importModels(env, ASTRA_REF);
	assert.equal(evidenceOf(env, ASTRA_REF).stage, "both_clocks");
	chain(env.sessionsDir, "later", ASTRA, { start: T0 - 400 * MIN, hit: 60, zero: null });
	importModels(env, ASTRA_REF);
	const e = evidenceOf(env, ASTRA_REF);
	assert.deepEqual([e.stage, e.missing], ["partial", ["no_long_zero:start", "no_long_zero:end"]]);
	assert.deepEqual([e.clocks.start.hitObservedMs, e.clocks.start.expiryObservedMs, e.clocks.start.contradictoryZeros, e.clocks.start.bandMs], [60 * MIN, null, 1, null]);
	assert.match(learnTextOf(env, ASTRA_REF), /Evidence can move back: a later, longer hit raises H and can remove the current Z, and with it an automatic profile\./);
});

test("coverage dates carry each date's own offset (or Z in UTC mode); unknown or out-of-range times show as unknown", (t) => {
	const env = tmpEnv(t);
	const winter = Date.UTC(2026, 0, 15, 12, 0, 0);
	const s = new SessionFile({ tag: "dates" });
	s.turn({ start: winter, ...ASTRA });
	s.turn({ start: T0, ...ASTRA });
	s.write(env.sessionsDir);
	const odd = new SessionFile({ tag: "odd" });
	const message = (extra) => ({ type: "message", message: { role: "assistant", provider: "github-copilot", model: "gpt-odd", usage: pos(), stopReason: "stop", content: [{ type: "text", text: SENTINEL }], ...extra } });
	odd.add(message({}));
	odd.add({ ...message({ timestamp: 1e20 }), timestamp: new Date(T0).toISOString() });
	odd.write(env.sessionsDir);
	importModels(env, ASTRA_REF, "github-copilot/gpt-odd");

	const ny = learnTextOf(env, ASTRA_REF, { TZ: "America/New_York" });
	assert.match(ny, /2 responses \(2 historical, 0 live\), first 2026-01-15 07:00 UTC-5, latest 2026-10-29 08:00 UTC-4;/, "winter and summer offsets");
	assert.match(learnTextOf(env, ASTRA_REF, { TZ: "Asia/Kolkata" }), /first 2026-01-15 17:30 UTC\+5:30, latest 2026-10-29 17:30 UTC\+5:30;/);
	const oddText = learnTextOf(env, "github-copilot/gpt-odd", { TZ: "Asia/Tokyo" });
	const proxy = "2026-10-29 21:00 UTC\\+9 \\(saved completion time; no valid request start\\)";
	assert.match(oddText, new RegExp(`2 responses \\(2 historical, 0 live\\), first ${proxy}, latest ${proxy}; 2 reported a positive cache read; 1 without a request start; 1 with no valid time;`), "an out-of-range start falls back to its valid completion time, labeled");
	assert.match(oddText, /excluded: timing_missing=1\./);
	assert.match(oddText, /First and latest are response request starts\. A response without a valid request start uses its saved completion time instead \(labeled\)/);
	assert.ok(!oddText.includes(SENTINEL));
	assert.equal(cli(env, ["settings", "--time", "utc"]).status, 0);
	assert.match(learnTextOf(env, ASTRA_REF, { TZ: "America/New_York" }), /first 2026-01-15T12:00:00Z, latest 2026-10-29T12:00:00Z;/, "UTC mode ignores TZ");
	const odd2 = evidenceOf(env, "github-copilot/gpt-odd").responses;
	assert.deepEqual([odd2.firstMs, odd2.firstSource, odd2.lastMs, odd2.lastSource, odd2.missingStart, odd2.endFallback, odd2.timeUnknown], [T0, "completion_proxy", T0, "completion_proxy", 1, 1, 1]);
});

test("one out-of-range time never hides the valid coverage of other responses; stored values and pair gates are unchanged", (t) => {
	const env = tmpEnv(t);
	const entry = (model, { start, end }) => ({ type: "message", ...(end === undefined ? {} : { timestamp: end }), message: { role: "assistant", provider: "github-copilot", model, usage: pos(), stopReason: "stop", content: [{ type: "text", text: SENTINEL }], ...(start === undefined ? {} : { timestamp: start }) } });
	const mixed = new SessionFile({ tag: "mixed" });
	mixed.turn({ start: T0 - 100 * MIN, model: "gpt-mixed" });
	mixed.turn({ start: T0 - 90 * MIN, model: "gpt-mixed" });
	mixed.add(entry("gpt-mixed", { start: 1e20, end: new Date(T0 - 50 * MIN).toISOString() }));
	mixed.add(entry("gpt-mixed", { start: 2e20, end: 9e15 }));
	mixed.write(env.sessionsDir);
	const bad = new SessionFile({ tag: "bad" });
	bad.add(entry("gpt-bad", { start: 1e20 }));
	bad.add(entry("gpt-bad", {}));
	bad.write(env.sessionsDir);
	assert.equal(cli(env, ["settings", "--time", "utc"]).status, 0);
	importModels(env, "github-copilot/gpt-mixed", "github-copilot/gpt-bad");

	const m = evidenceOf(env, "github-copilot/gpt-mixed");
	assert.deepEqual(
		[m.responses.total, m.responses.firstMs, m.responses.firstSource, m.responses.lastMs, m.responses.lastSource, m.responses.endFallback, m.responses.timeUnknown],
		[4, T0 - 100 * MIN, "request_start", T0 - 50 * MIN, "completion_proxy", 1, 1],
		"every response is counted; valid starts and a valid completion fallback keep their dates",
	);
	assert.deepEqual([m.qualified, m.excluded], [1, { clock_anomaly: 2 }], "pairs with impossible times still never qualify");
	const text = learnTextOf(env, "github-copilot/gpt-mixed");
	assert.match(text, /4 responses \(4 historical, 0 live\), first 2026-10-29T10:20:00Z, latest 2026-10-29T11:10:00Z \(saved completion time; no valid request start\); 4 reported a positive cache read; 1 with no valid time;/);
	assert.match(learnTextOf(env, "github-copilot/gpt-bad"), /2 responses \(2 historical, 0 live\), first unknown, latest unknown; 2 reported a positive cache read; 1 without a request start; 2 with no valid time;/);

	const db = new DatabaseSync(env.dbPath, { readOnly: true });
	t.after(() => db.close());
	const raw = db.prepare("SELECT request_start_ms AS s, end_ms AS e FROM samples WHERE model = 'gpt-mixed' ORDER BY seq").all().map((r) => [r.s, r.e]);
	assert.deepEqual(raw, [[T0 - 100 * MIN, T0 - 100 * MIN + 30_000], [T0 - 90 * MIN, T0 - 90 * MIN + 30_000], [1e20, T0 - 50 * MIN], [2e20, 9e15]], "stored values are never rewritten");
	for (const out of [text, learnTextOf(env)]) assert.ok(!out.includes(SENTINEL));
});

test("weak and excluded observations inside the band are counted, not denied, and never treated as expiry", (t) => {
	const env = tmpEnv(t);
	const s = chain(env.sessionsDir, "band", ASTRA);
	s.turn({ gap: 30 * MIN, u: pos(), ...ASTRA });
	s.compaction(s.lastStart + MIN);
	s.turn({ gap: 30 * MIN, u: cold(), ...ASTRA });
	s.write(env.sessionsDir);
	importModels(env, ASTRA_REF);
	const e = evidenceOf(env, ASTRA_REF);
	assert.deepEqual([e.stage, e.strong, e.weak, e.excluded], ["both_clocks", 2, 2, { boundary: 1 }], "a 30-minute weak pair and a 30-minute excluded pair lie inside the 12-to-50-minute band");
	assert.deepEqual([e.clocks.start.hitObservedMs, e.clocks.start.expiryObservedMs, e.clocks.start.zeros], [12 * MIN, 50 * MIN, 1], "neither moves H or Z or counts as a zero");
	const text = learnTextOf(env, ASTRA_REF);
	assert.match(text, /No eligible strong timing observations between these endpoints \(weak and excluded pairs are not used here\)\./);
	assert.match(text, /github-copilot\/gpt-6-astra: 5 pairs \(5 historical, 0 live, 0 both\); 4 qualified \(2 strong, 2 weak\)\./);
	assert.match(text, /excluded: boundary=1\./);
	assert.doesNotMatch(text, /nothing was observed/i);
});

test("the seed hint names the full model only when /cache seed would accept it; otherwise it stays generic", async (t) => {
	const env = tmpEnv(t);
	assert.equal(cli(env, ["seed", SOL_REF, "25", "30"]).status, 0);
	const long = `m${"x".repeat(158)}9`;
	assert.equal(long.length, 160);
	const h = loadExtension(t, env, { model: { provider: "github-copilot", model: long } });
	await h.emit("session_start", { reason: "startup" });
	await h.command("status");
	assert.ok(h.lastNote().includes(`/cache seed github-copilot/${long} <hitMinutes> <expireMinutes>`), "a valid 160-character id is never truncated in the command");
	const learnLong = learnTextOf(env, `github-copilot/${long}`);
	assert.ok(learnLong.includes(`/cache seed github-copilot/${long} <hitMinutes> <expireMinutes>`));

	const invalid = loadExtension(t, env, { model: { provider: "copilot/proxy", model: "gpt-x" } });
	await invalid.emit("session_start", { reason: "startup" });
	await invalid.command("status");
	const text = invalid.lastNote();
	assert.match(text, /A manual seed of your own minutes needs no data and always wins: \/cache seed <provider\/model> <hitMinutes> <expireMinutes> with a valid provider\/model, or "Seed or edit a model profile" in the \/cache menu\./);
	assert.ok(!text.includes("/cache seed copilot/proxy"), "no concrete command that seed would reject");
	assert.equal(cli(env, ["seed", "copilot/proxy/gpt-x", "1", "2"]).data.profile.provider, "copilot", "seed reads such a target as a different provider, so the hint must not offer it");
});

test("after a storage problem the learning views show the fixed diagnostic, never counts, and nothing is migrated", async (t) => {
	const env = tmpEnv(t);
	fs.mkdirSync(env.root, { recursive: true, mode: 0o700 });
	const old = new DatabaseSync(env.dbPath);
	old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; CREATE TABLE events (seq INTEGER PRIMARY KEY, id TEXT, observed_at REAL, kind TEXT, payload BLOB) STRICT; PRAGMA user_version = 1");
	old.close();
	fs.chmodSync(env.dbPath, 0o600);
	const hash = sha(env.dbPath);

	const r = cli(env, ["learn"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /^cache-insights: migration_required: /);
	const h = loadExtension(t, env);
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.status(), "cache: upgrade needed");
	for (const cmd of ["learn", "learn github-copilot/gpt-6-astra", "status"]) {
		await h.command(cmd);
		assert.match(h.lastNote(), /Stopped in this Pi process after a local problem \(migration_required\)\.\nthe cache-insights database needs a one-time upgrade/, cmd);
		assert.doesNotMatch(h.lastNote(), /No cache-insights database yet|responses|Active profile|Evidence/, `${cmd}: no counts or profile`);
	}
	h.script({ select: ["Learning candidates", "Close"] });
	await h.command("");
	assert.match(h.notes.at(-1)[1], /needs a one-time upgrade before this can be used/);
	assert.equal(h.editors.length, 0, "no learning view over an unreadable database");
	assert.equal(sha(env.dbPath), hash, "nothing was migrated or written");

	const empty = tmpEnv(t);
	assert.equal(cli(empty, ["settings", "--time", "utc"]).status, 0);
	assert.equal(learn(empty).evidence.length, 0);
	assert.match(learnTextOf(empty), /^No responses or pairs yet\. Import history \(\/cache import\) or turn recording on \(\/cache on\)\. Recording is off/);
});
