import os from "node:os";
import path from "node:path";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const REQUIRED_CONTEXT = "1m";
export const REQUIRED_FAST = "false";
export const ALLOWED_EFFORTS = Object.freeze(["high", "xhigh", "max"]);
export const DEFAULT_EFFORT = "high";
export const MODES = Object.freeze(["agent", "plan", "ask"]);
export const PERMISSION_POLICIES = Object.freeze(["review", "ask", "allow", "deny"]);
export const DEFAULT_PERMISSION_POLICY = "review";
export const REVIEW_PROFILES = Object.freeze(["task", "conservative"]);
export const DEFAULT_REVIEW_PROFILE = "task";
export const WORKER_NAME_RE = /^[A-Za-z0-9_-]{1,48}$/;

const MODEL_RE = /^[A-Za-z0-9._-]{1,80}$/;

export class ConfigError extends Error {
	constructor(message) {
		super(message);
		this.name = "ConfigError";
	}
}

/**
 * Required Cursor model profile. Only the model id and effort (high|xhigh|max) are user-configurable;
 * context=1m and fast=false are fixed so no caller can downgrade them.
 */
export function resolveProfile({ model, effort } = {}) {
	const m = model === undefined || model === "" ? DEFAULT_MODEL : String(model);
	if (!MODEL_RE.test(m)) throw new ConfigError(`PI_CURSOR_MODEL must match ${MODEL_RE}; got ${JSON.stringify(m)}`);
	const e = effort === undefined || effort === "" ? DEFAULT_EFFORT : String(effort);
	if (!ALLOWED_EFFORTS.includes(e)) {
		throw new ConfigError(`PI_CURSOR_EFFORT must be one of ${ALLOWED_EFFORTS.join("|")}; got ${JSON.stringify(e)}`);
	}
	return Object.freeze({ model: m, context: REQUIRED_CONTEXT, effort: e, fast: REQUIRED_FAST });
}

function positiveInt(env, name, fallback, max) {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0 || n > max) throw new ConfigError(`${name} must be an integer in 1..${max}; got ${JSON.stringify(raw)}`);
	return n;
}

export function defaultAgentDir(env = process.env) {
	if (env.PI_CODING_AGENT_DIR) return path.resolve(env.PI_CODING_AGENT_DIR);
	return path.join(os.homedir(), ".pi", "agent");
}

/** Read user-owned settings from the environment. Nothing here is controllable by tool arguments. */
export function configFromEnv(env = process.env, { agentDir } = {}) {
	const permissions = (env.PI_CURSOR_PERMISSIONS || DEFAULT_PERMISSION_POLICY).toLowerCase();
	if (!PERMISSION_POLICIES.includes(permissions)) {
		throw new ConfigError(`PI_CURSOR_PERMISSIONS must be one of ${PERMISSION_POLICIES.join("|")}; got ${JSON.stringify(env.PI_CURSOR_PERMISSIONS)}`);
	}
	const reviewProfile = (env.PI_CURSOR_REVIEW_PROFILE || DEFAULT_REVIEW_PROFILE).toLowerCase();
	if (!REVIEW_PROFILES.includes(reviewProfile)) {
		throw new ConfigError(`PI_CURSOR_REVIEW_PROFILE must be one of ${REVIEW_PROFILES.join("|")}; got ${JSON.stringify(env.PI_CURSOR_REVIEW_PROFILE)}`);
	}
	let args = ["acp"];
	if (env.PI_CURSOR_ARGS) {
		try {
			args = JSON.parse(env.PI_CURSOR_ARGS);
		} catch {
			throw new ConfigError("PI_CURSOR_ARGS must be a JSON array of strings");
		}
		if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
			throw new ConfigError("PI_CURSOR_ARGS must be a JSON array of strings");
		}
	}
	return {
		command: env.PI_CURSOR_COMMAND || "agent",
		args,
		stateDir: path.resolve(env.PI_CURSOR_STATE_DIR || path.join(agentDir || defaultAgentDir(env), "cursor-workers")),
		profile: resolveProfile({ model: env.PI_CURSOR_MODEL, effort: env.PI_CURSOR_EFFORT }),
		permissionPolicy: permissions,
		reviewProfile,
		maxWorkers: positiveInt(env, "PI_CURSOR_MAX_WORKERS", 4, 16),
		resultLimit: positiveInt(env, "PI_CURSOR_RESULT_CHARS", 12000, 200000),
		defaultTimeoutMs: positiveInt(env, "PI_CURSOR_TIMEOUT_SECONDS", 1800, 86400) * 1000,
		reviewTimeoutMs: positiveInt(env, "PI_CURSOR_REVIEW_TIMEOUT_SECONDS", 45, 120) * 1000,
	};
}

export function validateWorkerName(name) {
	if (typeof name !== "string" || !WORKER_NAME_RE.test(name)) {
		throw new ConfigError(`Invalid worker name ${JSON.stringify(name)}: use 1-48 characters from [A-Za-z0-9_-]`);
	}
	return name;
}
