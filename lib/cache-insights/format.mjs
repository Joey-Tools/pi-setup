// Display text for the status bar and /cache output. Every untrusted value passes through display().
import { MAX_PROFILE_MINUTES } from "./db.mjs";
import { display, MINUTE_MS, parseModelRef } from "./util.mjs";

const pad = (n) => String(n).padStart(2, "0");

/** "UTC" for a zero offset, else "UTC+9", "UTC-5", "UTC+5:30": the local offset in effect at `d` itself. */
function zoneOf(d) {
	const offset = -d.getTimezoneOffset();
	const abs = Math.abs(offset);
	return offset === 0 ? "UTC" : `UTC${offset < 0 ? "-" : "+"}${Math.floor(abs / 60)}${abs % 60 ? `:${pad(abs % 60)}` : ""}`;
}

/**
 * Absolute clock time with its zone, never a countdown: "18:15 UTC", "18:15 UTC+1", "18:15 UTC+5:30", "18:15 UTC-5".
 * The time is rounded down (or up with `ceil`) to the minute, and a local offset is that of the shown time itself,
 * so a deadline after a daylight-saving change carries the new offset.
 */
export function clockTime(ms, time = "local", ceil = false) {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "unknown";
	const d = new Date((ceil ? Math.ceil : Math.floor)(ms / MINUTE_MS) * MINUTE_MS);
	if (time === "utc") return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
	return `${pad(d.getHours())}:${pad(d.getMinutes())} ${zoneOf(d)}`;
}

/** Date and time with its zone: ISO "…Z" in UTC mode, else "2026-10-29 13:05 UTC+1" with that date's own offset. */
export function zonedDateTime(ms, time = "local") {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "unknown";
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return "unknown";
	if (time === "utc") return d.toISOString().replace(/\.\d{3}Z$/, "Z");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${zoneOf(d)}`;
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
	baseline_unknown: "configuration not verifiable",
};
export const reasonText = (r, kind) => (r === "between_thresholds" && kind === "auto" ? "between automatic thresholds (provisional)" : (REASONS[r] ?? "unknown"));

const shortMinutes = (ms) => (ms / MINUTE_MS).toFixed(1);
const capped = (r) => `${Math.min(r.have, r.need)}/${r.need}`;

/**
 * Footer progress toward an automatic profile for a model without a seed: the eligibility counters (capped at their
 * target), or the reason no counter applies yet. Not a percentage, confidence, or date.
 */
function learningParts(e, recording) {
	const d = e.automatic;
	const first = e.missing[0];
	const why = { no_pairs: "learning: no pairs yet", no_qualified: "learning: no usable pairs yet", no_strong: "learning: no pairs after a cache read yet" }[first];
	// H never decreases, so a reuse gap over the limit is not something more data can fix: no "learning" wording.
	if (d.blockers.includes("beyond_limit")) return ["no automatic profile: range over 24 h", "/cache"];
	if (d.blockers.includes("invalid_evidence")) return ["no automatic profile: evidence not usable", "/cache"];
	let what;
	if (why) what = why;
	else if (d.blockers.includes("nonpositive_hit")) what = "learning: longest reuse gap is 0";
	else {
		const { reusePairs, laterMisses } = d.requirements;
		const [start, end] = [capped(laterMisses.start), capped(laterMisses.end)];
		what = `learning: reuses ${capped(reusePairs)}, later misses ${start === end ? start : `start ${start}, end ${end}`}`;
	}
	return [what, ...(recording ? [] : ["recording off"]), "/cache"];
}

/**
 * Short status-bar text, e.g. "cache hit · until 14:32 · miss ≈$0.21–$0.26". `extra` is given only for automatic
 * profiles: { profileKind: "auto", profile } tags the forecast "auto (provisional)" (with the learned range while
 * between its thresholds); { profileKind: "pending", evidence, recording } shows the learning counters instead of
 * "no seeded profile". Without `extra` the text is exactly the manual-profile format.
 */
export function statusLine(f, cost, settings, extra = {}) {
	if (extra.profileKind === "pending" && f.reason === "no_profile" && extra.evidence) return [f.label, ...learningParts(extra.evidence, extra.recording)].join(" · ");
	const parts = [f.label];
	if (f.state === "hit") parts.push(`until ${clockTime(f.hitUntil, settings.time)}`);
	else if (f.state === "uncertain") {
		if (f.reason === "between_thresholds" && f.expiredAfter !== null) parts.push(`expired after ${clockTime(f.expiredAfter, settings.time, true)}`);
		else parts.push(reasonText(f.reason));
	}
	if (extra.profileKind === "auto" && extra.profile) {
		const p = extra.profile;
		parts.push(f.reason === "between_thresholds" ? `auto (provisional) ${shortMinutes(p.hitUnderMs)}–${shortMinutes(p.expireOverMs)} min` : "auto (provisional)");
	}
	const miss = cost && f.reason !== "no_profile" ? money(cost.missLow, cost.missHigh, settings.cost) : null;
	if (miss && f.state !== "expired") parts.push(`miss ≈${miss}`);
	else if (miss) parts.push(`≈${miss}`);
	return parts.join(" · ");
}

/**
 * The footer text styled with the current Pi theme: everything dim, except the "cache expired" label, which uses the
 * `warning` colour of Pi's own cache-miss notices. Plain text when there is no usable theme. Commands and stored data
 * never contain styling.
 */
export function themedStatus(plain, f, theme) {
	if (typeof plain !== "string" || typeof theme?.fg !== "function") return plain;
	try {
		const fg = (token, text) => {
			const out = theme.fg(token, text);
			if (typeof out !== "string") throw new Error("theme");
			return out;
		};
		if (f?.state === "expired" && plain.startsWith(f.label)) {
			const rest = plain.slice(f.label.length);
			return fg("warning", f.label) + (rest ? fg("dim", rest) : "");
		}
		return fg("dim", plain);
	} catch {
		return plain;
	}
}

/** Multi-line /cache status details. */
export function statusDetails({ db, settings, model, profile, profileKind, anchor, forecast: f, cost, envelope, evidence, recording, failure }) {
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
	if (!profile) {
		const auto = profileKind === "pending" ? " Automatic profiles are on; this model is still learning (see Evidence below)." : settings.auto === "off" ? " Automatic profiles are off." : "";
		lines.push(`Active profile: none for this model (other models' seeds are never reused).${auto}`);
	} else if (profileKind === "auto") {
		lines.push(`Active profile (automatic, provisional; derived from stored evidence, never stored): cache hit while both clocks are under ${minutes(profile.hitUnderMs)}; cache expired once both are over ${minutes(profile.expireOverMs)}; uncertain in between and at the edges. A seed for this model always replaces it.`);
	} else lines.push(`Active profile (${display(profile.source, 20)}): cache hit while both clocks are under ${minutes(profile.hitUnderMs)}; cache expired once both are over ${minutes(profile.expireOverMs)}; uncertain in between and at the edges.`);
	if (anchor) {
		lines.push(`Anchor: previous response (${anchor.provenance === "message_end_received" ? "observed live; end = message_end receipt" : "recovered from the current branch; end = saved entry time (proxy)"}).`);
		lines.push(`  since request start: ${minutes(f.elapsedStartMs)} (started ${dateTime(anchor.startWall, t)})`);
		lines.push(`  since response end:  ${minutes(f.elapsedEndMs)} (ended ${dateTime(anchor.endWall, t)}); clock check: ${f.clock}`);
	} else lines.push("Anchor: none usable.");
	let verdict = `Forecast for the next request: ${f.label}`;
	if (f.state === "hit") verdict += ` until ${dateTime(f.hitUntil, t)}`;
	else if (f.state === "uncertain") verdict += ` (${reasonText(f.reason, profileKind)})${f.expiredAfter !== null && f.reason === "between_thresholds" ? `; cache expired after ${dateTime(f.expiredAfter, t)}` : ""}`;
	if (profileKind === "auto" && f.state !== "uncertain") verdict += " (automatic, provisional)";
	lines.push(`${verdict}.`);
	if (cost) {
		const hit = money(cost.hit, null, settings.cost === "off" ? "usd" : settings.cost);
		const miss = money(cost.missLow, cost.missHigh, settings.cost === "off" ? "usd" : settings.cost);
		lines.push(`Approximate input cost of the next request (~${Math.round(cost.promptTokens)} prompt tokens; response generation excluded; Pi catalog estimate, not a bill): hit ${hit ?? "unknown"}, miss ${miss ?? "unknown"}. Credits use 1 credit = $0.01 and apply only to credit-based plans; they are not your balance.`);
	} else lines.push("Approximate input cost: unknown (no prompt size or catalog price).");
	if (envelope) lines.push(`Observed candidate (${profileKind === "auto" ? "in use as the automatic profile" : "not active"}): ${envelopeSummary(envelope)}. See /cache learn.`);
	if (evidence) {
		lines.push(`Evidence for this model (observations; with automatic profiles on they can derive a provisional profile, never a stored one; /cache learn explains how to read them): ${responsesText(evidence, t)}`);
		lines.push(`  ${evidenceText(evidence)}`);
		lines.push(`  ${activationText(evidence, model)}`);
		if (profile && f.state === "uncertain" && f.reason !== "between_thresholds") {
			lines.push(`  The current "uncertain" (${reasonText(f.reason)}) is separate from the profile and is not a sample-count threshold. Depending on its cause, time passing, a new usable response, or a session or configuration change can resolve it.`);
		}
		lines.push(`  ${recordingText(recording)}`);
	}
	lines.push("Not in V1: confidence intervals, partial-hit calibration, compaction estimates, blocking confirmations, or automatic warming. Nothing here spends money.");
	return lines.join("\n");
}

function envelopeSummary(e) {
	const c = (k) => `${k} clock hit ≤${minutes(e.clocks[k].hitObservedMs)}, first later zero ${minutes(e.clocks[k].expiryObservedMs)}`;
	return `${e.strong} strong pairs; ${c("start")}; ${c("end")}`;
}

const ref = (e) => `${display(e.provider, 60)}/${display(e.model, 80)}`;

const when = (ms, source, time) => `${zonedDateTime(ms, time)}${source === "completion_proxy" ? " (saved completion time; no valid request start)" : ""}`;

/** Response counts and first/latest response times (request starts, or a completion proxy) of one evidence entry. */
function responsesText(e, time) {
	const r = e.responses;
	const span = r.total ? `, first ${when(r.firstMs, r.firstSource, time)}, latest ${when(r.lastMs, r.lastSource, time)}` : "";
	const reads = r.total ? `; ${r.cacheReadPositive} reported a positive cache read${r.cacheReadUnknown ? `, ${r.cacheReadUnknown} did not report a cache-read count` : ""}` : "";
	const noStart = r.missingStart ? `; ${r.missingStart} without a request start` : "";
	const noTime = r.timeUnknown ? `; ${r.timeUnknown} with no valid time` : "";
	return `${r.total} responses (${r.historical} historical, ${r.live} live)${span}${reads}${noStart}${noTime}; ${e.strong} strong of ${e.pairs} pairs.`;
}

const MISSING = {
	no_pairs: "no pairs yet (a pair needs two successive successful responses of this model with nothing in between that can change the cached prefix)",
	no_qualified: "no qualified pairs (every pair was excluded; see the excluded counts)",
	no_strong: "no strong pairs (no qualified pair whose previous response reported a cache read above 0)",
	no_positive: "no strong pair with a cache read yet, so neither clock has a longest hit gap",
};

function missingText(code, e) {
	const m = /^no_long_zero:(start|end)$/.exec(code);
	if (m) return `${m[1]} clock has no strong zero-read gap longer than its longest hit (${minutes(e.clocks[m[1]].hitObservedMs)}) yet`;
	return MISSING[code] ?? "unknown";
}

const bracket = (c) => `${minutes(c.hitObservedMs)} hit to ${minutes(c.expiryObservedMs)} zero (band ${minutes(c.bandMs)})`;

/** Both-clock brackets, or what is still missing; descriptive only, never a progress measure. */
function evidenceText(e) {
	const both = ["start", "end"].map((k) => `${k} ${bracket(e.clocks[k])}`);
	if (e.stage === "both_clocks") return `Both clocks bracketed (observed, not confirmed): ${both.join("; ")}. No eligible strong timing observations between these endpoints (weak and excluded pairs are not used here).`;
	const missing = `Missing: ${e.missing.map((c) => missingText(c, e)).join("; ")}.`;
	if (e.stage === "none") return `No candidate numbers yet. ${missing}`;
	const clock = (k) => (e.clocks[k].bandMs !== null ? `${k} ${bracket(e.clocks[k])}` : `${k} ${minutes(e.clocks[k].hitObservedMs)} hit, no longer zero yet`);
	return `Partial: ${["start", "end"].map(clock).join("; ")}. ${missing}`;
}

/** The full, copyable seed command for `target`, only when /cache seed would accept exactly this provider/model. */
function seedCommand(target) {
	const r = target ? parseModelRef(`${target.provider}/${target.model}`) : null;
	if (!r || r.provider !== target.provider || r.model !== target.model) return null;
	return `/cache seed ${display(r.provider, 200)}/${display(r.model, 200)} <hitMinutes> <expireMinutes>`;
}

const RULE = `at least 2 strong reuse pairs (a positive cache read after a previous cache read) and, on each clock, at least 2 strong later misses (zero reads at gaps beyond its longest reuse), counting only gaps within the ${MAX_PROFILE_MINUTES}-minute profile limit`;

/** Raw later zero reads (shown in the envelope) that the bounded eligibility count leaves out, per clock. */
function outsideText(e) {
	const out = ["start", "end"].map((k) => [k, Math.max(0, e.clocks[k].longZeros - (e.eligibility?.[k]?.laterMisses ?? 0))]).filter(([, n]) => n > 0);
	if (!out.length) return "";
	return ` Not counted: ${out.map(([k, n]) => `${n} later zero read(s) on the ${k} clock beyond the ${MAX_PROFILE_MINUTES}-minute limit or with unusable timing`).join("; ")} (still shown in the counts above; never clamped).`;
}

/** The eligibility counters in full, e.g. "reuses 3 (need 2), later misses start 0 (need 2), end 0 (need 2)". */
function countersText(d) {
	const { reusePairs: r, laterMisses: z } = d.requirements;
	return `reuses ${r.have} (need ${r.need}), later misses start ${z.start.have} (need ${z.start.need}), end ${z.end.have} (need ${z.end.need})`;
}

/** Which profile decides this model's forecast (manual, automatic, learning, or off), and how to set one yourself. */
function activationText(e, target) {
	const seed = seedCommand(target) ?? "/cache seed <provider/model> <hitMinutes> <expireMinutes> with a valid provider/model";
	if (e.effective === "manual") {
		return `The active profile (${display(e.profile.source, 20)}: ${minutes(e.profile.hitUnderMs)} / ${minutes(e.profile.expireOverMs)}) decides the forecast; this evidence is shown for comparison and never changes it. Automatic profiles never replace a seed.`;
	}
	if (e.effective === "auto") {
		const p = e.effectiveProfile;
		return `Automatic profile in use (provisional; derived from stored evidence whenever it changes, never stored): cache hit while both clocks are under ${minutes(p.hitUnderMs)} (the shorter clock's longest reuse), cache expired once both are over ${minutes(p.expireOverMs)} (the later clock's earliest later miss), uncertain in between (band ${minutes(p.expireOverMs - p.hitUnderMs)}). It meets the eligibility rule (${countersText(e.automatic)}): ${RULE}.${outsideText(e)} That is an engineering rule, not a confidence level, a count of independent trials, or a confirmed cache lifetime, and new evidence can change or withdraw it. A seed of your own minutes always replaces it: ${seed}, or "Seed or edit a model profile" in the /cache menu.`;
	}
	if (e.effective === "pending") {
		const b = e.automatic.blockers;
		const manual = `A manual seed of your own minutes needs no data and always wins: ${seed}, or "Seed or edit a model profile" in the /cache menu.`;
		if (b.includes("beyond_limit")) {
			return `No automatic profile for this model: its longest reuse gap is beyond the ${MAX_PROFILE_MINUTES}-minute profile limit, and that gap never shrinks, so more data cannot make it eligible (values are never clamped). The forecast stays uncertain. ${manual}`;
		}
		if (b.includes("invalid_evidence")) return `No automatic profile for this model: its evidence is not usable for one. The forecast stays uncertain. ${manual}`;
		const zero = b.includes("nonpositive_hit") ? " The longest reuse gap is 0, so no automatic profile is derived yet." : "";
		return `No profile yet: automatic profiles are on, and this model has ${countersText(e.automatic)}. An automatic, provisional profile needs ${RULE}. These are eligibility requirements, not a confidence level, and there is no date: a later miss appears only when normal use has a pause longer than the longest reuse.${outsideText(e)}${zero} Until then the forecast stays uncertain. ${manual}`;
	}
	return `Automatic profiles are off (/cache settings auto on turns them on), so without a seed this model stays "uncertain · no seeded profile for this model". To activate one, choose your own minutes: ${seed}, or "Seed or edit a model profile" in the /cache menu.`;
}

function recordingText(recording) {
	return recording
		? "Recording is on: new responses are added as they happen. This is a snapshot, not a countdown; reopen it for fresh counts."
		: "Recording is off: stored evidence is still used, but counts change only through an explicit import. A bare /cache import covers seeded models only; name any other model (/cache import provider/model, or the current model in the /cache menu's import).";
}

const LEARN_NOTES = [
	"How to read this (observations only; there is no fixed sample target, promised arrival date, or confidence level):",
	'- "Strong" means the previous response reported a cache read above 0. It is a pairing rule, not statistical strength or confidence.',
	"- First and latest are response request starts. A response without a valid request start uses its saved completion time instead (labeled), and one with neither counts as having no valid time. They are not when recording was turned on or an import ran.",
	"- A clock gets numbers once it has a strong pair with a cache read (H, the longest such gap) and a strong zero-read pair with a longer gap (Z). In theory two such pairs are enough: three successive responses if the first already reports a cache read, usually one more from a cold start. That is when numbers can exist, not a reliable sample size.",
	"- Evidence can move back: a later, longer hit raises H and can remove the current Z, and with it an automatic profile.",
	"- If your normal use has only short gaps, no number of responses shows where the cache expires. Nothing here asks you to wait, probe, or warm the cache.",
	`- Automatic profiles (on by default; /cache settings auto on|off): a model without a seed gets a provisional profile once it has ${RULE}. Hit = the shorter clock's longest reuse, expired = the later clock's earliest later miss, uncertain across the whole band in between. It is derived from stored metadata, never stored, and recomputed when the data changes.`,
	"- The 2 + 2 rule is an eligibility requirement, not a confidence level, a count of independent trials, or a confirmed cache lifetime. A wide band stays uncertain across its width.",
	"- Contradictory zeros (zero reads at or below the longest reuse) do not block it: they are treated as anomalies, not expiry, and are shown in the counts above.",
	"- A seed (/cache seed <provider/model> <hitMinutes> <expireMinutes>, or the /cache menu) always wins over an automatic profile and needs no data. The menu never fills a seed from automatic values.",
];

/** /cache learn text from evidenceReport(); `time` formats dates, `recording` explains how counts can change. */
export function learnText(report, { time = "local", recording = false } = {}) {
	const { evidence } = report;
	if (!evidence.length) return `No responses or pairs yet. Import history (/cache import) or turn recording on (/cache on). ${recordingText(recording)}`;
	const lines = ["Observed candidate envelopes (data-derived; a seed is changed only through /cache seed, and an automatic profile is never stored):"];
	for (const e of evidence) {
		const p = e.profile;
		const auto = e.effective === "auto" ? `${minutes(e.effectiveProfile.hitUnderMs)} / ${minutes(e.effectiveProfile.expireOverMs)} (automatic, provisional)` : null;
		lines.push(`${ref(e)}: ${e.pairs} pairs (${e.origins.historical} historical, ${e.origins.live} live, ${e.origins.both} both); ${e.qualified} qualified (${e.strong} strong, ${e.weak} weak).`);
		if (e.models.length > 1 || (e.models.length === 1 && e.models[0] !== e.model)) lines.push(`  reported ids: ${e.models.map((m) => display(m, 80)).join(", ")}.`);
		lines.push(`  ${responsesText(e, time)}`);
		if (e.pairs) {
			for (const k of ["start", "end"]) {
				const c = e.clocks[k];
				lines.push(`  ${k} clock: longest positive-read gap ${minutes(c.hitObservedMs)}; earliest longer zero-read gap ${minutes(c.expiryObservedMs)}; ${c.positives} positive, ${c.zeros} zero (${c.longZeros} beyond, ${c.contradictoryZeros} contradictory, not expiry).`);
			}
		}
		const ex = Object.entries(e.excluded).map(([r, n]) => `${display(r, 30)}=${n}`);
		lines.push(`  excluded: ${ex.length ? ex.join(", ") : "none"}. Active profile: ${p ? `${minutes(p.hitUnderMs)} / ${minutes(p.expireOverMs)} (${display(p.source, 20)})` : (auto ?? "none")}.`);
		lines.push(`  evidence: ${evidenceText(e)}`);
		lines.push(`  ${activationText(e, e)}`);
	}
	lines.push("Envelopes are observations, not a 95% guarantee.");
	lines.push(recordingText(recording), ...LEARN_NOTES);
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
