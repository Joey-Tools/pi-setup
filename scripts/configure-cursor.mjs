// Set Cursor CLI `approvalMode` to "auto-review" in cli-config.json. Dry run unless --apply.
// Only that one field changes; permissions, sandbox, model, and auth fields are preserved.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TARGET = "auto-review";
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fail = (msg, code = 1) => {
	process.stderr.write(`configure-cursor: ${msg}\n`);
	process.exit(code);
};
const inside = (child, parent) => {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const realish = (p) => {
	let cur = path.resolve(p);
	const rest = [];
	while (!fs.existsSync(cur) && path.dirname(cur) !== cur) {
		rest.unshift(path.basename(cur));
		cur = path.dirname(cur);
	}
	return path.join(fs.realpathSync(cur), ...rest);
};

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== "--apply");
if (unknown.length || args.length > 1) fail(`unknown argument(s): ${unknown.join(" ") || args.join(" ")}\nusage: node scripts/configure-cursor.mjs [--apply]`, 2);
const apply = args[0] === "--apply";

// Same precedence as the Cursor CLI: CURSOR_CONFIG_DIR, then $XDG_CONFIG_HOME/cursor, then ~/.cursor.
const env = process.env;
const configDir = env.CURSOR_CONFIG_DIR?.trim() ? env.CURSOR_CONFIG_DIR : env.XDG_CONFIG_HOME?.trim() ? path.join(env.XDG_CONFIG_HOME, "cursor") : path.join(os.homedir(), ".cursor");
const configPath = path.join(configDir, "cli-config.json");
const exists = fs.existsSync(configPath);
const target = exists ? fs.realpathSync(configPath) : configPath;
const backupDir = path.join(env.PI_CODING_AGENT_DIR?.trim() ? env.PI_CODING_AGENT_DIR : path.join(os.homedir(), ".pi", "agent"), "cursor-config-backups");
const realBackupDir = realish(backupDir);
for (const forbidden of [repoRoot, configDir, path.dirname(target)]) {
	if (inside(realBackupDir, realish(forbidden))) fail(`refusing backup directory ${backupDir}: it is inside ${forbidden}`);
}

let original = null;
let config = {};
if (exists) {
	original = fs.readFileSync(target);
	try {
		config = JSON.parse(original.toString("utf8"));
	} catch {
		fail(`${target} is not valid JSON; nothing changed`);
	}
	if (!config || typeof config !== "object" || Array.isArray(config)) fail(`${target} does not contain a JSON object; nothing changed`);
}
const current = Object.hasOwn(config, "approvalMode") ? String(config.approvalMode) : "(unset)";

console.log(`Cursor CLI config: ${configPath}${target !== configPath ? ` -> ${target}` : ""}${exists ? "" : " (missing)"}`);
console.log(`approvalMode: current ${current}, target ${TARGET}`);
const notes = () => {
	console.log("Only approvalMode is changed. permissions.allow/deny, sandbox, model, and auth fields are not edited, and no Shell allowlist is added.");
	console.log("Note: native Auto-review is a Cursor server classifier for the standalone Cursor CLI (`agent`). Whether `agent acp` honors it is version-dependent; Cursor CLI 2026.10.22 does not enable it over ACP. Approval requests that do reach ACP are handled by Pi's review mode.");
	console.log("Auto-review is a model judgment: it does not prove that arbitrary commands are read-only.");
};
if (current === TARGET) {
	console.log("Already set; nothing to do (no backup, no write).");
	notes();
	process.exit(0);
}
if (!apply) {
	console.log(`Dry run: no files changed. Re-run with --apply to write approvalMode=${TARGET}${exists ? ` after a private backup under ${backupDir}` : ""}.`);
	notes();
	process.exit(0);
}

config.approvalMode = TARGET;
const indent = original?.toString("utf8").match(/^([ \t]+)"/m)?.[1] ?? "  ";
const trailing = original === null || original.toString("utf8").endsWith("\n") ? "\n" : "";
const next = JSON.stringify(config, null, indent) + trailing;

let backupPath = null;
if (exists) {
	if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
	if (fs.statSync(backupDir).mode & 0o077) fail(`backup directory ${backupDir} is accessible by other users; fix its permissions (chmod 700) and retry`);
	backupPath = path.join(backupDir, `cli-config.${new Date().toISOString().replace(/[:.]/g, "-")}.${process.pid}.json`);
	fs.writeFileSync(backupPath, original, { flag: "wx", mode: 0o600 });
} else {
	fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
}

const tmp = path.join(path.dirname(target), `.cli-config.json.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
const fd = fs.openSync(tmp, "wx", 0o600);
try {
	fs.writeFileSync(fd, next);
	fs.fsyncSync(fd);
} finally {
	fs.closeSync(fd);
}
const unchanged = exists ? fs.existsSync(target) && fs.readFileSync(target).equals(original) : !fs.existsSync(target);
if (!unchanged) {
	fs.rmSync(tmp, { force: true });
	fail(`${target} changed while this script was running; nothing written${backupPath ? ` (backup kept at ${backupPath})` : ""}`);
}
fs.renameSync(tmp, target);

console.log(`Wrote approvalMode=${TARGET} to ${target} (mode 0600).`);
if (backupPath) console.log(`Backup of the original bytes: ${backupPath} (mode 0600). It may contain credentials: keep it local and do not commit or share it.`);
notes();
