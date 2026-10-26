import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProfile, WorkerManager } from "../lib/index.mjs";

export const FAKE = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));

/** Isolated temp project, state dir, and fake-agent config/log for one test. */
export function setup(t, fakeConfig = {}) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-cursor-test-")));
	const projectDir = path.join(root, "project");
	fs.mkdirSync(path.join(projectDir, "sub"), { recursive: true });
	const env = {
		root,
		projectDir,
		stateDir: path.join(root, "state"),
		logFile: path.join(root, "fake.log"),
		fakeStateDir: path.join(root, "fake-sessions"),
		managers: [],
	};
	env.fake = { logFile: env.logFile, stateDir: env.fakeStateDir, ...fakeConfig };
	env.manager = (overrides = {}) => {
		const { fake, ...rest } = overrides;
		const m = new WorkerManager({
			stateDir: env.stateDir,
			projectCwd: projectDir,
			piSessionId: "pi-session-1",
			command: process.execPath,
			args: [FAKE],
			env: { ...process.env, FAKE_ACP_CONFIG: JSON.stringify({ ...env.fake, ...fake }) },
			profile: resolveProfile(),
			permissionPolicy: "deny",
			rpcTimeoutMs: 5000,
			cancelGraceMs: 1000,
			killGraceMs: 500,
			...rest,
		});
		env.managers.push(m);
		return m;
	};
	env.log = () => {
		try {
			return fs.readFileSync(env.logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
		} catch {
			return [];
		}
	};
	env.methods = () => env.log().filter((e) => e.method).map((e) => e.method);
	t.after(async () => {
		await Promise.all(env.managers.map((m) => m.shutdown()));
		fs.rmSync(root, { recursive: true, force: true });
	});
	return env;
}

export function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
