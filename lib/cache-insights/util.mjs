// Shared value helpers for cache insights. Every value that reaches storage or the UI passes through these.
import crypto from "node:crypto";

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,159}$/;
export const STOP_REASONS = Object.freeze(["stop", "toolUse", "error", "aborted", "length", "unknown"]);
export const SUCCESS_STOPS = Object.freeze(["stop", "toolUse"]);
export const MINUTE_MS = 60_000;

export class CacheInsightsError extends Error {
	/** @param {string} code a fixed, display-safe reason code */
	constructor(code, message) {
		super(message);
		this.name = "CacheInsightsError";
		this.code = code;
	}
}

export const safeId = (v) => (typeof v === "string" && ID_RE.test(v) ? v : null);
export const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
export const stopReason = (v) => (STOP_REASONS.includes(v) ? v : "unknown");

export function timeMs(v) {
	if (typeof v === "number") return num(v);
	if (typeof v === "string") return num(Date.parse(v));
	return null;
}

const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "totalTokens"];
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite", "total"];

/** Numeric usage buckets only; null when the source has none. A reported 0 stays 0. */
export function pickUsage(usage) {
	if (!usage || typeof usage !== "object") return null;
	const out = {};
	for (const k of TOKEN_KEYS) out[k] = num(usage[k]);
	const cost = usage.cost && typeof usage.cost === "object" ? Object.fromEntries(COST_KEYS.map((k) => [k, num(usage.cost[k])])) : null;
	out.cost = cost && COST_KEYS.some((k) => cost[k] !== null) ? cost : null;
	return TOKEN_KEYS.some((k) => out[k] !== null) ? out : null;
}

/** Prompt tokens sent (input + cacheRead + cacheWrite), or null unless all three are known. */
export function promptTokens(usage) {
	if (!usage || usage.input === null || usage.cacheRead === null || usage.cacheWrite === null) return null;
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

export function keyedDigest(secretHex, parts) {
	const h = crypto.createHmac("sha256", Buffer.from(secretHex, "hex"));
	for (const p of parts) h.update(String(p ?? "")).update("\0");
	return h.digest("hex");
}

export const newId = (prefix = "ev") => `${prefix}_${crypto.randomUUID()}`;

/** Display-safe text: control, bidi, zero-width, and separator characters removed; bounded. */
export function display(value, max = 160) {
	const s = String(value ?? "")
		.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "")
		.trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Only Claude Opus version separators are normalized ("claude-opus-5-5" equals "claude-opus-5.5"). */
export const normalizeModel = (model) => String(model).replace(/^(claude-opus-\d+)[-.](\d+)(?=$|-)/, "$1.$2");

/**
 * True when the model a provider reports answering with is the requested one: identical, the same with a
 * "-YYYY-MM-DD" snapshot suffix, or an Opus version-separator variant. A missing response model is not a mismatch.
 */
export function sameModel(requested, responded) {
	if (!responded) return true;
	if (!requested) return false;
	const a = normalizeModel(requested);
	const b = normalizeModel(responded);
	return a === b || (b.startsWith(`${a}-`) && /^\d{4}-\d{2}-\d{2}$/.test(b.slice(a.length + 1)));
}

/** "provider/model" → { provider, model } (model may itself contain "/"), or null. */
export function parseModelRef(ref) {
	if (typeof ref !== "string") return null;
	const i = ref.indexOf("/");
	if (i <= 0) return null;
	const provider = safeId(ref.slice(0, i));
	const model = safeId(ref.slice(i + 1));
	return provider && model && !provider.includes("/") ? { provider, model } : null;
}

/** A plain positive decimal like "25" or "2.5"; anything else (including "") is NaN. */
export const parseMinutes = (v) => (typeof v === "string" && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(v) ? Number(v) : Number.NaN);

/** Error code safe to show: our own codes, or an upper-case system code; never the error text. */
export function errorCode(err) {
	if (err instanceof CacheInsightsError) return err.code;
	return typeof err?.code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(err.code) ? err.code : "error";
}
