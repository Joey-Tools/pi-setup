// Opt-in live smoke test against the real Cursor CLI. Not part of `npm test`.
// Uses a throwaway empty cwd and state dir, ask mode, and denies all tool permissions; it makes no edits.
// Proves: explicit profile is applied/verified, two turns share memory, and a fresh process resumes via session/load.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configFromEnv, verifyProfile, WorkerManager } from "../lib/index.mjs";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-cursor-smoke-")));
const cwd = path.join(root, "cwd");
fs.mkdirSync(cwd);
const config = configFromEnv({ ...process.env, PI_CURSOR_STATE_DIR: path.join(root, "state"), PI_CURSOR_PERMISSIONS: "deny" });
const make = () => new WorkerManager({ ...config, projectCwd: cwd, piSessionId: "live-smoke", defaultTimeoutMs: 300000 });
const word = `kiwi-${randomBytes(3).toString("hex")}`;
const step = (msg) => console.log(`[smoke] ${msg}`);

function lastConfig(eventsPath) {
	let config;
	for (const line of fs.readFileSync(eventsPath, "utf8").split("\n")) {
		if (!line) continue;
		const e = JSON.parse(line);
		if (e.dir === "recv" && Array.isArray(e.msg?.result?.configOptions)) config = e.msg.result.configOptions;
	}
	return config;
}

let ok = false;
let m = make();
try {
	step(`profile ${JSON.stringify(config.profile)}; command ${config.command} ${config.args.join(" ")}`);
	const r1 = await m.run({ name: "smoke", task: `Remember this word for later: ${word}. Do not use any tools. Reply with only: OK`, mode: "ask" });
	const mismatches = verifyProfile(lastConfig(r1.details.eventsPath), config.profile);
	if (mismatches.length) throw new Error(`profile not verified in event log: ${mismatches.join("; ")}`);
	step(`turn 1 ok (session ${r1.details.sessionId}): ${r1.text.split("\n").at(-3)}`);
	const r2 = await m.run({ name: "smoke", task: "What word did I ask you to remember? Do not use any tools. Reply with only the word." });
	if (!r2.text.includes(word)) throw new Error(`turn 2 did not recall ${word}:\n${r2.text}`);
	step("turn 2 recalled the word in the same process");
	await m.shutdown();
	m = make();
	const r3 = await m.run({ name: "smoke", task: "Repeat the word I asked you to remember, once more. Do not use any tools. Reply with only the word." });
	if (!r3.text.includes(word)) throw new Error(`resumed turn did not recall ${word}:\n${r3.text}`);
	if (r3.details.sessionId !== r1.details.sessionId) throw new Error("resumed run used a different session");
	const loaded = fs.readFileSync(r3.details.eventsPath, "utf8").includes('"method":"session/load"');
	if (!loaded) throw new Error("resumed run did not use session/load");
	const replayLeak = fs.readFileSync(r3.details.resultPath, "utf8").includes("OK");
	step(`turn 3 recalled the word after session/load in a new process${replayLeak ? " (warning: result contains OK)" : ""}`);
	ok = true;
} catch (err) {
	console.error(`[smoke] FAILED: ${err.message}`);
} finally {
	await m.shutdown();
	if (ok) fs.rmSync(root, { recursive: true, force: true });
	else console.error(`[smoke] artifacts kept in ${root}`);
}
step(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
