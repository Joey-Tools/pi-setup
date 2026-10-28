// The user-initiated /approvals command: view the private permission history, add exact allow/block rules from a
// recorded decision, and revoke rules. It never runs, replays, or re-sends anything. Rule changes need the interactive
// TUI and a confirmation after the full request was shown; other modes are read-only. Not reachable from any tool.
// Every untrusted value (request, reason, task, paths, errors) goes through safeDisplay before it reaches the UI.
import { appliedStatus, DECISION_NOTE, NO_RESPONSE_NOTE, OBSERVED_NOTE, ruleIneligible, ruleSnapshot, validId } from "./approvals.mjs";

export const APPROVALS_USAGE = "/approvals [recent|blocked|approved|unknown|rules|observed|show <decision-id>]";
const LIST_LIMIT = 30;
const NO_UNDO = "This only affects future Cursor permission requests that match exactly. Nothing is re-run or replayed now, and actions that already ran cannot be undone. Resume the work yourself afterwards if you want it retried.";
const POLICY_NOTE = "Allow rules also skip the dialog under PI_CURSOR_PERMISSIONS=ask; under PI_CURSOR_PERMISSIONS=deny no rule allows anything.";

const SCOPES = {
	once: { label: "Allow this exact action once", explain: `Allows the next request for exactly this action (same request, cwd, and mode) in this project, once, then expires. ${POLICY_NOTE}` },
	task: { label: "Allow this exact action for this exact task", explain: `Allows exactly this action (same request, cwd, and mode) whenever this same worker runs this same task text in this same Pi session. ${POLICY_NOTE}` },
	project: { label: "Allow this exact action in this project", explain: `Allows exactly this action (same request, cwd, and mode) in this project from any worker or task, until you revoke the rule. ${POLICY_NOTE}` },
	block: { label: "Block this exact action in this project", explain: "Blocks exactly this action (same request, cwd, and mode) in this project without a model review, under every policy. Blocks win over allows." },
};

// C0 controls, DEL, C1 controls, bidi controls and isolates, zero-width characters, BOM, and line/paragraph separators.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const MULTILINE_UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const escapeChar = (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;

/**
 * Display-only escaping of untrusted text: control, bidi, and invisible characters become visible \uXXXX text, so no
 * value can emit terminal escapes (ANSI, OSC titles or clipboard), reorder text, or fake extra lines. In the default
 * single-field mode newlines are escaped too; multiline keeps "\n" (for pretty JSON whose strings are already escaped).
 * Stored requests, fingerprints, and rules are never changed by this.
 */
export function safeDisplay(text, { multiline = false, max } = {}) {
	let t = String(text ?? "").replace(multiline ? MULTILINE_UNSAFE : UNSAFE, escapeChar);
	if (max && t.length > max) t = `${t.slice(0, max - 1)}…`;
	return t;
}

const field = (text, max) => safeDisplay(String(text ?? "").replace(/ +/g, " ").trim(), { max });

const STATUS_WORD = { allowed: "ALLOWED", rejected: "REJECTED", cancelled: "CANCELLED", unknown: "UNKNOWN" };

function recordLabel(r) {
	if (r.corrupt) return `${field(r.id, 40)}  UNREADABLE  ${field(r.error, 60)}`;
	const status = STATUS_WORD[r.applied ?? appliedStatus(r.response)];
	const intended = r.intended?.decision === "approve" && r.applied !== "allowed" ? " (intended approve)" : "";
	const what = r.request?.input?.text ?? r.request?.title ?? "(no input)";
	return `${field(r.id, 40)}  ${status}${intended}  ${field(r.intended?.provenance ?? "?", 30)}  ${field(r.worker ?? "?", 48)}  ${field(what, 90)}`;
}

function ruleLabel(r) {
	if (r.corrupt) return `${field(r.id, 60)}  UNREADABLE  ${field(r.state, 20)}  ${field(r.error, 60)}`;
	const what = r.request?.input?.text ?? r.request?.title ?? "(no input)";
	return `${field(r.id, 40)}  ${field(r.effect, 10).toUpperCase()} ${field(r.scope, 10)}  ${field(r.state, 20)}  ${field(what, 90)}`;
}

const json = (value) => safeDisplay(JSON.stringify(value, null, 2), { multiline: true });

/** Full, read-only text of one decision: intended decision, the reply actually prepared, the complete stored request. */
export function formatDecision({ record, payload, payloadError, evidence, response }) {
	const r = record;
	const applied = appliedStatus(response);
	const lines = [
		`Decision ${field(r.id)} (${field(r.createdAt)})`,
		`Reply to Cursor: ${STATUS_WORD[applied]}${response && !response.error ? `: ${field(response.reason)} (${field(response.provenance)})` : response?.error ? ` (reply record unreadable: ${field(response.error)})` : ""}`,
		`Intended decision: ${field(r.intended?.decision)} by ${field(r.intended?.provenance)}: ${field(r.intended?.reason)}`,
		`Policy: ${field(r.policy)}${r.reviewProfile ? `, review profile ${field(r.reviewProfile)}` : ""}`,
		`Worker: ${field(r.worker)}  Pi session: ${field(r.piSessionId)}  Cursor session: ${field(r.cursorSessionId ?? "?")}`,
		`cwd: ${field(r.cwd)}  mode: ${field(r.mode)}`,
		`Task (sha256 ${field(r.task?.sha256)}, ${field(r.task?.chars)} chars${r.task?.truncated ? ", preview only" : ""}): ${field(r.task?.preview)}`,
		`Fingerprint: ${field(r.fingerprint ?? "(none)")}`,
		`Complete: ${r.complete ? "yes" : `no (${field(r.incompleteReason ?? "unknown")})`}`,
	];
	for (const p of r.passes ?? []) {
		lines.push(`Review pass ${field(p.pass)}: ${field(p.decision)}${p.error ? " (error)" : ""}${p.timedOut ? " (timed out)" : ""}${p.aborted ? " (aborted)" : ""} by ${field(p.model ?? "?")}: ${field(p.reason)}`);
	}
	if (r.reviewSkipped) lines.push(`Review skipped: ${field(r.reviewSkipped)}`);
	lines.push("", "Full request as Cursor sent it (control and invisible characters shown as \\uXXXX):");
	if (payload) lines.push(json(payload));
	else lines.push(payloadError ? `(unreadable: ${field(payloadError)})` : "(not stored)");
	lines.push("", "Cursor-reported status (not proof of execution or success):");
	lines.push(evidence ? json(evidence) : "(none reported)");
	lines.push("", DECISION_NOTE, response && !response.error ? field(response.note) : NO_RESPONSE_NOTE, `Run artifacts: ${field(r.artifactDir)}`);
	return lines.join("\n");
}

function formatObserved(list) {
	const lines = [OBSERVED_NOTE, ""];
	if (!list.length) lines.push("(no Cursor-observed tool calls recorded)");
	for (const o of list) {
		if (o.corrupt) {
			lines.push(`Run ${field(o.runId)}: unreadable (${field(o.error)})`);
			continue;
		}
		lines.push(`Run ${field(o.recordedAt ?? "?")} worker ${field(o.worker ?? "?")} (${field(o.calls?.length ?? 0)} call(s)${o.omitted ? `, ${field(o.omitted)} omitted` : ""}) events: ${field(o.eventsPath)}`);
		for (const c of o.calls ?? []) lines.push(`  - ${field(c.toolCallId, 80)} [${field(c.kind ?? "?", 20)}] reported ${field(c.status ?? "?", 20)}: ${field(c.input?.text ?? c.title, 160)}${c.input?.truncated ? " (truncated)" : ""}`);
		if (o.askedPiButNotRecorded?.length) {
			lines.push(`  ${field(o.askedPiButNotRecordedNote)}`);
			for (const c of o.askedPiButNotRecorded) lines.push(`  - ${field(c.toolCallId, 80)} reported ${field(c.status ?? "?", 20)}: ${field(c.input?.text ?? c.title, 160)}`);
		}
	}
	return lines.join("\n");
}

function formatRecordList(records, title) {
	return [title, ...(records.length ? records.map(recordLabel) : ["(none)"]), "", `Details: /approvals show <decision-id>. ${DECISION_NOTE}`].join("\n");
}

const view = (ctx, title, text) => ctx.ui.editor(`${title} (read-only; edits are ignored)`, text);
const LIST_SUBS = ["", "recent", "list", "blocked", "approved", "unknown", "rules", "observed"];

/** One handler for every mode; returns nothing. Errors are reported through notify. */
export async function approvalsCommand(args, ctx, { store }) {
	const [sub = "", arg] = String(args ?? "").trim().split(/\s+/);
	const interactive = ctx.mode === "tui" && ctx.hasUI;
	try {
		if (sub === "show") {
			if (!validId(arg, "d")) return ctx.ui.notify(`usage: ${APPROVALS_USAGE}`, "error");
			const text = formatDecision(await store.getRecord(arg));
			return interactive ? void (await view(ctx, `Decision ${arg}`, text)) : ctx.ui.notify(text, "info");
		}
		if (!interactive) {
			if (!LIST_SUBS.includes(sub)) {
				return ctx.ui.notify(`Changing approval rules needs the interactive TUI (/approvals there). Read-only here: ${APPROVALS_USAGE}`, "error");
			}
			ctx.ui.notify(await readOnlyText(sub, store), "info");
			return;
		}
		await menu(ctx, store, sub);
	} catch (err) {
		ctx.ui.notify(`approvals: ${field(err?.message ?? err, 500)}`, "error");
	}
}

async function readOnlyText(sub, store) {
	if (sub === "rules") {
		const rules = await store.listRules();
		return [`Approval rules (${field(store.dir)})`, ...(rules.length ? rules.map(ruleLabel) : ["(none)"])].join("\n");
	}
	if (sub === "observed") return formatObserved(await store.listObserved());
	const filter = ["blocked", "approved", "unknown"].includes(sub) ? sub : "all";
	return formatRecordList(await store.listRecords({ limit: LIST_LIMIT, filter }), `Recent ${filter === "all" ? "" : `${filter} `}Cursor permission decisions (${field(store.dir)}); rule changes need the interactive TUI`);
}

const MAIN = [
	"Recent decisions",
	"Blocked decisions (rejected or cancelled)",
	"Approved decisions (allow prepared for Cursor)",
	"Decisions with no recorded reply",
	"Rules",
	"Cursor-observed tool calls (not Pi-reviewed)",
	"Close",
];
const FILTERS = { [MAIN[0]]: "all", [MAIN[1]]: "blocked", [MAIN[2]]: "approved", [MAIN[3]]: "unknown" };
const START = { recent: MAIN[0], list: MAIN[0], blocked: MAIN[1], approved: MAIN[2], unknown: MAIN[3], rules: MAIN[4], observed: MAIN[5] };

async function menu(ctx, store, sub) {
	let choice = START[sub];
	for (;;) {
		choice ??= await ctx.ui.select(`Cursor permission history for this project (private: ${field(store.dir)})`, MAIN);
		if (!choice || choice === "Close") return;
		if (choice === MAIN[4]) await rulesMenu(ctx, store);
		else if (choice === MAIN[5]) await view(ctx, "Cursor-observed tool calls", formatObserved(await store.listObserved()));
		else if (FILTERS[choice]) await decisionsMenu(ctx, store, FILTERS[choice]);
		choice = undefined;
	}
}

async function decisionsMenu(ctx, store, filter) {
	for (;;) {
		const records = await store.listRecords({ limit: LIST_LIMIT, filter });
		const labels = records.map(recordLabel);
		const picked = await ctx.ui.select(`${filter === "all" ? "Recent" : filter[0].toUpperCase() + filter.slice(1)} decisions (newest first)`, [...labels, "Back"]);
		if (!picked || picked === "Back") return;
		const record = records[labels.indexOf(picked)];
		if (!record || record.corrupt) {
			ctx.ui.notify(`Decision ${field(record?.id ?? "?", 60)} is unreadable and cannot be used for rules.`, "warning");
			continue;
		}
		await decisionMenu(ctx, store, record.id);
	}
}

async function decisionMenu(ctx, store, id) {
	for (;;) {
		const full = await store.getRecord(id);
		const why = ruleIneligible(full.record, full.payload, full.payloadError);
		const actions = ["View full request and decision", ...(why ? [] : [SCOPES.once.label, SCOPES.task.label, SCOPES.project.label, SCOPES.block.label]), "Back"];
		const picked = await ctx.ui.select(`${recordLabel({ ...full.record, applied: appliedStatus(full.response) })}${why ? `\nRules unavailable: ${field(why)}` : ""}`, actions);
		if (!picked || picked === "Back") return;
		if (picked === actions[0]) {
			await view(ctx, `Decision ${id}`, formatDecision(full));
			continue;
		}
		const key = Object.keys(SCOPES).find((k) => SCOPES[k].label === picked);
		if (!key) continue;
		await confirmRule(ctx, store, full, key);
	}
}

async function confirmRule(ctx, store, full, key) {
	const r = full.record;
	// The rule is bound to exactly what is shown here; createRule re-reads the files and refuses any difference.
	const expected = ruleSnapshot(full.record, full.payload);
	await view(ctx, `Review the full request before: ${SCOPES[key].label}`, formatDecision(full));
	const message = [
		SCOPES[key].explain,
		"",
		`Action: ${field(r.request?.title ?? "?", 200)}${r.request?.kind ? ` [${field(r.request.kind, 40)}]` : ""}`,
		`Input: ${field(r.request?.input?.text ?? "(none)", 1000)}${r.request?.input?.truncated ? " (preview truncated; the full request was shown above)" : ""}`,
		`cwd: ${field(r.cwd)}  mode: ${field(r.mode)}${key === "task" ? `  worker: ${field(r.worker)}  task sha256: ${field(r.task?.sha256?.slice(0, 16))}` : ""}`,
		`Fingerprint: ${field(r.fingerprint)}`,
		"",
		NO_UNDO,
	].join("\n");
	if (!(await ctx.ui.confirm(`${SCOPES[key].label}?`, message))) {
		ctx.ui.notify("No rule was changed.", "info");
		return;
	}
	const rule = await store.createRule({ effect: key === "block" ? "block" : "allow", scope: key === "block" ? "project" : key, sourceRecordId: r.id, expected });
	ctx.ui.notify(`Rule ${field(rule.id)} saved (${field(rule.effect)} ${field(rule.scope)}). Nothing was re-run; resume the work explicitly if you want it retried.`, "info");
}

async function rulesMenu(ctx, store) {
	for (;;) {
		const rules = await store.listRules();
		const labels = rules.map(ruleLabel);
		const picked = await ctx.ui.select("Approval rules (newest first)", [...labels, "Back"]);
		if (!picked || picked === "Back") return;
		const rule = rules[labels.indexOf(picked)];
		if (!rule) continue;
		if (rule.corrupt) {
			if (!rule.revocable) {
				ctx.ui.notify(`Rule file ${field(rule.id, 60)} is unreadable${rule.state === "revoked" ? " and already revoked" : " and has no valid rule id, so it cannot be revoked here; requests for its action stay blocked until the file is fixed or removed"}.`, "warning");
				continue;
			}
			const action = await ctx.ui.select(`${ruleLabel(rule)}\nWhile this unreadable rule is not revoked, every request for its action is blocked.`, ["Revoke (quarantine) this unreadable rule", "Back"]);
			if (action !== "Revoke (quarantine) this unreadable rule") continue;
			const ok = await ctx.ui.confirm(
				`Revoke unreadable rule ${field(rule.id)}?`,
				`Its content cannot be read (${field(rule.error)}), so it is unknown whether it allowed or blocked its action (fingerprint ${field(rule.fingerprint)}). After revoking, that action is decided without it; if it was a block rule, the action is no longer blocked by it. The file stays in place for inspection. Revoking does not undo anything that already ran.`,
			);
			if (!ok) continue;
			const revoked = await store.revokeRule(rule.id);
			ctx.ui.notify(revoked ? `Unreadable rule ${field(rule.id)} revoked.` : `Rule ${field(rule.id)} was already revoked.`, "info");
			continue;
		}
		const actions = ["View rule", ...(rule.state === "active" ? ["Revoke this rule"] : []), "Back"];
		const action = await ctx.ui.select(ruleLabel(rule), actions);
		if (action === "View rule") await view(ctx, `Rule ${rule.id}`, json(rule));
		else if (action === "Revoke this rule") {
			const ok = await ctx.ui.confirm(`Revoke rule ${field(rule.id)}?`, `${ruleLabel(rule)}\n\nThe next matching request is decided without this rule. Revoking does not undo anything that already ran.`);
			if (!ok) continue;
			const revoked = await store.revokeRule(rule.id);
			ctx.ui.notify(revoked ? `Rule ${field(rule.id)} revoked.` : `Rule ${field(rule.id)} was already revoked.`, "info");
		}
	}
}
