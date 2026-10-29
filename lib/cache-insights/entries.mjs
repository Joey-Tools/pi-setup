// Metadata-only view of Pi session entries, and the one rule that decides whether two consecutive responses
// form a qualified pair. Shared by live recording, history import, and anchor recovery. Content fields
// (message content, tool arguments, summaries, notes, error text) are never read into the returned objects.
import { num, pickUsage, promptTokens, safeId, sameModel, stopReason, SUCCESS_STOPS, timeMs } from "./util.mjs";

export const BOUNDARIES = Object.freeze(["model_change", "thinking_change", "system_or_tools_changed", "compaction", "branch_summary", "context_edit", "warm", "unknown_entry", "other_message"]);
const ORDINARY_ROLES = new Set(["user", "toolResult", "bashExecution", "custom"]);
const IGNORED_TYPES = new Set(["custom", "label", "session_info"]);
const BOUNDARY_TYPES = { model_change: "model_change", thinking_level_change: "thinking_change", compaction: "compaction", branch_summary: "branch_summary", context_edit: "context_edit" };

/**
 * Classifies one entry. Returns { kind, id, parentId, ... } with kind one of
 * header | assistant | ordinary | boundary | warm | ignore | invalid. Ids are kept in memory only.
 */
export function classifyEntry(entry) {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { kind: "invalid" };
	const base = { id: typeof entry.id === "string" ? entry.id : null, parentId: typeof entry.parentId === "string" ? entry.parentId : null, entryTime: timeMs(entry.timestamp) };
	const type = entry.type;
	if (type === "session") return { ...base, kind: "header" };
	if (type === "message") {
		const m = entry.message;
		const role = m && typeof m === "object" ? m.role : undefined;
		if (role === "assistant") {
			return {
				...base,
				kind: "assistant",
				provider: safeId(m.provider),
				model: safeId(m.model),
				api: safeId(m.api),
				responseModel: safeId(m.responseModel),
				stopReason: stopReason(m.stopReason),
				requestStartMs: num(m.timestamp),
				usage: pickUsage(m.usage),
			};
		}
		if (ORDINARY_ROLES.has(role)) return { ...base, kind: "ordinary" };
		const reason = role === "system" ? "system_or_tools_changed" : role === "compactionSummary" ? "compaction" : role === "branchSummary" ? "branch_summary" : "other_message";
		return { ...base, kind: "boundary", reason };
	}
	if (type === "custom_message") return { ...base, kind: "ordinary" };
	if (type === "usage") {
		if (entry.kind !== "cache_warm") return { ...base, kind: "ignore" };
		return { ...base, kind: "warm", provider: safeId(entry.provider), model: safeId(entry.model), usage: pickUsage(entry.usage) };
	}
	if (IGNORED_TYPES.has(type)) return { ...base, kind: "ignore" };
	return { ...base, kind: "boundary", reason: BOUNDARY_TYPES[type] ?? "unknown_entry" };
}

/**
 * Decides a pair between the previous response `prev` and the current response `cur` (both from classifyEntry,
 * plus `endMs` and `endProvenance`). `context.boundary` is the first boundary seen between them, and
 * `context.ancestry` is "ok", "break", or "legacy". Returns the pair fields, with no keys or origin.
 */
export function decidePair(prev, cur, { boundary = null, ancestry = "ok" } = {}) {
	const gapStartMs = prev.requestStartMs !== null && cur.requestStartMs !== null ? cur.requestStartMs - prev.requestStartMs : null;
	const gapEndMs = prev.endMs !== null && cur.requestStartMs !== null ? cur.requestStartMs - prev.endMs : null;
	const prompt = promptTokens(cur.usage);
	const prevPrompt = promptTokens(prev.usage);
	const inverted = (r) => r.endMs !== null && r.requestStartMs !== null && r.endMs < r.requestStartMs;
	let exclusion = null;
	if (boundary === "warm") exclusion = "warm_between";
	else if (boundary) exclusion = "boundary";
	else if (ancestry === "legacy") exclusion = "legacy_ambiguous";
	else if (ancestry !== "ok") exclusion = "ancestry_break";
	else if (prev.provider !== cur.provider || prev.model !== cur.model) exclusion = "model_changed";
	else if (!sameModel(prev.model, prev.responseModel) || !sameModel(cur.model, cur.responseModel)) exclusion = "model_mismatch";
	else if (!SUCCESS_STOPS.includes(prev.stopReason)) exclusion = "prev_not_success";
	else if (!SUCCESS_STOPS.includes(cur.stopReason)) exclusion = "cur_not_success";
	else if (prevPrompt === null || prevPrompt <= 0) exclusion = "prev_usage_missing";
	else if (prompt === null || prompt <= 0) exclusion = "usage_missing";
	else if (gapStartMs === null || gapEndMs === null) exclusion = "timing_missing";
	else if (gapStartMs < 0 || gapEndMs < 0 || inverted(prev) || inverted(cur)) exclusion = "clock_anomaly";
	const prevRead = prev.usage?.cacheRead ?? null;
	return {
		provider: cur.provider,
		model: cur.model,
		gapStartMs,
		gapEndMs,
		endProvenance: prev.endProvenance,
		prevCacheRead: prevRead,
		prevCacheWrite: prev.usage?.cacheWrite ?? null,
		prevPrompt,
		cacheRead: cur.usage?.cacheRead ?? null,
		cacheWrite: cur.usage?.cacheWrite ?? null,
		input: cur.usage?.input ?? null,
		qualified: exclusion === null,
		tier: exclusion === null ? (prevRead > 0 ? "strong" : "weak") : null,
		exclusion,
	};
}

/** Sample fields for an assistant or warm entry (no key, origin, or thinking). */
export function sampleFields(meta, { endMs, endProvenance }) {
	return {
		kind: meta.kind === "warm" ? "warm" : "response",
		provider: meta.provider,
		model: meta.model,
		api: meta.api ?? null,
		responseModel: meta.responseModel ?? null,
		stopReason: meta.kind === "warm" ? null : meta.stopReason,
		requestStartMs: meta.kind === "warm" ? null : meta.requestStartMs,
		endMs,
		endProvenance,
		usage: meta.usage,
	};
}

/**
 * From a branch (root → leaf entries, as ctx.sessionManager.getBranch() returns), finds the latest response and
 * the first boundary or warm after it. Returns null when the branch has no response.
 */
export function latestResponseOnBranch(entries) {
	if (!Array.isArray(entries)) return null;
	let after = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const meta = classifyEntry(entries[i]);
		if (meta.kind === "assistant") return { meta, after };
		if (meta.kind === "boundary") after = meta.reason;
		else if (meta.kind === "warm") after = "warm";
	}
	return null;
}

/** First boundary or warm after the response whose request start is `requestStartMs`; undefined if not on the branch. */
export function transitionsAfter(entries, requestStartMs) {
	if (!Array.isArray(entries)) return undefined;
	let after = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const meta = classifyEntry(entries[i]);
		if (meta.kind === "assistant") {
			if (meta.requestStartMs === requestStartMs) return after;
			return undefined;
		}
		if (meta.kind === "boundary") after = meta.reason;
		else if (meta.kind === "warm") after = "warm";
	}
	return undefined;
}
