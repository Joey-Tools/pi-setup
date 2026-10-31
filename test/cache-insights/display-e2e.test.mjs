// Footer styling with the current Pi theme, and what "local time" means (TZ / OS default), through public flows.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { cli, loadExtension, MIN, REPO, SessionFile, SOL, T0, tmpEnv } from "./harness.mjs";

const recorder = (tag) => ({ fg: (token, text) => `<${tag}:${token}>${text}</${tag}>` });
const flat = { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 };

function seeded(t, time = "utc") {
	const env = tmpEnv(t);
	const s = new SessionFile({ tag: "display" });
	s.turn({ start: T0 - 10 * MIN, dur: 60_000 });
	s.write(env.sessionsDir);
	assert.equal(cli(env, ["seed", "github-copilot/gpt-6.1-sol", "25", "30"]).status, 0);
	assert.equal(cli(env, ["settings", "--time", time, "--cost", "usd"]).status, 0);
	return { env, s };
}

test("the footer is dim; only the expired label uses the cache-miss warning colour, from the theme current at each refresh", async (t) => {
	const { env, s } = seeded(t);
	const h = loadExtension(t, env, { branch: s.branch(), model: { ...SOL, cost: flat }, theme: recorder("a") });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.status(), "<a:dim>cache hit · until 12:15 UTC · miss ≈$0.021</a>");
	h.at(T0 + 16 * MIN);
	assert.equal(await h.tick(), "<a:dim>uncertain · expired after 12:21 UTC · miss ≈$0.021</a>");
	h.at(T0 + 22 * MIN);
	assert.equal(await h.tick(), "<a:warning>cache expired</a><a:dim> · ≈$0.021</a>", "only the label stands out, not the cost");
	h.ctx.ui.theme = recorder("b");
	h.advance(MIN);
	assert.equal(await h.tick(), "<b:warning>cache expired</b><b:dim> · ≈$0.021</b>", "a theme change applies at the next refresh");
	await h.command("status");
	assert.ok(!/<[ab]:/.test(h.lastNote()), "command text stays plain");

	for (const broken of [{ fg: () => 42 }, { fg: () => { throw new Error("theme"); } }, { fg: "nope" }]) {
		h.ctx.ui.theme = broken;
		h.advance(MIN);
		assert.equal(await h.tick(), "cache expired · ≈$0.021", "a missing or broken theme falls back to plain text");
	}
	Object.defineProperty(h.ctx.ui, "theme", { get() { throw new Error("theme getter"); }, configurable: true });
	h.advance(MIN);
	assert.equal(await h.tick(), "cache expired · ≈$0.021");
	assert.ok(!h.notes.some(([, m]) => /local problem/.test(m)), "theme problems never disable the feature");
});

test("error and upgrade states stay quiet (dim)", async (t) => {
	const env = tmpEnv(t);
	const h = loadExtension(t, env, { theme: recorder("a"), loadSqlite: async () => { throw new Error("no sqlite"); } });
	await h.emit("session_start", { reason: "startup" });
	await h.command("seed github-copilot/gpt-6.1-sol 25 30");
	assert.equal(h.status(), "<a:dim>cache: error</a>");
});

/** Runs the public extension in a child process with a fixed TZ; returns its footer and /cache settings text. */
function underTZ(env, branchFile, tz, now = T0) {
	const code = `
		const { registerCacheInsights } = await import(process.env.CI_LIB);
		const handlers = new Map(), commands = new Map(), statuses = [], notes = [];
		const pi = { on: (e, fn) => handlers.set(e, fn), registerCommand: (n, o) => commands.set(n, o), getThinkingLevel: () => "high" };
		const noop = () => ({ unref() {} });
		registerCacheInsights(pi, { root: process.env.CI_ROOT, clock: { wall: () => Number(process.env.CI_T0), mono: () => 1000 }, timers: { setInterval: noop, clearInterval() {}, setTimeout: noop, clearTimeout() {} }, resolveBaseline: () => ({ status: "unchanged" }) });
		const branch = JSON.parse((await import("node:fs")).readFileSync(process.env.CI_BRANCH, "utf8"));
		const ctx = { mode: "tui", hasUI: true, cwd: process.env.CI_CWD, model: { provider: "github-copilot", id: "gpt-6.1-sol" }, ui: { setStatus: (k, t) => statuses.push(t), notify: (m) => notes.push(m) }, sessionManager: { getBranch: () => branch } };
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		await commands.get("cache").handler("settings", { ...ctx, mode: "rpc" });
		await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
		console.log(JSON.stringify({ status: statuses.filter((s) => s !== undefined).at(-1), settings: notes.at(-1) }));`;
	const childEnv = { ...process.env, TZ: tz, CI_LIB: path.join(REPO, "lib", "cache-insights", "index.mjs"), CI_ROOT: env.root, CI_T0: String(now), CI_BRANCH: branchFile, CI_CWD: env.workspace };
	const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: env.workspace, env: childEnv, encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

test("status clocks always carry their zone: UTC mode, and local offsets of the shown deadline (DST-correct)", async (t) => {
	const { env } = seeded(t, "local");
	/** A branch whose latest response started 10 minutes before `now`; the 25-minute hit deadline is now + 15 min. */
	const branchAt = (now, tag) => {
		const s = new SessionFile({ tag });
		s.turn({ start: now - 10 * MIN, dur: 60_000 });
		const file = path.join(env.dir, `branch-${tag}.json`);
		fs.writeFileSync(file, JSON.stringify(s.branch()));
		return file;
	};
	const october = branchAt(T0, "oct");
	const january = Date.UTC(2026, 0, 15, 12, 0, 0);
	const jan = branchAt(january, "jan");
	const local = (file, tz, now) => underTZ(env, file, tz, now).status;
	assert.equal(local(october, "UTC", T0), "cache hit · until 12:15 UTC");
	assert.equal(local(october, "Asia/Tokyo", T0), "cache hit · until 21:15 UTC+9");
	assert.equal(local(october, "Asia/Kolkata", T0), "cache hit · until 17:45 UTC+5:30");
	assert.equal(local(october, "America/St_Johns", T0), "cache hit · until 09:45 UTC-2:30", "negative fractional offsets keep two-digit minutes");
	assert.equal(local(october, "America/New_York", T0), "cache hit · until 08:15 UTC-4", "New York summer time");
	assert.equal(local(jan, "America/New_York", january), "cache hit · until 07:15 UTC-5", "New York winter time");

	// New York falls back at 06:00 UTC on 2026-11-01: now (05:50 UTC) is 01:50 UTC-4, the deadline (06:05 UTC) is 01:05 UTC-5.
	const fallBack = Date.UTC(2026, 10, 1, 5, 50, 0);
	assert.equal(local(branchAt(fallBack, "dst"), "America/New_York", fallBack), "cache hit · until 01:05 UTC-5", "the offset is the deadline's, not now's");

	const tokyo = underTZ(env, october, "Asia/Tokyo");
	assert.match(tokyo.settings, /Local time zone: Asia\/Tokyo \(UTC\+09:00\), set by the TZ environment variable; the \/cache settings menu in the TUI has a timezone guide\./);
	assert.match(underTZ(env, october, "UTC").settings, /Local time zone: (Etc\/)?UTC \(UTC\+00:00\), set by the TZ environment variable/);

	assert.equal(cli(env, ["settings", "--time", "utc"]).status, 0);
	for (const tz of ["Asia/Tokyo", "America/New_York", "Asia/Kolkata"]) assert.equal(local(october, tz, T0), "cache hit · until 12:15 UTC", `UTC mode ignores TZ=${tz}`);
	assert.deepEqual(cli(env, ["settings"]).data.settings, { time: "utc", cost: "usd", auto: "on" }, "CLI settings API unchanged (automatic profiles default on, unsaved)");
});

test("the settings menu explains local time and opens a read-only guide; Back changes nothing", async (t) => {
	const env = tmpEnv(t);
	const h = loadExtension(t, env);
	h.script({ select: ["Local timezone guide", "Back"] });
	await h.command("settings");
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	assert.ok(h.selects[0].title.startsWith(`Display settings · local time zone: ${zone} (UTC`), h.selects[0].title);
	assert.equal(h.editors[0].title, "Local timezone guide (read-only; edits are ignored)");
	const guide = h.editors[0].text;
	for (const line of [`this Pi process's time zone: ${zone}`, "Your terminal app's own clock", "Date & Time settings", "TZ=Asia/Tokyo pi", "TZ=Europe/London pi", "$env:TZ='Asia/Tokyo'; pi", "export TZ=Asia/Tokyo", "Nothing is edited automatically", "unset TZ, then restart Pi", "/cache settings time utc"]) {
		assert.ok(guide.includes(line), line);
	}
	assert.equal(h.selects.length, 2, "the guide returns to the settings menu");
	assert.ok(!fs.existsSync(env.root), "browsing the guide creates nothing");

	const { env: stored } = seeded(t, "local");
	const g = loadExtension(t, stored);
	g.script({ select: ["Local timezone guide", "Back"] });
	await g.command("settings");
	assert.deepEqual(cli(stored, ["settings"]).data.settings, { time: "local", cost: "usd", auto: "on" }, "stored settings unchanged");
});
