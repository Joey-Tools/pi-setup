// Observed-envelope learner. Data-derived candidates only: it never changes the user-approved active profile.
// Per clock, H is the longest qualified gap with a provider-reported positive cache read, and Z is the earliest
// qualified zero-read gap strictly greater than H. Zero reads at or below H contradict expiry and are counted, not
// used as a minimum TTL. No gap bins, windows, or percentage thresholds.

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

/**
 * Candidate envelopes per provider/model from stored pairs. Uses the strong tier (previous response had a
 * positive cache read); weak-tier and excluded pairs are reported as counts.
 */
export function learnEnvelopes(db, { provider, model } = {}) {
	const groups = new Map();
	for (const p of db.pairs(provider && model ? { provider, model } : {})) {
		const k = `${p.provider}\0${p.model}`;
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(p);
	}
	return [...groups.values()].map((pairs) => {
		const qualified = pairs.filter((p) => p.qualified);
		const strong = qualified.filter((p) => p.tier === "strong");
		const excluded = {};
		for (const p of pairs) if (!p.qualified) excluded[p.exclusion] = (excluded[p.exclusion] ?? 0) + 1;
		return {
			provider: pairs[0].provider,
			model: pairs[0].model,
			pairs: pairs.length,
			qualified: qualified.length,
			strong: strong.length,
			weak: qualified.length - strong.length,
			excluded,
			origins: Object.fromEntries(["historical", "live", "both"].map((o) => [o, pairs.filter((p) => p.origin === o).length])),
			clocks: Object.fromEntries(Object.entries(CLOCKS).map(([name, field]) => [name, envelope(strong, field)])),
		};
	});
}
