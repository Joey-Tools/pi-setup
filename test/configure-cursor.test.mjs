import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "scripts", "configure-cursor.mjs");
const SECRET = "synthetic-test-token-not-a-real-credential";
const ORIGINAL = {
	version: 1,
	approvalMode: "allowlist",
	permissions: { allow: ["Shell(ls)", "Read(src/**)"], deny: ["Shell(rm)", "Read(**/.env)"] },
	sandbox: { mode: "disabled" },
	selectedModel: { modelId: "example" },
	authInfo: { email: "user@example.invalid", accessToken: SECRET },
};

const sandbox = (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "configure-cursor-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const home = path.join(root, "home");
	fs.mkdirSync(home);
	return { root, home, cursorDir: path.join(root, "cursor"), piDir: path.join(root, "pi-agent") };
};
const run = (args, vars) => {
	const env = { ...process.env };
	for (const k of ["CURSOR_CONFIG_DIR", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR"]) delete env[k];
	return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...env, ...vars } });
};
const writeConfig = (dir, value) => {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "cli-config.json");
	fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
	return file;
};
const mode = (p) => fs.statSync(p).mode & 0o777;
const backups = (piDir) => {
	const dir = path.join(piDir, "cursor-config-backups");
	return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => path.join(dir, f)) : [];
};

test("dry run reports the path and modes without writing or backing up", (t) => {
	const s = sandbox(t);
	const file = writeConfig(s.cursorDir, ORIGINAL);
	const before = fs.readFileSync(file);
	const r = run([], { HOME: s.home, CURSOR_CONFIG_DIR: s.cursorDir, PI_CODING_AGENT_DIR: s.piDir });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /current allowlist, target auto-review/);
	assert.match(r.stdout, /Dry run/);
	assert.match(r.stdout, /version-dependent/);
	assert.ok(r.stdout.includes(file));
	assert.ok(!(r.stdout + r.stderr).includes(SECRET));
	assert.deepEqual(fs.readFileSync(file), before);
	assert.equal(fs.existsSync(s.piDir), false);
});

test("--apply changes only approvalMode, keeps a private raw backup, and is idempotent", (t) => {
	const s = sandbox(t);
	const file = writeConfig(s.cursorDir, ORIGINAL);
	const before = fs.readFileSync(file);
	const vars = { HOME: s.home, CURSOR_CONFIG_DIR: s.cursorDir, PI_CODING_AGENT_DIR: s.piDir };
	const r = run(["--apply"], vars);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(!(r.stdout + r.stderr).includes(SECRET));
	assert.match(r.stdout, /do not commit or share/);

	const after = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.deepEqual(after, { ...ORIGINAL, approvalMode: "auto-review" });
	assert.deepEqual(after.permissions, ORIGINAL.permissions);
	assert.equal(mode(file), 0o600);

	const [backup, ...extra] = backups(s.piDir);
	assert.equal(extra.length, 0);
	assert.deepEqual(fs.readFileSync(backup), before);
	assert.equal(mode(backup), 0o600);
	assert.equal(mode(path.dirname(backup)), 0o700);

	const written = fs.readFileSync(file);
	const again = run(["--apply"], vars);
	assert.equal(again.status, 0, again.stderr);
	assert.match(again.stdout, /Already set/);
	assert.deepEqual(fs.readFileSync(file), written);
	assert.equal(backups(s.piDir).length, 1);
});

test("malformed JSON and non-object roots fail closed", (t) => {
	for (const body of ["{ not json", "[1, 2]", "null"]) {
		const s = sandbox(t);
		const file = writeConfig(s.cursorDir, body);
		const r = run(["--apply"], { HOME: s.home, CURSOR_CONFIG_DIR: s.cursorDir, PI_CODING_AGENT_DIR: s.piDir });
		assert.equal(r.status, 1, body);
		assert.match(r.stderr, /nothing changed/);
		assert.equal(fs.readFileSync(file, "utf8"), body);
		assert.equal(fs.existsSync(s.piDir), false);
	}
});

test("uses $XDG_CONFIG_HOME/cursor and writes through a symlinked config", (t) => {
	const s = sandbox(t);
	const real = writeConfig(path.join(s.root, "dotfiles"), ORIGINAL);
	const xdgCursor = path.join(s.root, "xdg", "cursor");
	fs.mkdirSync(xdgCursor, { recursive: true });
	const link = path.join(xdgCursor, "cli-config.json");
	fs.symlinkSync(real, link);
	const r = run(["--apply"], { HOME: s.home, XDG_CONFIG_HOME: path.join(s.root, "xdg"), PI_CODING_AGENT_DIR: s.piDir });
	assert.equal(r.status, 0, r.stderr);
	assert.ok(fs.lstatSync(link).isSymbolicLink());
	assert.equal(JSON.parse(fs.readFileSync(real, "utf8")).approvalMode, "auto-review");
	assert.equal(backups(s.piDir).length, 1);
});

test("missing config under ~/.cursor gets only approvalMode in a private new directory", (t) => {
	const s = sandbox(t);
	const r = run(["--apply"], { HOME: s.home });
	assert.equal(r.status, 0, r.stderr);
	const dir = path.join(s.home, ".cursor");
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "cli-config.json"), "utf8")), { approvalMode: "auto-review" });
	assert.equal(mode(dir), 0o700);
	assert.equal(mode(path.join(dir, "cli-config.json")), 0o600);
	assert.equal(fs.existsSync(path.join(s.home, ".pi")), false);
});

test("rejects unknown arguments and backup directories next to the Cursor config", (t) => {
	const s = sandbox(t);
	const file = writeConfig(s.cursorDir, ORIGINAL);
	const before = fs.readFileSync(file);
	const bad = run(["--force"], { HOME: s.home, CURSOR_CONFIG_DIR: s.cursorDir, PI_CODING_AGENT_DIR: s.piDir });
	assert.equal(bad.status, 2);
	assert.match(bad.stderr, /unknown argument/);
	const nested = run(["--apply"], { HOME: s.home, CURSOR_CONFIG_DIR: s.cursorDir, PI_CODING_AGENT_DIR: s.cursorDir });
	assert.equal(nested.status, 1);
	assert.match(nested.stderr, /refusing backup directory/);
	assert.deepEqual(fs.readFileSync(file), before);
	assert.equal(fs.existsSync(s.piDir), false);
});
