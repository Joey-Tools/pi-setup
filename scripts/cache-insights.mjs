#!/usr/bin/env node
// Cache-insights CLI for local setup: seed a profile, import session metadata, inspect, and change settings.
// Every argument is validated before anything is opened. Writes only the feature's own database, only for write
// commands, and never touches Pi settings.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "lib", "cache-insights");
const ci = await import(pathToFileURL(path.join(dir, "index.mjs")).href);
const { importText, learnText } = await import(pathToFileURL(path.join(dir, "format.mjs")).href);

const USAGE = `Usage: node scripts/cache-insights.mjs <command> [options]
Commands:
  status                                      database, recording, settings, profiles, counts
  seed <provider/model> <hitMinutes> <expireMinutes>
                                              set the active profile for exactly that model
  import [--model provider/model]... [--sessions-dir DIR]
                                              metadata-only import of Pi session files; without --model,
                                              imports the models that have a seeded profile
  learn [--model provider/model]              observed candidate envelopes and evidence so far
                                              (never changes profiles or forecasts)
  recording on|off                            save whether live responses are recorded
  settings [--time local|utc] [--cost off|usd|credits|both] [--auto on|off]
                                              --auto: automatic, provisional profiles for models
                                              without a seed (derived, never stored; default on)
  migrate                                     upgrade an older cache-insights database in place
Options (any command):
  --agent-dir DIR   Pi agent dir (default: PI_CODING_AGENT_DIR or ~/.pi/agent)
  --root DIR        cache-insights dir (default: <agent dir>/cache-insights)
  --json            JSON output`;

const COMMANDS = {
	status: { args: 0, flags: [] },
	seed: { args: 3, flags: [] },
	import: { args: 0, flags: ["--model", "--sessions-dir"] },
	learn: { args: 0, flags: ["--model"] },
	recording: { args: 1, flags: [] },
	settings: { args: 0, flags: ["--time", "--cost", "--auto"] },
	migrate: { args: 0, flags: [] },
};
const GLOBAL_FLAGS = ["--agent-dir", "--root"];

class UsageError extends Error {}
const usage = () => new UsageError("usage");

/** Parses and validates everything; returns a plan. Touches no files. */
function plan(argv) {
	if (argv.includes("-h") || argv.includes("--help")) return { help: true };
	const positional = [];
	const flags = new Map();
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--json") json = true;
		else if (a.startsWith("-")) {
			const value = argv[++i];
			if (value === undefined || value === "" || value.startsWith("--")) throw usage();
			if (!flags.has(a)) flags.set(a, []);
			flags.get(a).push(value);
		} else positional.push(a);
	}
	const [command, ...args] = positional;
	const spec = COMMANDS[command];
	if (!spec || args.length !== spec.args) throw usage();
	for (const [flag, values] of flags) {
		if (!GLOBAL_FLAGS.includes(flag) && !spec.flags.includes(flag)) throw usage();
		if (flag !== "--model" && values.length > 1) throw usage();
	}
	const one = (f) => flags.get(f)?.[0];
	const models = flags.get("--model") ?? [];
	if (!models.every((m) => ci.parseModelRef(m))) throw usage();
	const p = { command, json, agentDir: one("--agent-dir"), root: one("--root"), sessionsDir: one("--sessions-dir"), models };
	if (command === "seed") {
		const ref = ci.parseModelRef(args[0]);
		const hit = ci.parseMinutes(args[1]);
		const expire = ci.parseMinutes(args[2]);
		if (!ref || !(hit > 0 && hit <= expire && expire <= ci.MAX_PROFILE_MINUTES)) throw usage();
		Object.assign(p, { ref, hit, expire });
	}
	if (command === "learn" && models.length > 1) throw usage();
	if (command === "recording") {
		if (!["on", "off"].includes(args[0])) throw usage();
		p.on = args[0] === "on";
	}
	if (command === "settings") {
		p.time = one("--time");
		p.cost = one("--cost");
		p.auto = one("--auto");
		if ((p.time !== undefined && !ci.TIME_SETTINGS.includes(p.time)) || (p.cost !== undefined && !ci.COST_SETTINGS.includes(p.cost)) || (p.auto !== undefined && !ci.AUTO_SETTINGS.includes(p.auto))) throw usage();
	}
	return p;
}

async function run(p) {
	const env = p.agentDir ? { ...process.env, PI_CODING_AGENT_DIR: p.agentDir } : process.env;
	const agentDir = ci.defaultAgentDir(env);
	const open = (create, upgrade = create) => ci.openCacheDb({ root: p.root ?? path.join(agentDir, "cache-insights"), agentDir, workspaceCwd: process.cwd(), create, upgrade });
	const out = (text, json) => console.log(p.json ? JSON.stringify(json, null, 2) : text);
	const notSetUp = () => (out("Cache insights are not set up (no database). Use: seed, import --model, or recording on.", { setUp: false }), 0);
	let db = null;
	try {
		switch (p.command) {
			case "status": {
				db = await open(false);
				if (!db) return notSetUp();
				const settings = db.settings();
				// `profiles` are the stored (manual) seeds only; `effectiveProfiles` adds automatic ones, which are never stored.
				const effectiveProfiles = ci
					.evidenceReport(db, {})
					.evidence.filter((e) => e.effectiveProfile)
					.map((e) => ({ provider: e.provider, model: e.model, kind: e.effective, hitUnderMs: e.effectiveProfile.hitUnderMs, expireOverMs: e.effectiveProfile.expireOverMs, source: e.effectiveProfile.source }));
				const json = { setUp: true, schemaVersion: db.schemaVersion, recording: db.isRecording(), settings, counts: db.counts(), profiles: db.listProfiles(), effectiveProfiles, autoPolicy: ci.AUTO_POLICY };
				const profiles = json.profiles.map((x) => `  ${x.provider}/${x.model}: hit < ${x.hitUnderMs / 60000} min, expired > ${x.expireOverMs / 60000} min (${x.source})`);
				const autos = effectiveProfiles.filter((x) => x.kind === "auto").map((x) => `  ${x.provider}/${x.model}: hit < ${(x.hitUnderMs / 60000).toFixed(1)} min, expired > ${(x.expireOverMs / 60000).toFixed(1)} min (automatic, provisional; not stored)`);
				out(
					[
						`Database: ${db.paths.dbPath} (schema ${json.schemaVersion})`,
						`Recording: ${json.recording ? "on" : "off"}; time ${settings.time}; cost ${settings.cost}; automatic profiles ${settings.auto}`,
						`Samples: ${json.counts.samples} (${json.counts.historical} historical, ${json.counts.live} live); pairs: ${json.counts.pairs}`,
						"Profiles:",
						...(profiles.length ? profiles : ["  none"]),
						...(autos.length ? ["Automatic profiles in use:", ...autos] : []),
					].join("\n"),
					json,
				);
				return 0;
			}
			case "seed": {
				db = await open(true);
				const x = db.setProfile({ provider: p.ref.provider, model: p.ref.model, hitMinutes: p.hit, expireMinutes: p.expire });
				out(`Active profile set for ${x.provider}/${x.model}: hit < ${x.hitUnderMs / 60000} min, expired > ${x.expireOverMs / 60000} min (seeded, provisional).`, { profile: x });
				return 0;
			}
			case "import": {
				let targets = p.models;
				db = await open(targets.length > 0, true);
				if (!targets.length) targets = (db?.listProfiles() ?? []).map((x) => `${x.provider}/${x.model}`);
				if (!targets.length) throw new ci.CacheInsightsError("no_targets", "nothing to import: seed a profile first or pass --model provider/model");
				const summary = await ci.importHistory(db, { sessionsDir: p.sessionsDir ?? ci.defaultSessionsDir(env), targets });
				out(importText(summary), { targets, summary });
				return 0;
			}
			case "learn": {
				db = await open(false);
				if (!db) return notSetUp();
				const ref = p.models[0] ? ci.parseModelRef(p.models[0]) : {};
				const report = ci.evidenceReport(db, ref);
				out(learnText(report, { time: db.settings().time, recording: db.isRecording() }), { envelopes: report.envelopes, profiles: db.listProfiles(), evidence: report.evidence, autoPolicy: ci.AUTO_POLICY });
				return 0;
			}
			case "recording": {
				db = await open(p.on, true);
				if (!db) return notSetUp();
				db.setRecording(p.on);
				out(`Recording ${p.on ? "on" : "off"} (saved).`, { recording: p.on });
				return 0;
			}
			case "settings": {
				const change = p.time !== undefined || p.cost !== undefined || p.auto !== undefined;
				db = await open(change);
				if (!db) return notSetUp();
				const s = change ? db.setSettings({ time: p.time, cost: p.cost, auto: p.auto }) : db.settings();
				out(`Settings: time ${s.time}, cost ${s.cost}, automatic profiles ${s.auto}.`, { settings: s });
				return 0;
			}
			case "migrate": {
				db = await open(false, true);
				if (!db) return notSetUp();
				out(`Cache-insights database is at schema ${db.schemaVersion}.`, { schemaVersion: db.schemaVersion });
				return 0;
			}
		}
	} finally {
		db?.close();
	}
}

try {
	const p = plan(process.argv.slice(2));
	if (p.help) console.log(USAGE);
	else process.exitCode = await run(p);
} catch (err) {
	if (err instanceof UsageError) {
		console.error(USAGE);
		process.exitCode = 2;
	} else if (err instanceof ci.CacheInsightsError) {
		console.error(`cache-insights: ${err.code}: ${err.message}`);
		process.exitCode = 1;
	} else {
		console.error("cache-insights: unexpected error; nothing else was changed.");
		process.exitCode = 1;
	}
}
