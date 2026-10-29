// Database location safety, schema migration, persistence, sharing, and failure behaviour through the public API.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import zlib from "node:zlib";
import cacheInsights from "../../extensions/cache-insights/index.ts";
import { CacheInsightsError, defaultSessionsDir, openCacheDb, SCHEMA_VERSION } from "../../lib/cache-insights/index.mjs";
import { CLI, cli, dbBytes, loadExtension, MIN, REPO, SENTINEL, SessionFile, T0, tmpEnv } from "./harness.mjs";

const open = (env, opts = {}) => openCacheDb({ root: env.root, workspaceCwd: env.workspace, ...opts });
const rejects = (p, code) => assert.rejects(p, (err) => err instanceof CacheInsightsError && err.code === code);

test("creates an owner-only directory and file only when asked, and refuses unsafe locations", async (t) => {
	const env = tmpEnv(t);
	assert.equal(await open(env), null);
	assert.ok(!fs.existsSync(env.root), "opening without create touches nothing");
	const db = await open(env, { create: true });
	db.close();
	db.close();
	assert.equal(fs.statSync(env.root).mode & 0o777, 0o700);
	assert.equal(fs.statSync(env.dbPath).mode & 0o777, 0o600);
	assert.ok(!fs.existsSync(`${env.dbPath}-wal`) && !fs.existsSync(`${env.dbPath}-journal`));

	fs.mkdirSync(path.join(env.workspace, ".git"));
	await rejects(openCacheDb({ root: path.join(env.workspace, ".pi", "cache-insights"), workspaceCwd: env.workspace, create: true }), "unsafe_path");
	fs.rmdirSync(path.join(env.workspace, ".git"));
	await rejects(openCacheDb({ root: env.workspace, workspaceCwd: env.workspace, create: true }), "unsafe_path");
	const elsewhere = path.join(env.dir, "elsewhere");
	fs.mkdirSync(elsewhere);
	const linkRoot = path.join(env.dir, "linked");
	fs.symlinkSync(elsewhere, linkRoot);
	await rejects(openCacheDb({ root: linkRoot, workspaceCwd: env.workspace, create: true }), "unsafe_path");
	const victim = path.join(env.dir, "victim");
	fs.writeFileSync(victim, "keep");
	const root2 = path.join(env.dir, "root2");
	fs.mkdirSync(root2, { mode: 0o700 });
	fs.symlinkSync(victim, path.join(root2, "cache-insights.sqlite"));
	await rejects(openCacheDb({ root: root2, workspaceCwd: env.workspace }), "unsafe_path");
	fs.unlinkSync(path.join(root2, "cache-insights.sqlite"));
	fs.linkSync(victim, path.join(root2, "cache-insights.sqlite"));
	await rejects(openCacheDb({ root: root2, workspaceCwd: env.workspace, create: true }), "unsafe_path");
	assert.equal(fs.readFileSync(victim, "utf8"), "keep");

	const r = cli(env, ["seed", "github-copilot/gpt-6.1-sol", "25", "30", "--root", linkRoot]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /^cache-insights: unsafe_path: /);
	assert.ok(!r.stderr.includes(env.dir), "errors never include paths");
});

/** A database in the earlier draft format (schema 1, gzip payload per row, with every draft column populated). */
function draftV1(env, { rows = [], payloadColumn = true } = {}) {
	fs.mkdirSync(env.root, { recursive: true, mode: 0o700 });
	const db = new DatabaseSync(env.dbPath);
	db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
	db.exec(
		`CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, observed_at REAL NOT NULL, kind TEXT NOT NULL, session_id TEXT, provider TEXT, model TEXT, outcome TEXT, scenario TEXT, dedup_key TEXT UNIQUE${payloadColumn ? ", payload BLOB NOT NULL" : ""}) STRICT`,
	);
	db.exec("CREATE INDEX events_observed ON events(observed_at)");
	db.prepare("INSERT INTO meta VALUES ('recording', 'on'), ('dedup_secret', ?)").run(crypto.randomBytes(32).toString("hex"));
	for (const [i, payload] of rows.entries()) {
		db.prepare("INSERT INTO events (id, observed_at, kind, session_id, provider, model, outcome, scenario, dedup_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(`ev_${i}`, 1000.5 + i, "assistant_result", `sess-${i}`, "github-copilot", "gpt-6.1-sol", "hit", "continuation", `d${i}`, payload);
	}
	db.exec("PRAGMA user_version = 1");
	db.close();
	fs.chmodSync(env.dbPath, 0o600);
}
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const rowsOf = (file, table) => {
	const raw = new DatabaseSync(file, { readOnly: true });
	try {
		return raw.prepare(`SELECT * FROM ${table} ORDER BY seq`).all();
	} finally {
		raw.close();
	}
};

test("read-only opens never migrate; an explicit upgrade keeps every draft row, column, and payload byte", async (t) => {
	const env = tmpEnv(t);
	const text = '{"kind":"assistant_result","n":1.0,"e":1E2,"z":-0,"big":12345678901234567890,"s":"é\\u00e9"}';
	const payloads = [zlib.gzipSync(Buffer.from(text, "utf8")), Buffer.from("not gzip")];
	draftV1(env, { rows: payloads });
	const before = rowsOf(env.dbPath, "events");
	const hash = sha(env.dbPath);

	await rejects(open(env), "migration_required");
	const status = cli(env, ["status"]);
	assert.equal(status.status, 1);
	assert.match(status.stderr, /^cache-insights: migration_required: .*node scripts\/cache-insights\.mjs migrate/);
	assert.equal(cli(env, ["learn"]).status, 1);
	const h = loadExtension(t, env);
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.status(), "cache: upgrade needed");
	assert.match(h.lastNote(), /needs a one-time upgrade\. Run \/cache migrate in the TUI/);
	await h.command("status");
	await h.command("learn");
	assert.equal(sha(env.dbPath), hash, "status, learn, and startup leave the file byte-identical");

	await h.command("migrate");
	assert.match(h.lastNote(), /schema 2; older draft rows, if any, were kept intact/);
	assert.match(h.status(), /^uncertain/);
	const db = await open(env);
	t.after(() => db.close());
	assert.equal(db.schemaVersion, SCHEMA_VERSION);
	assert.equal(db.isRecording(), true, "the saved opt-in survives");
	const after = rowsOf(env.dbPath, "legacy_events");
	assert.equal(after.length, 2);
	for (const [i, row] of after.entries()) {
		const { payload_text, ...rest } = row;
		assert.deepEqual({ ...rest, payload: Buffer.from(rest.payload) }, { ...before[i], payload: Buffer.from(before[i].payload) }, "every original column and byte");
	}
	assert.equal(after[0].payload_text, text, "decompressed text exactly as stored, never re-serialized");
	assert.equal(after[1].payload_text, null);
	assert.equal(cli(env, ["migrate"]).status, 0, "migrate is idempotent");
});

test("/cache import never upgrades or writes before confirmation; cancelling leaves the file byte-identical", async (t) => {
	const env = tmpEnv(t);
	draftV1(env, { rows: [zlib.gzipSync("{}")] });
	const hash = sha(env.dbPath);
	const h = loadExtension(t, env, { confirm: false });
	await h.command("import");
	assert.match(h.lastNote(), /needs a one-time upgrade\. Run \/cache migrate/, "no-argument import discovers profiles read-only");
	await h.command("import github-copilot/gpt-6.1-sol");
	assert.equal(h.lastNote(), "Cancelled; nothing imported.");
	assert.equal(h.confirms.length, 1, "asked once, for the explicit import only");
	assert.equal(sha(env.dbPath), hash, "an older database is untouched");

	const current = tmpEnv(t);
	assert.equal(cli(current, ["seed", "github-copilot/gpt-6.1-sol", "25", "30"]).status, 0);
	const before = sha(current.dbPath);
	const c = loadExtension(t, current, { confirm: false });
	await c.command("import");
	assert.match(c.confirms[0][1], /for: github-copilot\/gpt-6\.1-sol\./, "targets come from the seeded profiles");
	assert.equal(c.lastNote(), "Cancelled; nothing imported.");
	await c.emit("session_shutdown", { reason: "quit" });
	assert.equal(sha(current.dbPath), before, "cancelling writes nothing");
});

test("an unrecognized schema-1 file rolls back untouched; newer and foreign databases are refused unchanged", async (t) => {
	const env = tmpEnv(t);
	draftV1(env, { payloadColumn: false });
	assert.equal(cli(env, ["migrate"]).status, 1);
	await rejects(open(env, { upgrade: true }), "foreign_db");
	let raw = new DatabaseSync(env.dbPath);
	assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 1);
	assert.deepEqual(
		raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name),
		["events", "meta"],
		"no partial migration",
	);
	raw.exec("PRAGMA user_version = 99");
	raw.close();
	const hash = sha(env.dbPath);
	await rejects(open(env), "newer_schema");
	await rejects(open(env, { upgrade: true }), "newer_schema");
	assert.equal(sha(env.dbPath), hash, "a newer file is not touched, not even its journal mode");

	const env2 = tmpEnv(t);
	fs.mkdirSync(env2.root, { recursive: true, mode: 0o700 });
	const foreign = new DatabaseSync(env2.dbPath);
	foreign.exec("CREATE TABLE notes (body TEXT)");
	foreign.close();
	fs.chmodSync(env2.dbPath, 0o600);
	await rejects(open(env2, { upgrade: true }), "foreign_db");
});

test("invalid CLI commands, flags, and values are rejected before any file is created", (t) => {
	const env = tmpEnv(t);
	const bad = [
		["bogus"],
		["seed", "nomodel", "25", "30"],
		["seed", "github-copilot/gpt-6.1-sol", "", "30"],
		["seed", "github-copilot/gpt-6.1-sol", "30", "25"],
		["seed", "github-copilot/gpt-6.1-sol", "1e1", "30"],
		["seed", "github-copilot/gpt-6.1-sol", "25", "30", "--model", "a/b"],
		["recording", "maybe"],
		["settings", "--time", "pst"],
		["settings", "--cost", "usd", "--cost", "off"],
		["status", "--model", "github-copilot/gpt-6.1-sol"],
		["learn", "--time", "utc"],
		["import", "--model", "bad"],
		["import", "--sessions-dir"],
		["migrate", "now"],
	];
	for (const args of bad) {
		const r = cli(env, args);
		assert.equal(r.status, 2, args.join(" "));
		assert.match(r.stderr, /^Usage: /);
	}
	const none = cli(env, ["import"]);
	assert.equal(none.status, 1);
	assert.match(none.stderr, /no_targets/);
	assert.ok(!fs.existsSync(env.root), "no database or directory was created");
	for (const r of [cli(env, ["status"]), cli(env, ["learn"]), cli(env, ["settings"]), cli(env, ["recording", "off"]), cli(env, ["migrate"])]) assert.equal(r.status, 0);
	assert.ok(!fs.existsSync(env.root), "read-only commands and turning off create nothing");
});

test("a repository is a workspace even from a subdirectory; home and the agent dir are not, and the sessions dir follows its variable", async (t) => {
	const env = tmpEnv(t);
	const repo = path.join(env.dir, "repo");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
	await rejects(openCacheDb({ root: path.join(repo, ".agent", "cache-insights"), workspaceCwd: path.join(repo, "src", "deep"), create: true }), "unsafe_path");
	const plain = path.join(env.dir, "notes");
	fs.mkdirSync(plain);
	await rejects(openCacheDb({ root: path.join(plain, "ci"), agentDir: env.agentDir, workspaceCwd: plain, create: true }), "unsafe_path");

	// Running from home (even a version-controlled one) with the default agent dir works.
	const home = path.join(env.dir, "home");
	fs.mkdirSync(path.join(home, ".git"), { recursive: true });
	const childEnv = { ...process.env, HOME: home };
	delete childEnv.PI_CODING_AGENT_DIR;
	delete childEnv.PI_CODING_AGENT_SESSION_DIR;
	const r = spawnSync(process.execPath, [CLI, "seed", "github-copilot/gpt-6.1-sol", "25", "30"], { cwd: home, env: childEnv, encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	assert.ok(fs.existsSync(path.join(home, ".pi", "agent", "cache-insights", "cache-insights.sqlite")));
	const fromAgent = spawnSync(process.execPath, [CLI, "status", "--json"], { cwd: path.join(home, ".pi", "agent"), env: childEnv, encoding: "utf8" });
	assert.equal(fromAgent.status, 0, fromAgent.stderr);

	assert.equal(defaultSessionsDir({ PI_CODING_AGENT_DIR: "/x/agent" }), path.resolve("/x/agent/sessions"));
	assert.equal(defaultSessionsDir({ PI_CODING_AGENT_DIR: "/x/agent", PI_CODING_AGENT_SESSION_DIR: "/y/sessions" }), path.resolve("/y/sessions"));
	const s = new SessionFile({ tag: "elsewhere" });
	s.turn({ start: T0 - 10 * MIN });
	const elsewhere = path.join(env.dir, "custom-sessions");
	fs.mkdirSync(elsewhere);
	s.write(elsewhere);
	const imp = spawnSync(process.execPath, [CLI, "import", "--json"], { cwd: home, env: { ...childEnv, PI_CODING_AGENT_SESSION_DIR: elsewhere }, encoding: "utf8" });
	assert.equal(imp.status, 0, imp.stderr);
	assert.equal(JSON.parse(imp.stdout).summary.responses.added, 1, "imports the seeded model from PI_CODING_AGENT_SESSION_DIR");
});

test("settings, profiles, and the recording choice persist and are shared between connections", async (t) => {
	const env = tmpEnv(t);
	const a = await open(env, { create: true });
	const b = await open(env, { busyTimeoutMs: 50 });
	t.after(() => (a.close(), b.close()));
	assert.deepEqual(b.settings(), { time: "local", cost: "usd" });
	a.setSettings({ time: "utc", cost: "both" });
	a.setProfile({ provider: "github-copilot", model: "gpt-6.1-sol", hitMinutes: 25, expireMinutes: 30 });
	a.setRecording(true);
	assert.deepEqual(b.settings(), { time: "utc", cost: "both" });
	assert.equal(b.getProfile("github-copilot", "gpt-6.1-sol").expireOverMs, 30 * 60_000);
	assert.equal(b.getProfile("github-copilot", "gpt-6-astra"), null);
	assert.equal(b.isRecording(), true);
	assert.deepEqual(cli(env, ["settings"]).data.settings, { time: "utc", cost: "both" });
	for (const bad of [{ time: "pst" }, { cost: "eur" }]) assert.throws(() => a.setSettings(bad), CacheInsightsError);
	for (const [hit, expire] of [[0, 30], [31, 30], [25, 2000], [Number.NaN, 30]]) {
		assert.throws(() => a.setProfile({ provider: "p", model: "m", hitMinutes: hit, expireMinutes: expire }), (e) => e.code === "invalid_profile");
	}
	assert.throws(() => a.setProfile({ provider: "a/b", model: "m", hitMinutes: 1, expireMinutes: 2 }), (e) => e.code === "invalid_profile");

	const lock = new DatabaseSync(env.dbPath);
	lock.exec("BEGIN IMMEDIATE");
	assert.throws(() => b.setRecording(false), /locked|busy/i);
	lock.exec("COMMIT");
	lock.close();
	b.setRecording(false);
	assert.equal(a.isRecording(), false);
});

test("the storage boundary rejects unexpected fields and exposes no deletion", async (t) => {
	const env = tmpEnv(t);
	const db = await open(env, { create: true });
	t.after(() => db.close());
	const sample = { key: null, identity: "none", origin: "live", kind: "response", provider: "p", model: "m", api: null, responseModel: null, thinking: null, stopReason: "stop", requestStartMs: 1, endMs: 2, endProvenance: "unknown", usage: null };
	assert.equal(db.insertSample(sample), true);
	for (const bad of [{ ...sample, content: SENTINEL }, { ...sample, usage: { input: 1, note: SENTINEL } }, { ...sample, origin: SENTINEL }, { ...sample, endProvenance: "turn_end" }]) {
		assert.throws(
			() => db.insertSample(bad),
			(e) => e.code === "invalid_record" && !e.message.includes(SENTINEL),
		);
	}
	assert.equal(db.insertSample({ ...sample, provider: `${SENTINEL} with spaces` }), true);
	assert.ok(!dbBytes(env).includes(SENTINEL), "unsafe identifiers become unknown");
	for (const name of ["delete", "clear", "reset", "prune", "export", "deleteSamples"]) assert.equal(typeof db[name], "undefined", name);
});

test("without node:sqlite the feature reports a generic error, creates nothing, and leaves Pi alone", async (t) => {
	const env = tmpEnv(t);
	const loadSqlite = async () => {
		throw new Error(`No such built-in module ${SENTINEL}`);
	};
	await rejects(openCacheDb({ root: env.root, workspaceCwd: env.workspace, create: true, loadSqlite }), "unsupported");
	const h = loadExtension(t, env, { loadSqlite });
	await h.emit("session_start", { reason: "startup" });
	assert.deepEqual(await h.respond(), h.clock.w - 30_000);
	await h.command("seed github-copilot/gpt-6.1-sol 25 30");
	assert.match(h.lastNote(), /Cache insights stopped after a local problem \(unsupported\)\. Existing data was kept; see \/cache status\. The rest of Pi is unaffected\./);
	assert.equal(h.status(), "cache: error");
	await h.command("status");
	assert.match(h.lastNote(), /no built-in SQLite \(node:sqlite\)/);
	assert.ok(!JSON.stringify(h.notes).includes(SENTINEL));
	assert.ok(!fs.existsSync(env.root));
	await h.emit("session_shutdown", { reason: "quit" });
	assert.equal(h.status(), undefined);
});

test("the extension entry registers only /cache and hooks, opens nothing, and imports no Cursor or progress code", () => {
	const handlers = new Map();
	const commands = new Map();
	const realSetInterval = globalThis.setInterval;
	globalThis.setInterval = () => {
		throw new Error("timer started by the factory");
	};
	try {
		cacheInsights({ on: (e, fn) => handlers.set(e, fn), registerCommand: (n, o) => commands.set(n, o) });
	} finally {
		globalThis.setInterval = realSetInterval;
	}
	assert.deepEqual([...commands.keys()], ["cache"]);
	for (const hook of ["session_start", "session_shutdown", "session_tree", "session_compact", "model_select", "thinking_level_select", "before_agent_start", "message_start", "message_end", "agent_settled"]) assert.ok(handlers.has(hook), hook);
	const dir = path.join(REPO, "lib", "cache-insights");
	const sources = [fs.readFileSync(path.join(REPO, "extensions", "cache-insights", "index.ts"), "utf8"), ...fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8"))];
	for (const src of sources) {
		assert.ok(!/from "\.\.\/(index|worker-manager|acp-connection|permission-review|approvals|approval-history|state|config|profile)\.mjs"|progress-update/.test(src), "no Cursor or progress imports");
		assert.ok(!/streamSimple|sendMessage|sendUserMessage|appendEntry|setModel\(|setThinkingLevel|getApiKey|SessionManager\.\w+\(/.test(src), "no model requests, Pi state changes, or SessionManager calls");
	}
});
