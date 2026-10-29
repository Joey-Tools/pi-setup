// Display text for the status bar and /cache output. Every untrusted value passes through display().
import { display, MINUTE_MS, sameModelId } from "./util.mjs";

const pad = (n) => String(n).padStart(2, "0");

/** Absolute clock time (HH:MM local, or HH:MMZ in UTC); never a countdown. `ceil` rounds up to the minute. */
export function clockTime(ms, time = "local", ceil = false) {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "unknown";
	const d = new Date(ceil ? Math.ceil(ms / MINUTE_MS) * MINUTE_MS : ms);
	return time === "utc" ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z` : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dateTime(ms, time = "local") {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "unknown";
	const d = new Date(ms);
	if (time === "utc") return d.toISOString().replace(/\.\d{3}Z$/, "Z");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export const minutes = (ms) => (typeof ms === "number" && Number.isFinite(ms) ? `${(ms / MINUTE_MS).toFixed(1)} min` : "unknown");

const usd = (v) => (v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(4)}`);
const credits = (v) => `${(v * 100).toFixed(v * 100 >= 10 ? 0 : 1)} cr`;

/** One money value or range in the chosen unit(s); null when hidden or unknown. */
export function money(low, high, mode) {
	if (mode === "off" || typeof low !== "number" || !Number.isFinite(low)) return null;
	const one = (fmt) => (high === undefined || high === null || Math.abs(high - low) < 1e-9 ? fmt(low) : `${fmt(low)}–${fmt(high)}`);
	if (mode === "credits") return one(credits);
	if (mode === "both") return `${one(usd)} (${one(credits)})`;
	return one(usd);
}

const REASONS = {
	no_profile: "no seeded profile for this model",
	no_anchor: "no usable previous response yet",
	end_unknown: "previous response end unknown",
	clock_anomaly: "clock anomaly",
	clock_backward: "wall clock moved backward",
	between_thresholds: "between seeded thresholds",
	model_change: "model changed",
	model_mismatch: "provider answered with a different model",
	thinking_change: "thinking level changed",
	system_or_tools_changed: "system prompt or tools changed",
	compaction: "context compacted",
	branch_summary: "branch summarized",
	context_edit: "context edited",
	tree: "moved in the session tree",
	fork: "forked session",
	warm: "cache warm with unknown start",
	error: "previous request failed",
	aborted: "previous request aborted",
	unknown_entry: "unrecognized session change",
	other_message: "unrecognized session change",
	new_session: "new session",
	reload: "extension reloaded",
};
export const reasonText = (r) => REASONS[r] ?? "unknown";

/** Short status-bar text, e.g. "cache hit · until 14:32 · miss ≈$0.21–$0.26". */
export function statusLine(f, cost, settings) {
	const parts = [f.label];
	if (f.state === "hit") parts.push(`until ${clockTime(f.hitUntil, settings.time)}`);
	else if (f.state === "uncertain") {
		if (f.reason === "between_thresholds" && f.expiredAfter !== null) parts.push(`expired after ${clockTime(f.expiredAfter, settings.time, true)}`);
		else parts.push(reasonText(f.reason));
	}
	const miss = cost && f.reason !== "no_profile" ? money(cost.missLow, cost.missHigh, settings.cost) : null;
	if (miss && f.state !== "expired") parts.push(`miss ≈${miss}`);
	else if (miss) parts.push(`≈${miss}`);
	return parts.join(" · ");
}

/** Multi-line /cache status details. */
export function statusDetails({ db, settings, model, profile, anchor, forecast: f, cost, envelope, recording, failure }) {
	const t = settings?.time ?? "local";
	const lines = ["Cache insights (seeded, provisional: a local estimate, not provider confirmation)"];
	if (failure) {
		lines.push(`Stopped in this Pi process after a local problem (${display(failure.code, 40)}).`);
		if (failure.message) lines.push(display(failure.message, 300));
		return lines.join("\n");
	}
	if (!db) {
		lines.push("Not set up: no database yet. Use /cache seed <provider/model> <hitMinutes> <expireMinutes>, /cache import, or /cache on in the TUI.");
		return lines.join("\n");
	}
	const c = db.counts();
	lines.push(`Database: ${display(db.paths.dbPath, 400)} (schema ${db.schemaVersion}; ${c.samples} samples: ${c.historical} historical, ${c.live} live; ${c.pairs} pairs${c.legacy ? `; ${c.legacy} legacy draft rows` : ""}).`);
	lines.push(`Recording new responses: ${recording ? "on" : "off"}. Times: ${t}. Cost display: ${settings.cost}.`);
	lines.push(`Active model: ${model ? `${display(model.provider, 60)}/${display(model.model, 80)}` : "unknown"}.`);
	if (!profile) lines.push("Active profile: none for this model (other models' seeds are never reused).");
	else lines.push(`Active profile (${display(profile.source, 20)}): cache hit while both clocks are under ${minutes(profile.hitUnderMs)}; cache expired once both are over ${minutes(profile.expireOverMs)}; uncertain in between and at the edges.`);
	if (anchor) {
		lines.push(`Anchor: previous response (${anchor.provenance === "message_end_received" ? "observed live; end = message_end receipt" : "recovered from the current branch; end = saved entry time (proxy)"}).`);
		lines.push(`  since request start: ${minutes(f.elapsedStartMs)} (started ${dateTime(anchor.startWall, t)})`);
		lines.push(`  since response end:  ${minutes(f.elapsedEndMs)} (ended ${dateTime(anchor.endWall, t)}); clock check: ${f.clock}`);
	} else lines.push("Anchor: none usable.");
	let verdict = `Forecast for the next request: ${f.label}`;
	if (f.state === "hit") verdict += ` until ${dateTime(f.hitUntil, t)}`;
	else if (f.state === "uncertain") verdict += ` (${reasonText(f.reason)})${f.expiredAfter !== null && f.reason === "between_thresholds" ? `; cache expired after ${dateTime(f.expiredAfter, t)}` : ""}`;
	lines.push(`${verdict}.`);
	if (cost) {
		const hit = money(cost.hit, null, settings.cost === "off" ? "usd" : settings.cost);
		const miss = money(cost.missLow, cost.missHigh, settings.cost === "off" ? "usd" : settings.cost);
		lines.push(`Approximate input cost of the next request (~${Math.round(cost.promptTokens)} prompt tokens; response generation excluded; Pi catalog estimate, not a bill): hit ${hit ?? "unknown"}, miss ${miss ?? "unknown"}. Credits use 1 credit = $0.01 and apply only to credit-based plans; they are not your balance.`);
	} else lines.push("Approximate input cost: unknown (no prompt size or catalog price).");
	if (envelope) lines.push(`Observed candidate (not active): ${envelopeSummary(envelope)}. See /cache learn.`);
	lines.push("Not in V1: confidence intervals, partial-hit calibration, compaction estimates, blocking confirmations, or automatic warming. Nothing here spends money.");
	return lines.join("\n");
}

function envelopeSummary(e) {
	const c = (k) => `${k} clock hit ≤${minutes(e.clocks[k].hitObservedMs)}, first later zero ${minutes(e.clocks[k].expiryObservedMs)}`;
	return `${e.strong} strong pairs; ${c("start")}; ${c("end")}`;
}

export function learnText(envelopes, profiles) {
	if (!envelopes.length) return "No pairs yet. Import history (/cache import) or turn recording on (/cache on).";
	const lines = ["Observed candidate envelopes (data-derived; the active profile changes only through /cache seed):"];
	for (const e of envelopes) {
		const p = profiles.find((x) => x.provider === e.provider && sameModelId(x.model, e.model));
		lines.push(`${display(e.provider, 60)}/${display(e.model, 80)}: ${e.pairs} pairs (${e.origins.historical} historical, ${e.origins.live} live, ${e.origins.both} both); ${e.qualified} qualified (${e.strong} strong, ${e.weak} weak).`);
		for (const k of ["start", "end"]) {
			const c = e.clocks[k];
			lines.push(`  ${k} clock: longest positive-read gap ${minutes(c.hitObservedMs)}; earliest longer zero-read gap ${minutes(c.expiryObservedMs)}; ${c.positives} positive, ${c.zeros} zero (${c.longZeros} beyond, ${c.contradictoryZeros} contradictory, not expiry).`);
		}
		const ex = Object.entries(e.excluded).map(([r, n]) => `${display(r, 30)}=${n}`);
		lines.push(`  excluded: ${ex.length ? ex.join(", ") : "none"}. Active profile: ${p ? `${minutes(p.hitUnderMs)} / ${minutes(p.expireOverMs)} (${display(p.source, 20)})` : "none"}.`);
	}
	lines.push("Envelopes are observations, not a 95% guarantee.");
	return lines.join("\n");
}

export function importText(s) {
	const ex = Object.entries(s.pairs.excluded).map(([r, n]) => `${r}=${n}`);
	const errs = Object.entries(s.parseErrors).filter(([, n]) => n).map(([r, n]) => `${r}=${n}`);
	const skipped = Object.entries(s.files).filter(([k, n]) => k !== "scanned" && n).map(([r, n]) => `${r}=${n}`);
	return [
		`Imported metadata from ${s.files.scanned} session file(s)${skipped.length ? ` (skipped: ${skipped.join(", ")})` : ""}; ${s.lines} lines${errs.length ? ` (parse errors: ${errs.join(", ")})` : ""}.`,
		`Responses: ${s.responses.matched} matched, ${s.responses.added} added, ${s.responses.duplicate} already present, ${s.responses.missing_start} without a request start (kept; excluded from timing learning).`,
		`Warms: ${s.warms.matched} matched, ${s.warms.added} added. Pairs: ${s.pairs.added} added (${s.pairs.qualified} qualified), ${s.pairs.duplicate} already present${ex.length ? `; excluded: ${ex.join(", ")}` : ""}.`,
	].join("\n");
}

export function historyText(rows, time) {
	if (!rows.length) return "No samples recorded yet.";
	const n = (v) => (typeof v === "number" ? String(v) : "?");
	return [
		`Last ${rows.length} sample(s), oldest first (metadata only; costs are Pi catalog estimates in USD):`,
		...rows.map(
			(r) =>
				`${dateTime(r.request_start_ms ?? r.end_ms, time)} ${display(r.origin, 12)} ${display(r.kind, 12)} ${display(r.provider ?? "?", 60)}/${display(r.model ?? "?", 80)} stop=${display(r.stop_reason ?? "-", 12)} in=${n(r.input)} cacheRead=${n(r.cache_read)} cacheWrite=${n(r.cache_write)} out=${n(r.output)} cost=${typeof r.cost_total === "number" ? `$${r.cost_total.toFixed(6)}` : "?"} end=${display(r.end_provenance, 30)}`,
		),
	].join("\n");
}
