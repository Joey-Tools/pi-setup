// Observed-envelope learner. Data-derived candidates only: it never writes or changes a stored (seeded) profile.
// Per clock, H is the longest qualified gap with a provider-reported positive cache read, and Z is the earliest
// qualified zero-read gap strictly greater than H. Zero reads at or below H contradict expiry and are counted, not
// used as a minimum TTL. No gap bins, windows, or percentage thresholds. Separately, a bounded eligibility count
// (valid gaps within the profile limit only) decides whether a model without a seed gets an automatic, provisional
// profile, which is derived on read and never stored.
import { MAX_PROFILE_MINUTES } from "./db.mjs";
import { MINUTE_MS, normalizeModel, safeId, sameModelId } from "./util.mjs";

const CLOCKS = { start: "gapStartMs", end: "gapEndMs" };

function envelope(pairs, field) {
	const positives = pairs.filter((p) => typeof p[field] === "number" && p.cacheRead > 0);
	const zeros = pairs.filter((p) => typeof p[field] === "number" && p.cacheRead === 0);
	let H = null;
	for (const p of positives) if (H === null || p[field] > H) H = p[field];
	const longZeros = H === null ? [] : zeros.filter((p) => p[field] > H);
	return {
		hitObservedMs: H,
		expiryObservedMs: longZeros.reduce((min, p) => (min === null || p[field] < min ? p[field] : min), null),
		positives: positives.length,
		zeros: zeros.length,
		contradictoryZeros: H === null ? 0 : zeros.length - longZeros.length,
		longZeros: longZeros.length,
	};
}

/** Stored pair rows grouped per provider/normalized model (known Opus alias together), optionally for one model. */
function groupPairs(rows, { provider, model } = {}) {
	const groups = new Map();
	for (const p of rows) {
		if (provider && model && (p.provider !== provider || !sameModelId(p.model, model))) continue;
		const k = `${p.provider}\0${normalizeModel(p.model)}`;
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(p);
	}
	return [...groups.values()];
}

const strongOf = (pairs) => pairs.filter((p) => p.qualified && p.tier === "strong");

function envelopeOf(pairs) {
	const qualified = pairs.filter((p) => p.qualified);
	const strong = qualified.filter((p) => p.tier === "strong");
	const excluded = {};
	for (const p of pairs) if (!p.qualified) excluded[p.exclusion] = (excluded[p.exclusion] ?? 0) + 1;
	return {
		provider: pairs[0].provider,
		model: normalizeModel(pairs[0].model),
		models: [...new Set(pairs.map((p) => p.model))].sort(),
		pairs: pairs.length,
		qualified: qualified.length,
		strong: strong.length,
		weak: qualified.length - strong.length,
		excluded,
		origins: Object.fromEntries(["historical", "live", "both"].map((o) => [o, pairs.filter((p) => p.origin === o).length])),
		clocks: Object.fromEntries(Object.entries(CLOCKS).map(([name, field]) => [name, envelope(strong, field)])),
	};
}

/**
 * Candidate envelopes per provider/model from stored pairs, grouping the known Opus alias together (`model` is the
 * normalized id, `models` the raw ids seen). Uses the strong tier (previous response had a positive cache read);
 * weak-tier and excluded pairs are reported as counts.
 */
export function learnEnvelopes(db, ref = {}) {
	return groupPairs(db.pairs(), ref).map(envelopeOf);
}

export const EVIDENCE_MISSING = Object.freeze(["no_pairs", "no_qualified", "no_strong", "no_positive", "no_long_zero:start", "no_long_zero:end"]);
export const EVIDENCE_STAGES = Object.freeze(["none", "partial", "both_clocks"]);

const emptyClock = () => ({ hitObservedMs: null, expiryObservedMs: null, positives: 0, zeros: 0, contradictoryZeros: 0, longZeros: 0 });
const emptyResponses = () => ({
	total: 0,
	historical: 0,
	live: 0,
	missingStart: 0,
	cacheReadPositive: 0,
	cacheReadUnknown: 0,
	endFallback: 0,
	timeUnknown: 0,
	firstMs: null,
	firstSource: null,
	lastMs: null,
	lastSource: null,
});

/** Keeps the earlier (or later) of the current and a candidate time; on a tie a request start wins over an end proxy. */
function pick(s, which, ms, source) {
	if (ms === null) return;
	const [key, src] = which === "first" ? ["firstMs", "firstSource"] : ["lastMs", "lastSource"];
	const better = s[key] === null || (which === "first" ? ms < s[key] : ms > s[key]) || (ms === s[key] && source === "request_start");
	if (better) Object.assign(s, { [key]: ms, [src]: source });
}

// Automatic-profile eligibility: a fixed engineering rule (counts of specific pair types), not a confidence level.
export const AUTO_MIN_REUSE_PAIRS = 2;
export const AUTO_MIN_LATER_MISSES = 2;
// `invalid_evidence` is for malformed decision input only; the evidence report always provides valid counts.
export const AUTO_BLOCKERS = Object.freeze(["reuse_pairs", "later_misses:start", "later_misses:end", "nonpositive_hit", "beyond_limit", "invalid_evidence"]);
export const AUTO_POLICY = Object.freeze({ minReusePairs: AUTO_MIN_REUSE_PAIRS, minLaterMissesPerClock: AUTO_MIN_LATER_MISSES, maxMinutes: MAX_PROFILE_MINUTES });
const AUTO_MAX_MS = MAX_PROFILE_MINUTES * MINUTE_MS;

const boundedGap = (g) => typeof g === "number" && Number.isFinite(g) && g >= 0 && g <= AUTO_MAX_MS;

/**
 * Bounded eligibility counts per clock from one model's stored pairs, counting only qualified strong pairs whose gap
 * on that clock is a finite, nonnegative value within the profile limit: `reuses` (positive cache read),
 * `laterMisses` (cache read exactly 0 at a gap strictly beyond that clock's raw H), and `firstLaterMissMs` (the
 * earliest such miss). `hitObservedMs` is the raw learner H, so an unsupported H (over the limit) is not ignored.
 * Gaps outside the limit are never clamped; they stay visible in the raw envelope but are not counted here.
 */
function eligibilityOf(pairs, env) {
	const strong = strongOf(pairs);
	const out = { maxGapMs: AUTO_MAX_MS };
	for (const [name, field] of Object.entries(CLOCKS)) {
		const H = env ? env.clocks[name].hitObservedMs : null;
		const c = { hitObservedMs: H, reuses: 0, laterMisses: 0, firstLaterMissMs: null };
		for (const p of strong) {
			const g = p[field];
			if (!boundedGap(g)) continue;
			if (p.cacheRead > 0) c.reuses++;
			else if (p.cacheRead === 0 && H !== null && g > H) {
				c.laterMisses++;
				if (c.firstLaterMissMs === null || g < c.firstLaterMissMs) c.firstLaterMissMs = g;
			}
		}
		out[name] = c;
	}
	return out;
}

const count = (n) => Number.isInteger(n) && n >= 0;
const pendingInvalid = () => ({
	status: "pending",
	requirements: { reusePairs: { have: 0, need: AUTO_MIN_REUSE_PAIRS }, laterMisses: { start: { have: 0, need: AUTO_MIN_LATER_MISSES }, end: { have: 0, need: AUTO_MIN_LATER_MISSES } } },
	blockers: ["invalid_evidence"],
	profile: null,
});

/**
 * Pure decision for an automatic, provisional profile from bounded eligibility counts (an evidence entry's
 * `eligibility`): { start, end }, each { hitObservedMs, reuses, laterMisses, firstLaterMissMs }. Eligible with at
 * least 2 reuses (the smaller clock count) and at least 2 later misses on each clock, H finite with 0 < H <= limit,
 * and the first later miss finite with H < Z <= limit on each clock. Then hit = min(H start, H end) and
 * expire = max(Z start, Z end): the full observed band, uncertain in between. Missing or malformed input fails
 * closed (pending, `invalid_evidence`, no profile); nothing is ever clamped. A later, longer hit can remove
 * eligibility again.
 */
export function autoDecision(eligibility) {
	const clocks = Object.keys(CLOCKS).map((k) => eligibility?.[k]);
	const shaped = (c) =>
		c !== null && typeof c === "object" && count(c.reuses) && count(c.laterMisses) && (c.hitObservedMs === null || typeof c.hitObservedMs === "number") && (c.firstLaterMissMs === null || typeof c.firstLaterMissMs === "number");
	if (!clocks.every(shaped)) return pendingInvalid();
	const [start, end] = clocks;
	const reuse = Math.min(start.reuses, end.reuses);
	const blockers = new Set();
	if (reuse < AUTO_MIN_REUSE_PAIRS) blockers.add("reuse_pairs");
	if (start.laterMisses < AUTO_MIN_LATER_MISSES) blockers.add("later_misses:start");
	if (end.laterMisses < AUTO_MIN_LATER_MISSES) blockers.add("later_misses:end");
	for (const c of clocks) {
		if (c.hitObservedMs === null) continue;
		if (!Number.isFinite(c.hitObservedMs) || c.hitObservedMs > AUTO_MAX_MS) blockers.add("beyond_limit");
		else if (c.hitObservedMs <= 0) blockers.add("nonpositive_hit");
	}
	if (!blockers.size) {
		const sound = (c) =>
			Number.isFinite(c.hitObservedMs) && c.hitObservedMs > 0 && c.hitObservedMs <= AUTO_MAX_MS && Number.isFinite(c.firstLaterMissMs) && c.firstLaterMissMs > c.hitObservedMs && c.firstLaterMissMs <= AUTO_MAX_MS;
		if (!clocks.every(sound)) blockers.add("invalid_evidence");
	}
	const eligible = blockers.size === 0;
	return {
		status: eligible ? "eligible" : "pending",
		requirements: {
			reusePairs: { have: reuse, need: AUTO_MIN_REUSE_PAIRS },
			laterMisses: { start: { have: start.laterMisses, need: AUTO_MIN_LATER_MISSES }, end: { have: end.laterMisses, need: AUTO_MIN_LATER_MISSES } },
		},
		blockers: AUTO_BLOCKERS.filter((b) => blockers.has(b)),
		profile: eligible ? { hitUnderMs: Math.min(start.hitObservedMs, end.hitObservedMs), expireOverMs: Math.max(start.firstLaterMissMs, end.firstLaterMissMs), source: "auto" } : null,
	};
}

/**
 * What the stored evidence shows for one provider/model, from its envelope (or none). `missing` lists the first
 * unmet requirement for numbers to exist, then each clock still without a longer zero-read gap; `stage` is a
 * description (none, partial, both_clocks), not a confidence or progress measure, and it can move back when H grows.
 * `profile` is the stored (manual) profile only; `effective` and `effectiveProfile` say which profile the forecast
 * uses: manual, auto (derived, never stored), pending (automatic on, not eligible), or off.
 */
function describe(provider, model, env, responses, profile, auto, eligibility) {
	const clocks = Object.fromEntries(Object.keys(CLOCKS).map((k) => [k, { ...(env?.clocks[k] ?? emptyClock()) }]));
	for (const c of Object.values(clocks)) c.bandMs = c.hitObservedMs !== null && c.expiryObservedMs !== null ? c.expiryObservedMs - c.hitObservedMs : null;
	const missing = [];
	if (!env?.pairs) missing.push("no_pairs");
	else if (!env.qualified) missing.push("no_qualified");
	else if (!env.strong) missing.push("no_strong");
	else if (Object.values(clocks).every((c) => c.hitObservedMs === null)) missing.push("no_positive");
	else for (const k of Object.keys(CLOCKS)) if (clocks[k].expiryObservedMs === null) missing.push(`no_long_zero:${k}`);
	const anyHit = Object.values(clocks).some((c) => c.hitObservedMs !== null);
	const manual = profile ? { hitUnderMs: profile.hitUnderMs, expireOverMs: profile.expireOverMs, source: profile.source, setAt: profile.setAt } : null;
	const automatic = autoDecision(eligibility);
	const effective = manual ? "manual" : auto !== "on" ? "off" : automatic.status === "eligible" ? "auto" : "pending";
	return {
		provider,
		model,
		models: [...new Set([...(env?.models ?? []), ...responses.models])].sort(),
		responses: responses.stats,
		pairs: env?.pairs ?? 0,
		qualified: env?.qualified ?? 0,
		strong: env?.strong ?? 0,
		weak: env?.weak ?? 0,
		excluded: { ...(env?.excluded ?? {}) },
		origins: { historical: 0, live: 0, both: 0, ...(env?.origins ?? {}) },
		clocks,
		missing,
		stage: missing.length === 0 ? "both_clocks" : anyHit ? "partial" : "none",
		profile: manual,
		eligibility,
		automatic,
		auto: auto === "on" ? "on" : "off",
		effective,
		effectiveProfile: effective === "manual" ? manual : effective === "auto" ? { ...automatic.profile } : null,
	};
}

/**
 * The learner's envelopes plus an evidence summary per provider/model: response counts and first/latest response
 * times from every stored sample, the envelope, missing evidence, and the active profile (if seeded). With a
 * `provider`/`model` filter, exactly that model is described, even with no data. Without one, every model that has
 * responses, pairs, or a profile is included. `auto` (default: the saved setting) decides whether an eligible model
 * gets an automatic effective profile, decided from each entry's bounded `eligibility` counts (computed from the same
 * pair rows as the envelopes, read once). Read-only: nothing is stored, and a stored (manual) profile is never changed.
 */
export function evidenceReport(db, { provider, model, auto = db.settings().auto } = {}) {
	const ref = provider && model ? { provider, model } : null;
	const rowGroups = groupPairs(db.pairs(), ref ?? {});
	const envelopes = rowGroups.map(envelopeOf);
	const groups = new Map();
	const group = (p, m) => {
		const k = `${p}\0${normalizeModel(m)}`;
		if (!groups.has(k)) groups.set(k, { provider: p, model: normalizeModel(m), env: null, pairs: [], responses: { stats: emptyResponses(), models: [] } });
		return groups.get(k);
	};
	const wanted = (p, m) => Boolean(safeId(p) && safeId(m)) && (!ref || (p === ref.provider && sameModelId(m, ref.model)));
	if (ref) group(ref.provider, ref.model);
	envelopes.forEach((e, i) => {
		if (!wanted(e.provider, e.model)) return;
		Object.assign(group(e.provider, e.model), { env: e, pairs: rowGroups[i] });
	});
	for (const r of db.responseStats()) {
		if (!wanted(r.provider, r.model)) continue;
		const g = group(r.provider, r.model).responses;
		const s = g.stats;
		g.models.push(r.model);
		s.total += r.responses;
		if (r.origin === "historical" || r.origin === "live") s[r.origin] += r.responses;
		s.missingStart += r.missingStart;
		s.cacheReadPositive += r.cacheReadPositive;
		s.cacheReadUnknown += r.cacheReadUnknown;
		s.endFallback += r.endFallback;
		s.timeUnknown += r.timeUnknown;
		pick(s, "first", r.firstStartMs, "request_start");
		pick(s, "first", r.firstEndMs, "completion_proxy");
		pick(s, "last", r.lastStartMs, "request_start");
		pick(s, "last", r.lastEndMs, "completion_proxy");
	}
	if (!ref) for (const p of db.listProfiles()) group(p.provider, p.model);
	const evidence = [...groups.values()]
		.map((g) => describe(g.provider, g.model, g.env, g.responses, db.getProfile(g.provider, g.model), auto, eligibilityOf(g.pairs, g.env)))
		.sort((a, b) => (a.provider === b.provider ? (a.model < b.model ? -1 : a.model > b.model ? 1 : 0) : a.provider < b.provider ? -1 : 1));
	return { envelopes, evidence };
}
