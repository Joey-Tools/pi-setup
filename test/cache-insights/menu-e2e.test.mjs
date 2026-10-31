// Interactive /cache menu, end to end: command → scripted ui.select/input/confirm/editor → real temp SQLite → status.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import zlib from "node:zlib";
import { cli, loadExtension, MIN, SessionFile, SOL, T0, tmpEnv } from "./harness.mjs";

const MAIN = ["Status and forecast", "Display settings", "Recording: off (turn on)", "Seed or edit a model profile", "Import session metadata", "Learning candidates", "Recent history", "Upgrade the database", "Close"];
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const flush = () => new Promise((r) => setImmediate(r));
const until = async (cond) => {
	for (let i = 0; i < 200 && !cond(); i++) await flush();
	assert.ok(cond(), "condition reached");
};

/** Seeded Sol history with a recent response at T0-10min, flat catalog prices, UTC times. */
function seededEnv(t) {
	const env = tmpEnv(t);
	const s = new SessionFile({ tag: "menu" });
	s.turn({ start: T0 - 70 * MIN, dur: 60_000 });
	s.turn({ start: T0 - 10 * MIN, dur: 60_000 });
	s.write(env.sessionsDir);
	assert.equal(cli(env, ["seed", "github-copilot/gpt-6.1-sol", "25", "30"]).status, 0);
	assert.equal(cli(env, ["settings", "--time", "utc", "--cost", "off"]).status, 0);
	return { env, s };
}
const flat = { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 };

test("bare /cache opens the main menu, shows status read-only, and returns to the menu", async (t) => {
	const { env, s } = seededEnv(t);
	const h = loadExtension(t, env, { branch: s.branch() });
	await h.emit("session_start", { reason: "startup" });
	h.script({ select: ["Status and forecast", "Close"] });
	await h.command("");
	assert.equal(h.selects.length, 2, "the menu redraws after the status view");
	assert.equal(h.selects[0].title, "Cache insights · github-copilot/gpt-6.1-sol · recording off · time utc · cost off");
	assert.deepEqual(h.selects[0].choices, MAIN);
	assert.ok(h.selects[0].signal instanceof AbortSignal);
	assert.equal(h.editors[0].title, "Cache status (read-only; edits are ignored)");
	assert.match(h.editors[0].text, /Forecast for the next request: cache hit/);
	assert.equal(h.status(), "cache hit · until 12:15 UTC");
	h.script({ select: ["Close"] });
	await h.command("menu");
	assert.equal(h.selects.length, 3, "/cache menu is an alias");
});

test("/cache settings edits time and cost through pickers; values persist and change the status", async (t) => {
	const { env, s } = seededEnv(t);
	const h = loadExtension(t, env, { branch: s.branch(), model: { ...SOL, cost: flat } });
	await h.emit("session_start", { reason: "startup" });
	h.script({ select: [/^Times:/, "UTC", /^Cost:/, "USD and GitHub credits", "Back"] });
	await h.command("settings");
	assert.deepEqual(h.selects[0].choices, ["Times: UTC (change)", "Cost: off (change)", "Automatic profiles: on (change)", "Local timezone guide", "Back"]);
	assert.deepEqual(h.selects[3].choices, ["Off", "USD", "GitHub credits", "USD and GitHub credits", "Back"]);
	assert.deepEqual(h.selects[4].choices, ["Times: UTC (change)", "Cost: both (change)", "Automatic profiles: on (change)", "Local timezone guide", "Back"], "the loop shows saved values");
	assert.deepEqual(cli(env, ["settings"]).data.settings, { time: "utc", cost: "both", auto: "on" });
	assert.equal(h.status(), "cache hit · until 12:15 UTC · miss ≈$0.021 (2.1 cr)");
	h.script({ select: [/^Times:/, "Local time", "Back"] });
	await h.command("settings");
	assert.equal(cli(env, ["settings"]).data.settings.time, "local");
});

test("the profile wizard seeds the current model after validation and confirmation, and edits numbers only", async (t) => {
	const env = tmpEnv(t);
	const h = loadExtension(t, env);
	await h.emit("session_start", { reason: "startup" });
	h.script({ select: ["Seed or edit a model profile", /^Current model: github-copilot\/gpt-6\.1-sol \(no profile\)$/, "Close"], input: ["25", "30"], confirm: [true] });
	await h.command("");
	assert.match(h.inputs[0].title, /^Cache hit while both clocks are under for github-copilot\/gpt-6\.1-sol, in minutes \(for example 25; Esc cancels\)$/);
	assert.match(h.confirms[0][1], /cache hit while both clocks are under 25 min, cache expired once both are over 30 min/);
	assert.deepEqual(cli(env, ["status"]).data.profiles.map((p) => [p.model, p.hitUnderMs, p.expireOverMs]), [[SOL.model, 25 * MIN, 30 * MIN]]);

	h.script({ select: ["Seed or edit a model profile", /^Current model: .*hit < 25 min, expired > 30 min/, "Close"], input: ["", "35"], confirm: [true] });
	await h.command("");
	assert.match(h.inputs[2].title, /Enter keeps 25;/);
	assert.equal(h.inputs[2].placeholder, "25 (Enter keeps)");
	assert.deepEqual(cli(env, ["status"]).data.profiles.map((p) => [p.hitUnderMs, p.expireOverMs]), [[25 * MIN, 35 * MIN]]);

	h.script({ select: ["Seed or edit a model profile", /^Current model/, "Close"], input: ["40", ""], confirm: [true] });
	await h.command("");
	assert.match(h.notes.at(-1)[1], /Minutes must satisfy 0 < hit <= expire <= 1440; nothing changed/);
	h.script({ select: ["Seed or edit a model profile", "Other model (type provider/model)", "Close"], input: ["openai/gpt-6-astra", "10", "15"], confirm: [true] });
	await h.command("");
	assert.deepEqual(cli(env, ["status"]).data.profiles.map((p) => p.model).sort(), ["gpt-6-astra", SOL.model]);
});

test("cancelling at every stage on a fresh store creates nothing", async (t) => {
	const env = tmpEnv(t);
	const h = loadExtension(t, env);
	await h.emit("session_start", { reason: "startup" });
	const flows = [
		{ select: [undefined] },
		{ select: ["Seed or edit a model profile", "Back", "Close"] },
		{ select: ["Seed or edit a model profile", /^Current model/, "Close"], input: [undefined] },
		{ select: ["Seed or edit a model profile", /^Current model/, "Close"], input: [""] },
		{ select: ["Seed or edit a model profile", /^Current model/, "Close"], input: ["25", undefined] },
		{ select: ["Seed or edit a model profile", /^Current model/, "Close"], input: ["25", "30"], confirm: [false] },
		{ select: ["Seed or edit a model profile", "Other model (type provider/model)", "Close"], input: ["not-a-model"] },
		{ select: ["Import session metadata", "Back", "Close"] },
		{ select: ["Import session metadata", /^Current model/, "Close"], confirm: [false] },
		{ select: ["Display settings", /^Times:/, "Back", "Back", "Close"] },
		{ select: ["Recent history", "Other (1-200)", "Close"], input: [undefined] },
		{ select: ["Learning candidates", "Close"] },
		{ select: ["Upgrade the database", "Close"], confirm: [false] },
		{ select: ["no such choice"] },
	];
	for (const flow of flows) {
		h.script(flow);
		await h.command("");
		assert.equal(h.queue.select.length + h.queue.input.length + h.queue.confirm.length, 0, JSON.stringify(flow));
	}
	assert.ok(!fs.existsSync(env.root), "no directory or database was created");
	assert.ok(!h.notes.some(([level]) => level === "error") && !h.notes.some(([, m]) => /local problem/.test(m)), "cancelling never reports a storage error");
});

test("an older database: menu actions route to a confirmed upgrade and nothing changes before it; a confirmed import shows its summary", async (t) => {
	const env = tmpEnv(t);
	fs.mkdirSync(env.root, { recursive: true, mode: 0o700 });
	const old = new DatabaseSync(env.dbPath);
	old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; CREATE TABLE events (seq INTEGER PRIMARY KEY, id TEXT, observed_at REAL, kind TEXT, payload BLOB) STRICT; PRAGMA user_version = 1");
	old.prepare("INSERT INTO events (id, observed_at, kind, payload) VALUES ('ev_0', 1, 'x', ?)").run(zlib.gzipSync("{}"));
	old.close();
	fs.chmodSync(env.dbPath, 0o600);
	const hash = sha(env.dbPath);
	const h = loadExtension(t, env);
	const gatedActions = ["Import session metadata", "Display settings", "Recent history", "Learning candidates", "Seed or edit a model profile", "Recording (unavailable)"];
	h.script({ select: [...gatedActions, "Upgrade the database (needed)", "Close"], confirm: [false] });
	await h.command("");
	assert.equal(h.selects[0].title, "Cache insights · github-copilot/gpt-6.1-sol · upgrade needed · settings unknown", "no invented defaults for an unreadable database");
	assert.ok(h.selects[0].choices.includes("Upgrade the database (needed)"));
	const upgradeNotes = h.notes.filter(([, m]) => /needs a one-time upgrade before this can be used\. Choose "Upgrade the database"/.test(m));
	assert.equal(upgradeNotes.length, gatedActions.length, "every data action routes to the upgrade instead of acting");
	assert.equal(h.confirms.length, 1, "only the upgrade asked, and it was cancelled");
	assert.equal(h.notes.at(-1)[1], "Cancelled; nothing changed.");
	h.script({ select: [] });
	await h.command("settings");
	assert.match(h.notes.at(-1)[1], /needs a one-time upgrade before this can be used/);
	assert.equal(h.selects.length, gatedActions.length + 2, "/cache settings shows no stale values");
	assert.equal(sha(env.dbPath), hash, "browsing and cancelling never migrate or write");
	h.script({ select: ["Upgrade the database (needed)", "Close"], confirm: [true] });
	await h.command("");
	assert.match(h.notes.find(([, m]) => /schema 2/.test(m))[1], /older draft rows, if any, were kept intact/);
	assert.match(h.selects.at(-1).title, /· recording off · time local · cost usd$/, "after the confirmed upgrade the stored settings show");

	const { env: env2 } = seededEnv(t);
	const s = new SessionFile({ tag: "more" });
	s.turn({ start: T0 - 200 * MIN });
	s.turn({ gap: 2 * MIN });
	s.write(env2.sessionsDir);
	const h2 = loadExtension(t, env2);
	h2.script({ select: ["Import session metadata", "All seeded models (1)", "Close"], confirm: [true] });
	await h2.command("");
	assert.match(h2.confirms[0][1], /for: github-copilot\/gpt-6\.1-sol\. No content/);
	assert.match(h2.notes.at(-1)[1], /Responses: 4 matched, 4 added/);
	assert.equal(cli(env2, ["status"]).data.counts.samples, 4);
});

test("history and learning views are read-only (edits ignored); recording toggles from the menu", async (t) => {
	const { env } = seededEnv(t);
	assert.equal(cli(env, ["import", "--sessions-dir", env.sessionsRoot]).status, 0);
	const h = loadExtension(t, env);
	h.script({ select: ["Recent history", "50", "Learning candidates", "All models", "Recording: off (turn on)", "Close"] });
	await h.command("");
	assert.equal(h.editors[0].title, "Recent history (read-only; edits are ignored)");
	assert.match(h.editors[0].text, /^Last 2 sample\(s\), oldest first/);
	assert.equal(h.editors[1].title, "Learning candidates (read-only; edits are ignored)");
	assert.match(h.editors[1].text, /github-copilot\/gpt-6\.1-sol: 1 pairs/);
	assert.equal(cli(env, ["status"]).data.counts.samples, 2, "returned edits changed nothing");
	assert.equal(cli(env, ["status"]).data.recording, true);
	assert.ok(h.selects.at(-1).choices.includes("Recording: on (turn off)"), "the toggle shows the saved state");
	h.script({ select: ["Recording: on (turn off)", "Close"] });
	await h.command("");
	assert.equal(cli(env, ["status"]).data.recording, false);
});

test("one menu at a time; shutdown aborts pending dialogs and late answers cannot write or reopen the menu", async (t) => {
	const env = tmpEnv(t);
	const h = loadExtension(t, env);
	await h.emit("session_start", { reason: "startup" });
	h.script({ select: [{ defer: true }] });
	const first = h.command("");
	await until(() => h.pending.length === 1);
	await h.command("");
	assert.equal(h.notes.at(-1)[1], "A /cache menu is already open.");
	assert.equal(h.selects.length, 1);
	h.pending.shift().resolve("Close");
	await first;

	for (const stage of ["input", "confirm"]) {
		h.script({ select: ["Seed or edit a model profile", /^Current model/], input: stage === "input" ? [{ defer: true }] : ["25", "30"], confirm: stage === "confirm" ? [{ defer: true }] : [] });
		const run = h.command("");
		await until(() => h.pending.length === 1);
		const signal = (stage === "input" ? h.inputs : h.selects).at(-1).signal;
		await h.emit("session_shutdown", { reason: "quit" });
		assert.ok(signal.aborted, `${stage}: the pending dialog was aborted`);
		const selects = h.selects.length;
		const notes = h.notes.length;
		h.pending.shift().resolve(stage === "input" ? "25" : true);
		await run;
		assert.equal(h.selects.length, selects, "the menu is not resurrected");
		assert.equal(h.notes.length, notes, "nothing is reported after shutdown");
		assert.ok(!fs.existsSync(env.root), `${stage}: a late answer writes nothing`);
		await h.emit("session_start", { reason: "startup" });
	}
});

test("direct subcommands are unchanged; outside the TUI, or without select, bare /cache stays read-only", async (t) => {
	const { env, s } = seededEnv(t);
	const h = loadExtension(t, env, { branch: s.branch() });
	await h.emit("session_start", { reason: "startup" });
	await h.command("status");
	await h.command("settings time local cost usd");
	await h.command("history 5");
	assert.equal(h.selects.length, 0, "explicit subcommands never open the menu");
	assert.deepEqual(cli(env, ["settings"]).data.settings, { time: "local", cost: "usd", auto: "on" });

	for (const mode of ["print", "json", "rpc"]) {
		const r = loadExtension(t, env, { mode, branch: s.branch() });
		await r.emit("session_start", { reason: "startup" });
		await r.command("");
		await r.command("menu");
		await r.command("settings");
		assert.deepEqual([r.selects.length, r.inputs.length, r.editors.length], [0, 0, 0], mode);
		assert.deepEqual(r.uiErrors, []);
		if (mode === "rpc") assert.match(r.notes[0][1], /^Cache insights \(seeded, provisional/);
	}
	const plain = loadExtension(t, env, { branch: s.branch(), menuUI: false });
	await plain.emit("session_start", { reason: "startup" });
	await plain.command("");
	assert.match(plain.notes.at(-1)[1], /Forecast for the next request: cache hit/, "a TUI without select falls back to text");
});

test("unsafe model ids are never offered, and an unknown selection fails closed", async (t) => {
	const env = tmpEnv(t);
	const h = loadExtension(t, env, { model: { provider: "github-copilot", model: "gpt\u001b[31m-evil\u202e" } });
	await h.emit("session_start", { reason: "startup" });
	h.script({ select: ["Seed or edit a model profile", "Close"] });
	await h.command("");
	assert.match(h.selects[0].title, /^Cache insights · no active model · not set up/);
	assert.deepEqual(h.selects[1].choices, ["Other model (type provider/model)", "Back"]);
	assert.ok(!JSON.stringify(h.selects).includes("\u001b"));
	h.script({ select: ["Seed or edit a model profile", "Current model: github-copilot/gpt-evil", "Close"] });
	await h.command("");
	assert.equal(h.inputs.length, 0, "a returned label that was not offered does nothing");
	assert.ok(!fs.existsSync(env.root));
});

test("hosts whose UI and context use private fields and getters keep working inside the menu", async (t) => {
	const { env, s: file } = seededEnv(t);
	const h = loadExtension(t, env, { branch: file.branch() });
	class PrivateUI {
		#base;
		constructor(base) {
			this.#base = base;
		}
		select(...a) { return this.#base.select(...a); }
		input(...a) { return this.#base.input(...a); }
		confirm(...a) { return this.#base.confirm(...a); }
		editor(...a) { return this.#base.editor(...a); }
		notify(...a) { return this.#base.notify(...a); }
		setStatus(...a) { return this.#base.setStatus(...a); }
	}
	class PrivateCtx {
		#ui;
		#model;
		constructor(base) {
			Object.assign(this, { mode: base.mode, hasUI: base.hasUI, cwd: base.cwd, sessionManager: base.sessionManager, modelRegistry: base.modelRegistry });
			this.#ui = new PrivateUI(base.ui);
			this.#model = base.model;
		}
		get ui() { return this.#ui; }
		get model() { return this.#model; }
	}
	h.ctx = new PrivateCtx(h.ctx);
	await h.emit("session_start", { reason: "startup" });
	h.script({ select: ["Display settings", /^Cost:/, "USD", "Back", "Close"] });
	await h.command("");
	assert.match(h.selects[0].title, /^Cache insights · github-copilot\/gpt-6\.1-sol · /, "the model getter works through the menu");
	assert.equal(cli(env, ["settings"]).data.settings.cost, "usd");
	assert.equal(h.status(), "cache hit · until 12:15 UTC", "status refresh through the private-field UI works");
	assert.ok(!h.notes.some(([, m]) => /local problem/.test(m)));
});

test("profile and learning take exactly one typed model; import takes several", async (t) => {
	const { env } = seededEnv(t);
	const h = loadExtension(t, env);
	for (const entry of ["Seed or edit a model profile", "Learning candidates"]) {
		h.script({ select: [entry, /^Other model/, "Close"], input: ["openai/a openai/b"] });
		await h.command("");
		assert.equal(h.notes.at(-1)[1], "Choose exactly one model (provider/model); nothing changed.", entry);
	}
	assert.equal(h.inputs.length, 2, "no minutes were asked for");
	assert.equal(h.editors.length, 0, "no learning view for an ambiguous entry");
	assert.deepEqual(cli(env, ["status"]).data.profiles.map((p) => p.model), [SOL.model]);
	h.script({ select: ["Import session metadata", /^Other models/, "Close"], input: ["openai/a openai/b"], confirm: [false] });
	await h.command("");
	assert.match(h.confirms.at(-1)[1], /for: openai\/a, openai\/b\./);
});

test("session start and tree changes invalidate pending menu answers; a late read-only view return reopens nothing", async (t) => {
	const env = tmpEnv(t);
	const h = loadExtension(t, env);
	await h.emit("session_start", { reason: "startup" });
	for (const [event, payload] of [["session_start", { reason: "resume" }], ["session_tree", { newLeafId: "x", oldLeafId: "y" }]]) {
		h.script({ select: [{ defer: true }] });
		const run = h.command("");
		await until(() => h.pending.length === 1);
		const signal = h.selects.at(-1).signal;
		await h.emit(event, payload);
		assert.ok(signal.aborted, `${event} aborts the pending select`);
		const selects = h.selects.length;
		h.pending.shift().resolve("Recording: off (turn on)");
		await run;
		assert.equal(h.selects.length, selects, `${event}: no redraw`);
		assert.ok(!fs.existsSync(env.root), `${event}: the late choice did not turn recording on`);
	}
	h.script({ select: ["Status and forecast"], editor: [{ defer: true }] });
	const view = h.command("");
	await until(() => h.pending.length === 1);
	await h.emit("session_shutdown", { reason: "quit" });
	const selects = h.selects.length;
	const notes = h.notes.length;
	h.pending.shift().resolve("edited text");
	await view;
	assert.equal(h.selects.length, selects, "the menu does not come back after the view closes");
	assert.equal(h.notes.length, notes);
	assert.ok(!fs.existsSync(env.root));
});
