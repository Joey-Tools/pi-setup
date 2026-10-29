// Next-request forecast from the active seeded profile and the latest usable anchor, plus an approximate input-cost
// range. Pure functions; callers supply clocks. Labels: "cache hit", "uncertain", "cache expired".
import { num } from "./util.mjs";

export const LABELS = Object.freeze({ hit: "cache hit", uncertain: "uncertain", expired: "cache expired" });
// Wall vs monotonic sanity tolerance for live anchors (clock sanity, not a statistical bucket).
export const CLOCK_TOLERANCE_MS = 5000;

/**
 * @param profile { hitUnderMs, expireOverMs } or null
 * @param anchor  { startWall, endWall|null, endMono|null, provenance } or null
 * @param blocked a transition reason that makes the forecast uncertain, or null
 * Returns { state, label, reason, elapsedStartMs, elapsedEndMs, hitUntil, expiredAfter, clock }.
 */
export function forecast({ profile, anchor, blocked = null, nowWall, nowMono = null }) {
	const out = { state: "uncertain", label: LABELS.uncertain, reason: null, elapsedStartMs: null, elapsedEndMs: null, hitUntil: null, expiredAfter: null, clock: "unknown" };
	if (!profile) return { ...out, reason: "no_profile" };
	if (!anchor) return { ...out, reason: blocked ?? "no_anchor" };
	out.elapsedStartMs = num(anchor.startWall) === null ? null : nowWall - anchor.startWall;
	out.elapsedEndMs = num(anchor.endWall) === null ? null : nowWall - anchor.endWall;
	if (out.elapsedStartMs !== null) out.hitUntil = anchor.startWall + profile.hitUnderMs;
	if (out.elapsedEndMs !== null) out.expiredAfter = anchor.endWall + profile.expireOverMs;
	if (blocked) return { ...out, reason: blocked };
	if (out.elapsedStartMs === null || out.elapsedEndMs === null) return { ...out, reason: "end_unknown" };
	if (out.elapsedStartMs < 0 || out.elapsedEndMs < 0 || out.elapsedEndMs > out.elapsedStartMs) return { ...out, reason: "clock_anomaly", clock: "anomaly" };
	if (typeof anchor.endMono === "number" && typeof nowMono === "number") {
		const monoElapsed = nowMono - anchor.endMono;
		// Wall behind monotonic means the wall clock moved backward: never trust it for a hit. Wall ahead
		// (sleep or a forward change) is kept: provider-side time keeps passing while this machine sleeps.
		if (out.elapsedEndMs < monoElapsed - CLOCK_TOLERANCE_MS) return { ...out, reason: "clock_backward", clock: "anomaly" };
		out.clock = out.elapsedEndMs > monoElapsed + CLOCK_TOLERANCE_MS ? "wall_ahead" : "consistent";
	} else out.clock = "wall_only";
	if (out.elapsedStartMs < profile.hitUnderMs && out.elapsedEndMs < profile.hitUnderMs) return { ...out, state: "hit", label: LABELS.hit };
	if (out.elapsedStartMs > profile.expireOverMs && out.elapsedEndMs > profile.expireOverMs) return { ...out, state: "expired", label: LABELS.expired };
	return { ...out, reason: "between_thresholds" };
}

/**
 * Picks per-million-token prices for a prompt size from Pi's model cost: { input, output, cacheRead, cacheWrite,
 * tiers?: [{ inputTokensAbove, input, output, cacheRead, cacheWrite }] }, where a tier replaces the prices for
 * prompts larger than `inputTokensAbove`. Returns null (unknown) for an unrecognized tier shape, a missing input
 * price, or an all-zero price set, which usually means "not priced" rather than free.
 */
export function resolvePrices(cost, tokens) {
	if (!cost || typeof cost !== "object") return null;
	let prices = { input: num(cost.input), cacheRead: num(cost.cacheRead), cacheWrite: num(cost.cacheWrite) };
	if (cost.tiers !== undefined) {
		if (!Array.isArray(cost.tiers) || !cost.tiers.every((t) => t && typeof t === "object" && num(t.inputTokensAbove) !== null)) return null;
		let tier = null;
		for (const t of cost.tiers) if (tokens > t.inputTokensAbove && (!tier || t.inputTokensAbove > tier.inputTokensAbove)) tier = t;
		if (tier) prices = { input: num(tier.input), cacheRead: num(tier.cacheRead), cacheWrite: num(tier.cacheWrite) };
	}
	if (prices.input === null || Object.values(prices).every((v) => v === null || v === 0)) return null;
	return prices;
}

/**
 * Approximate input-only cost of the next request (USD; response generation excluded; a catalog estimate,
 * not a bill). `promptTokens` is the expected prompt size, `cachedTokens` the reusable prefix if the cache hits.
 * Missing prices give null, never zero.
 */
export function costRange({ cost, promptTokens, cachedTokens }) {
	if (num(promptTokens) === null || promptTokens <= 0) return null;
	const p = resolvePrices(cost, promptTokens);
	if (!p || p.input === null) return null;
	const perToken = (m) => m / 1e6;
	const cached = Math.min(num(cachedTokens) ?? 0, promptTokens);
	const hit = p.cacheRead === null ? null : cached * perToken(p.cacheRead) + (promptTokens - cached) * perToken(p.input);
	const cold = promptTokens * perToken(p.input);
	const write = p.cacheWrite !== null && p.cacheWrite > 0 ? promptTokens * perToken(p.cacheWrite) : null;
	return { hit, missLow: write === null ? cold : Math.min(cold, write), missHigh: write === null ? cold : Math.max(cold, write), promptTokens, cachedTokens: cached };
}
