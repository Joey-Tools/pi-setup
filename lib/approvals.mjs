// Private, project-scoped permission history and the user's exact allow/block rules. Everything lives under
// <stateDir>/<project>/approvals/ (dirs 0700, files 0600), outside the repo. Records, payloads, rules, claims, and
// revocations are immutable per-id files written with an exclusive link, so concurrent workers and Pi processes never
// lose each other's updates and a once-rule can be claimed only once. Reads that fail or find corrupt data fail closed.
import { createHash, randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir, projectKey, writeJsonAtomic } from "./state.mjs";

export const APPROVALS_VERSION = 1;
export const RULE_SCOPES = Object.freeze(["once", "task", "project"]);
/** The full ACP request is stored only up to this size; a larger one makes the record incomplete. */
export const MAX_PAYLOAD_CHARS = 512 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_RULES_PER_ACTION = 200;
const MAX_RULES_LISTED = 1000;
const MAX_OBSERVED = 300;
const PREVIEW_CHARS = 1000;

export const DECISION_NOTE = "This is Pi's intended permission decision only. The reply actually prepared for Cursor is recorded separately; neither shows whether Cursor ran the action or whether it succeeded.";
export const RESPONSE_NOTE =
	"The reply Pi prepared for Cursor, written just before it was handed to the ACP connection. It does not prove that Cursor received it, ran the action, or that the action succeeded.";
export const NO_RESPONSE_NOTE = "No reply record: this reply is not known to have been sent (for example the history write failed, or Pi stopped first).";
export const OBSERVED_NOTE =
	"Cursor-observed, NOT Pi-reviewed: Cursor reported these tool calls without asking Pi for permission. Pi cannot block them here or retroactively; control them with Cursor's own permission configuration. Statuses are only what Cursor reported.";

const ID_RE = /^[dr]-[0-9a-z]{9}-[0-9a-f]{8}$/;
const FP_RE = /^[0-9a-f]{64}$/;
const RUN_RE = /^[A-Za-z0-9_.-]{1,160}$/;
const sha = (text) => createHash("sha256").update(text).digest("hex");

export class ApprovalStoreError extends Error {
	constructor(message) {
		super(message);
		this.name = "ApprovalStoreError";
	}
}

function canon(value) {
	if (Array.isArray(value)) return value.map(canon);
	if (value && typeof value === "object") {
		const out = Object.create(null);
		for (const key of Object.keys(value).sort()) out[key] = canon(value[key]);
		return out;
	}
	return value;
}

/** JSON with sorted object keys; strings, numbers, and array order are kept exactly. */
export function stableStringify(value) {
	return JSON.stringify(canon(value));
}

/** The action Cursor asks for, minus only the per-call toolCallId and status. Commands, flags, and quoting stay exact. */
export function canonicalAction(toolCall) {
	const { toolCallId: _id, status: _status, ...rest } = toolCall && typeof toolCall === "object" ? toolCall : {};
	return rest;
}

/** Exact fingerprint of one action in one canonical cwd and mode. No prefixes, patterns, or command families. */
export function actionFingerprint({ toolCall, cwd, mode }) {
	return sha(stableStringify({ v: APPROVALS_VERSION, cwd: String(cwd ?? ""), mode: mode ?? null, action: canonicalAction(toolCall) }));
}

/** Identity of one exact delegated task: Pi session + worker + full task text. */
export function taskKey({ piSessionId, worker, task }) {
	return sha(stableStringify({ v: APPROVALS_VERSION, piSessionId: String(piSessionId ?? ""), worker: String(worker ?? ""), taskSha: sha(String(task ?? "")) }));
}

export function taskSha(task) {
	return sha(String(task ?? ""));
}

const preview = (text, limit = PREVIEW_CHARS) => {
	const t = String(text ?? "");
	return t.length > limit ? { text: t.slice(0, limit), truncated: true, chars: t.length } : { text: t, truncated: false, chars: t.length };
};

/** Compact, bounded description of a tool call for records and lists (the full request lives in the payload file). */
export function summarizeToolCall(toolCall) {
	const tc = toolCall && typeof toolCall === "object" ? toolCall : {};
	let input;
	if (tc.rawInput !== undefined) {
		try {
			input = typeof tc.rawInput?.command === "string" ? tc.rawInput.command : JSON.stringify(tc.rawInput);
		} catch {
			input = "(unserializable input)";
		}
	}
	const locations = Array.isArray(tc.locations) ? tc.locations.map((l) => String(l?.path ?? "")).filter(Boolean) : [];
	return {
		toolCallId: typeof tc.toolCallId === "string" ? tc.toolCallId.slice(0, 200) : undefined,
		title: preview(tc.title, 200).text,
		kind: typeof tc.kind === "string" ? tc.kind.slice(0, 40) : undefined,
		input: input === undefined ? undefined : preview(input),
		locations: locations.slice(0, 10).map((p) => p.slice(0, 300)),
		moreLocations: Math.max(0, locations.length - 10),
		contentItems: Array.isArray(tc.content) ? tc.content.length : 0,
	};
}

export function newId(prefix) {
	return `${prefix}-${Date.now().toString(36).padStart(9, "0")}-${randomBytes(4).toString("hex")}`;
}

export function validId(id, prefix) {
	return typeof id === "string" && ID_RE.test(id) && (!prefix || id.startsWith(`${prefix}-`));
}

async function writeExclusive(file, value) {
	await ensurePrivateDir(path.dirname(file));
	const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	let handle;
	try {
		handle = await fs.open(tmp, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(value, null, 1)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		// link() fails with EEXIST if the target exists: exactly one writer wins, and readers never see partial files.
		await fs.link(tmp, file);
	} finally {
		await handle?.close().catch(() => {});
		await fs.rm(tmp, { force: true }).catch(() => {});
	}
}

/** Synchronous twin of writeExclusive, for the reply record: no await may separate the last run check from the reply. */
function writeExclusiveSync(file, value) {
	fsSync.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	let fd;
	try {
		fd = fsSync.openSync(tmp, "wx", 0o600);
		fsSync.writeFileSync(fd, `${JSON.stringify(value, null, 1)}\n`, "utf8");
		fsSync.fsyncSync(fd);
		fsSync.closeSync(fd);
		fd = undefined;
		fsSync.linkSync(tmp, file);
	} finally {
		if (fd !== undefined) fsSync.closeSync(fd);
		fsSync.rmSync(tmp, { force: true });
	}
}

/** Digest of a stored full request, so a rule can be bound to exactly the request the user was shown. */
export function payloadDigest(payload) {
	return sha(stableStringify(payload ?? null));
}

/** What Cursor was actually answered, from the reply record: allowed, rejected, cancelled, or unknown (no record). */
export function appliedStatus(response) {
	if (!response || response.error) return "unknown";
	if (response.outcome === "allow_once" && response.allowGranted === true) return "allowed";
	return response.outcome === "cancelled" ? "cancelled" : "rejected";
}

async function readJson(file, maxBytes = MAX_RECORD_BYTES) {
	const handle = await fs.open(file, "r");
	try {
		const { size } = await handle.stat();
		if (size > maxBytes) throw new ApprovalStoreError(`${path.basename(file)} is larger than ${maxBytes} bytes`);
		const text = await handle.readFile("utf8");
		let value;
		try {
			value = JSON.parse(text);
		} catch {
			throw new ApprovalStoreError(`${path.basename(file)} is not valid JSON`);
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApprovalStoreError(`${path.basename(file)} is not a JSON object`);
		return value;
	} finally {
		await handle.close();
	}
}

async function exists(file) {
	try {
		await fs.access(file);
		return true;
	} catch (err) {
		if (err.code === "ENOENT") return false;
		throw err;
	}
}

async function listJson(dir) {
	try {
		return (await fs.readdir(dir)).filter((n) => n.endsWith(".json")).sort();
	} catch (err) {
		if (err.code === "ENOENT") return [];
		throw err;
	}
}

function validRule(rule, fingerprint) {
	return (
		rule &&
		rule.v === APPROVALS_VERSION &&
		validId(rule.id, "r") &&
		(rule.effect === "allow" || rule.effect === "block") &&
		RULE_SCOPES.includes(rule.scope) &&
		(rule.effect === "allow" || rule.scope === "project") &&
		FP_RE.test(rule.fingerprint) &&
		(!fingerprint || rule.fingerprint === fingerprint) &&
		(rule.scope !== "task" || FP_RE.test(rule.taskKey))
	);
}

export class ApprovalStore {
	constructor({ stateDir, projectCwd }) {
		if (!stateDir || !projectCwd) throw new Error("ApprovalStore requires stateDir and projectCwd");
		this.dir = path.join(stateDir, projectKey(projectCwd), "approvals");
		this.recordsDir = path.join(this.dir, "records");
		this.payloadsDir = path.join(this.dir, "payloads");
		this.responsesDir = path.join(this.dir, "responses");
		this.evidenceDir = path.join(this.dir, "evidence");
		this.observedDir = path.join(this.dir, "observed");
		this.rulesDir = path.join(this.dir, "rules");
		this.revokedDir = path.join(this.dir, "revoked");
		this.claimsDir = path.join(this.dir, "claims");
	}

	recordPath(id) {
		return path.join(this.recordsDir, `${id}.json`);
	}

	payloadPath(id) {
		return path.join(this.payloadsDir, `${id}.json`);
	}

	/** Persist one decision (payload first, then the record). Throws on any failure; the caller must then not allow. */
	async recordDecision(record, payload) {
		if (!validId(record?.id, "d")) throw new ApprovalStoreError("invalid decision id");
		await ensurePrivateDir(this.dir);
		if (payload !== undefined) await writeExclusive(this.payloadPath(record.id), payload);
		await writeExclusive(this.recordPath(record.id), { v: APPROVALS_VERSION, kind: "permission", ...record });
		return this.recordPath(record.id);
	}

	responsePath(id) {
		return path.join(this.responsesDir, `${id}.json`);
	}

	/**
	 * Record the reply actually prepared for Cursor (allow_once, reject_once, or cancelled), synchronously and
	 * immutably, right before it is returned. Throws on failure; the caller must then not allow.
	 */
	recordResponseSync(id, response) {
		if (!validId(id, "d")) throw new ApprovalStoreError("invalid decision id");
		writeExclusiveSync(this.responsePath(id), { v: APPROVALS_VERSION, id, preparedAt: new Date().toISOString(), note: RESPONSE_NOTE, ...response });
	}

	async #readResponse(id) {
		try {
			const response = await readJson(this.responsePath(id));
			return response.id === id ? response : { error: "reply record id mismatch" };
		} catch (err) {
			return err.code === "ENOENT" ? undefined : { error: err.message };
		}
	}

	/** Best-known, Cursor-reported status of a decided tool call. Overwritten as updates arrive; never proof of execution. */
	async writeEvidence(id, evidence) {
		if (!validId(id, "d")) throw new ApprovalStoreError("invalid decision id");
		await writeJsonAtomic(path.join(this.evidenceDir, `${id}.json`), { v: APPROVALS_VERSION, id, source: "cursor-reported", ...evidence });
	}

	/** Tool calls Cursor reported without a permission request in one run. */
	async writeObserved(runId, observed) {
		if (!RUN_RE.test(runId)) throw new ApprovalStoreError("invalid run id");
		const calls = observed.calls.slice(0, MAX_OBSERVED);
		await writeJsonAtomic(path.join(this.observedDir, `${runId}.json`), {
			v: APPROVALS_VERSION,
			kind: "cursor-observed",
			reviewedByPi: false,
			overridable: false,
			note: OBSERVED_NOTE,
			...observed,
			calls,
			omitted: (observed.omitted ?? 0) + Math.max(0, observed.calls.length - MAX_OBSERVED),
		});
	}

	async getRecord(id) {
		if (!validId(id, "d")) throw new ApprovalStoreError(`invalid decision id ${JSON.stringify(String(id).slice(0, 40))}`);
		const record = await readJson(this.recordPath(id));
		if (record.id !== id || record.v !== APPROVALS_VERSION) throw new ApprovalStoreError(`record ${id} is corrupt`);
		let payload;
		let payloadError;
		if (record.payloadStored) {
			try {
				payload = await readJson(this.payloadPath(id), MAX_PAYLOAD_CHARS * 4 + 4096);
			} catch (err) {
				payloadError = err.message;
			}
		}
		let evidence;
		try {
			evidence = await readJson(path.join(this.evidenceDir, `${id}.json`));
		} catch (err) {
			if (err.code !== "ENOENT") evidence = { error: err.message };
		}
		return { record, payload, payloadError, evidence, response: await this.#readResponse(id) };
	}

	/**
	 * Newest first, each with its reply record (`response`, undefined if none) and `applied` status. Filters use what was
	 * actually answered: approved = allow_once granted; blocked = rejected or cancelled; unknown = no reply record.
	 * Corrupt or unreadable records are listed as such, never dropped silently.
	 */
	async listRecords({ limit = 50, filter = "all" } = {}) {
		const names = (await listJson(this.recordsDir)).reverse();
		const out = [];
		for (const name of names) {
			if (out.length >= limit) break;
			const id = name.slice(0, -5);
			if (!validId(id, "d")) continue;
			let record;
			try {
				record = await readJson(this.recordPath(id));
				if (record.id !== id) throw new ApprovalStoreError("id mismatch");
			} catch (err) {
				if (filter === "all") out.push({ id, corrupt: true, error: err.message });
				continue;
			}
			const response = await this.#readResponse(id);
			const applied = appliedStatus(response);
			if (filter === "approved" && applied !== "allowed") continue;
			if (filter === "blocked" && applied !== "rejected" && applied !== "cancelled") continue;
			if (filter === "unknown" && applied !== "unknown") continue;
			out.push({ ...record, response, applied });
		}
		return out;
	}

	async listObserved({ limit = 20 } = {}) {
		const names = (await listJson(this.observedDir)).reverse().slice(0, limit);
		const out = [];
		for (const name of names) {
			try {
				out.push(await readJson(path.join(this.observedDir, name), 4 * 1024 * 1024));
			} catch (err) {
				out.push({ runId: name.slice(0, -5), corrupt: true, error: err.message });
			}
		}
		return out;
	}

	/**
	 * Create a rule from a recorded decision: allow once/task/project, or block the exact action in this project. Only
	 * complete records (full request stored, reviewable details, not a question guard) are eligible.
	 */
	async createRule({ effect, scope, sourceRecordId, expected }) {
		if (effect !== "allow" && effect !== "block") throw new ApprovalStoreError("effect must be allow or block");
		if (!RULE_SCOPES.includes(scope)) throw new ApprovalStoreError(`scope must be one of ${RULE_SCOPES.join("|")}`);
		if (effect === "block" && scope !== "project") throw new ApprovalStoreError("block rules apply to the exact action in this project");
		const { record, payload, payloadError } = await this.getRecord(sourceRecordId);
		const why = ruleIneligible(record, payload, payloadError);
		if (why) throw new ApprovalStoreError(`decision ${sourceRecordId} cannot be used for a rule: ${why}`);
		// expected is the snapshot the user was shown; the files are re-read here, so any change means no rule.
		if (expected) {
			const actual = ruleSnapshot(record, payload);
			const changed = Object.keys(actual).filter((k) => expected[k] !== actual[k]);
			if (changed.length) throw new ApprovalStoreError(`decision ${sourceRecordId} changed since it was shown (${changed.join(", ")}); no rule was created`);
		}
		const rule = {
			v: APPROVALS_VERSION,
			id: newId("r"),
			createdAt: new Date().toISOString(),
			createdBy: "user via /approvals",
			effect,
			scope,
			fingerprint: record.fingerprint,
			taskKey: scope === "task" ? record.taskKey : undefined,
			cwd: record.cwd,
			mode: record.mode,
			worker: scope === "task" ? record.worker : undefined,
			piSessionId: scope === "task" ? record.piSessionId : undefined,
			sourceRecordId,
			request: record.request,
		};
		await writeExclusive(path.join(this.rulesDir, rule.fingerprint, `${rule.id}.json`), rule);
		return rule;
	}

	/** All rules with their state (active, revoked, consumed); unreadable ones are listed as corrupt. */
	async listRules() {
		let dirs;
		try {
			dirs = (await fs.readdir(this.rulesDir)).filter((d) => FP_RE.test(d)).sort();
		} catch (err) {
			if (err.code === "ENOENT") return [];
			throw err;
		}
		const out = [];
		for (const fp of dirs) {
			for (const name of await listJson(path.join(this.rulesDir, fp))) {
				if (out.length >= MAX_RULES_LISTED) return out;
				const id = name.slice(0, -5);
				const idValid = validId(id, "r");
				try {
					if (!idValid) throw new ApprovalStoreError("invalid rule file name");
					const rule = await readJson(path.join(this.rulesDir, fp, name));
					if (!validRule(rule, fp) || rule.id !== id) throw new ApprovalStoreError("invalid rule");
					out.push({ ...rule, state: await this.#ruleState(rule) });
				} catch (err) {
					// A corrupt rule with a valid id can still be revoked; until then it blocks its action.
					const revoked = idValid && (await exists(path.join(this.revokedDir, `${id}.json`)));
					out.push({ id, fingerprint: fp, corrupt: true, revocable: idValid && !revoked, state: revoked ? "revoked" : "unreadable", error: err.message });
				}
			}
		}
		return out.sort((a, b) => String(b.id).localeCompare(String(a.id)));
	}

	async #ruleState(rule) {
		if (await exists(path.join(this.revokedDir, `${rule.id}.json`))) return "revoked";
		if (rule.scope === "once" && (await exists(path.join(this.claimsDir, `${rule.id}.json`)))) return "consumed";
		return "active";
	}

	/** Revocation is a separate immutable file, effective for the next request. Returns false if already revoked. */
	async revokeRule(ruleId) {
		if (!validId(ruleId, "r")) throw new ApprovalStoreError("invalid rule id");
		const rule = (await this.listRules()).find((r) => r.id === ruleId);
		if (!rule) throw new ApprovalStoreError(`rule ${ruleId} not found`);
		try {
			await writeExclusive(path.join(this.revokedDir, `${ruleId}.json`), { v: APPROVALS_VERSION, id: ruleId, revokedAt: new Date().toISOString(), revokedBy: "user via /approvals" });
			return true;
		} catch (err) {
			if (err.code === "EEXIST") return false;
			throw err;
		}
	}

	/**
	 * Active rules for one exact action. Block wins over allow; non-consuming allows are preferred over once-rules.
	 * Throws when the rules for this action cannot be read completely, so the caller can block.
	 */
	async match({ fingerprint, taskKey: key }) {
		if (!FP_RE.test(fingerprint ?? "")) return {};
		const dir = path.join(this.rulesDir, fingerprint);
		const names = await listJson(dir);
		if (names.length > MAX_RULES_PER_ACTION) throw new ApprovalStoreError(`more than ${MAX_RULES_PER_ACTION} rules for one action`);
		const active = [];
		for (const name of names) {
			// The file name is the rule id; revocation is checked before parsing, so a revoked corrupt rule stops blocking.
			const id = name.slice(0, -5);
			if (!validId(id, "r")) throw new ApprovalStoreError(`rule file ${name} has an invalid name`);
			if (await exists(path.join(this.revokedDir, `${id}.json`))) continue;
			const rule = await readJson(path.join(dir, name));
			if (!validRule(rule, fingerprint) || rule.id !== id) throw new ApprovalStoreError(`rule file ${name} is invalid`);
			if ((await this.#ruleState(rule)) === "active") active.push(rule);
		}
		const block = active.find((r) => r.effect === "block");
		if (block) return { block };
		const allows = active.filter((r) => r.effect === "allow" && (r.scope !== "task" || r.taskKey === key));
		const allow = allows.find((r) => r.scope !== "once") ?? allows.find((r) => r.scope === "once");
		return allow ? { allow } : {};
	}

	/** Atomically consume a once-rule for one decision. Exactly one caller across processes gets true. */
	async claimOnce(rule, decisionId) {
		try {
			await writeExclusive(path.join(this.claimsDir, `${rule.id}.json`), { v: APPROVALS_VERSION, id: rule.id, decisionId, claimedAt: new Date().toISOString() });
			return true;
		} catch (err) {
			if (err.code === "EEXIST") return false;
			throw err;
		}
	}
}

/** The identity a rule is bound to: what the user saw must equal what is stored when the rule is created. */
export function ruleSnapshot(record, payload) {
	return { fingerprint: record?.fingerprint, cwd: record?.cwd, mode: record?.mode, taskKey: record?.taskKey, payloadSha: payloadDigest(payload) };
}

/** Why a record cannot back a rule, or undefined if it can. */
export function ruleIneligible(record, payload, payloadError) {
	if (!record || record.kind !== "permission") return "not a permission decision";
	if (record.guard) return "question-shaped or ambiguous requests are never answered";
	if (!record.complete) return record.incompleteReason ?? "the record is incomplete";
	if (!record.payloadStored || !payload) return payloadError ? `full request unreadable (${payloadError})` : "full request not stored";
	if (!FP_RE.test(record.fingerprint ?? "") || !FP_RE.test(record.taskKey ?? "")) return "no action fingerprint";
	if (actionFingerprint({ toolCall: payload.toolCall, cwd: record.cwd, mode: record.mode }) !== record.fingerprint) return "the stored request does not match its fingerprint";
	return undefined;
}
