// Feature-owned locations under the Pi agent dir, and the filesystem checks done before anything is opened.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CacheInsightsError } from "./util.mjs";

export const CACHE_ROOT_NAME = "cache-insights";
export const CACHE_DB_FILE = "cache-insights.sqlite";

function expandHome(dir) {
	if (dir === "~") return os.homedir();
	return dir?.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : dir;
}

export const defaultAgentDir = (env = process.env) => path.resolve(expandHome(env.PI_CODING_AGENT_DIR?.trim()) || path.join(os.homedir(), ".pi", "agent"));
export const defaultCacheRoot = (env = process.env) => path.join(defaultAgentDir(env), CACHE_ROOT_NAME);
export const defaultSessionsDir = (env = process.env) => path.resolve(expandHome(env.PI_CODING_AGENT_SESSION_DIR?.trim()) || path.join(defaultAgentDir(env), "sessions"));

/** realpath of the deepest existing ancestor, with the missing tail appended. */
export function canonicalExisting(p) {
	const abs = path.resolve(p);
	const tail = [];
	for (let d = abs; ; d = path.dirname(d)) {
		try {
			return path.join(fs.realpathSync(d), ...tail.reverse());
		} catch (err) {
			if (err.code !== "ENOENT" || path.dirname(d) === d) throw err;
			tail.push(path.basename(d));
		}
	}
}

export const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const uid = () => (typeof process.getuid === "function" ? process.getuid() : undefined);

/** lstat-based check: false when missing; throws for symlinks, wrong types, foreign owners, or hard links. */
export function checkEntry(p, type) {
	let st;
	try {
		st = fs.lstatSync(p);
	} catch (err) {
		if (err.code === "ENOENT") return false;
		throw new CacheInsightsError("io", `cannot inspect the cache-insights ${type}`);
	}
	if (st.isSymbolicLink()) throw new CacheInsightsError("unsafe_path", `refusing a symlinked cache-insights ${type}`);
	if (type === "directory" ? !st.isDirectory() : !st.isFile()) throw new CacheInsightsError("unsafe_path", `cache-insights ${type} path has the wrong type`);
	if (uid() !== undefined && st.uid !== uid()) throw new CacheInsightsError("unsafe_path", `cache-insights ${type} is not owned by the current user`);
	if (type === "file" && st.nlink !== 1) throw new CacheInsightsError("unsafe_path", "refusing a hard-linked cache-insights database");
	return true;
}

/** The nearest repository (.git) containing `cwd`, ignoring a version-controlled home directory or "/". */
function repositoryOf(cwd) {
	let home;
	try {
		home = fs.realpathSync(os.homedir());
	} catch {}
	for (let d = cwd; d !== home && path.dirname(d) !== d; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, ".git"))) return d;
	}
	return null;
}

/**
 * True when `root` lies in the current project: inside the repository containing `workspaceCwd`, or, outside a
 * repository, inside the cwd itself, unless the cwd contains the agent dir (home, "/", or the agent dir itself),
 * which is private agent data rather than a project.
 */
function insideWorkspace(root, workspaceCwd, agentDir) {
	const cwd = canonicalExisting(workspaceCwd);
	const repo = repositoryOf(cwd);
	if (repo) return within(root, repo);
	return within(root, cwd) && !within(canonicalExisting(agentDir), cwd);
}

/**
 * Resolves the database location without creating anything. Refuses a root inside the current workspace (see
 * insideWorkspace), and symlinked or foreign-owned entries. `agentDir` defaults to the root's parent.
 */
export function resolveCachePaths({ root, workspaceCwd, agentDir } = {}) {
	const given = path.resolve(root ?? defaultCacheRoot());
	const canonicalRoot = canonicalExisting(given);
	if (workspaceCwd && insideWorkspace(canonicalRoot, workspaceCwd, agentDir ?? path.dirname(given))) {
		throw new CacheInsightsError("unsafe_path", "refusing a cache-insights directory inside the current workspace");
	}
	const dbPath = path.join(canonicalRoot, CACHE_DB_FILE);
	checkEntry(given, "directory");
	checkEntry(dbPath, "file");
	return { root: canonicalRoot, dbPath };
}

export function createFiles(paths) {
	fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
	checkEntry(paths.root, "directory");
	fs.chmodSync(paths.root, 0o700);
	if (!checkEntry(paths.dbPath, "file")) {
		try {
			fs.closeSync(fs.openSync(paths.dbPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600));
		} catch (err) {
			if (err.code !== "EEXIST") throw err;
		}
		checkEntry(paths.dbPath, "file");
	}
	fs.chmodSync(paths.dbPath, 0o600);
}
