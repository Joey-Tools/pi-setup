// The feature's own local SQLite database (built-in node:sqlite, imported lazily). Uncompressed rows with fixed,
// allowlisted columns; one schema version per database in PRAGMA user_version. Nothing is ever deleted here.
import crypto from "node:crypto";
import zlib from "node:zlib";
import { checkEntry, createFiles, resolveCachePaths } from "./paths.mjs";
import { CacheInsightsError, ID_RE, keyedDigest, MINUTE_MS, newId, num, safeId, sameModelId, STOP_REASONS } from "./util.mjs";

export const SCHEMA_VERSION = 2;
export const ORIGINS = Object.freeze(["live", "historical"]);
// How a sample is deduplicated: by provider/model and request start (warms: completion time), by a keyed opaque
// session-entry id, by a keyed import position (ambiguous across copies), or not at all.
export const IDENTITIES = Object.freeze(["time", "entry_id", "position", "none"]);
export const END_PROVENANCE = Object.freeze(["message_end_received", "entry_timestamp_proxy", "unknown"]);
export const PAIR_EXCLUSIONS = Object.freeze([
	"boundary",
	"warm_between",
	"ancestry_break",
	"legacy_ambiguous",
	"model_changed",
	"model_mismatch",
	"prev_not_success",
	"cur_not_success",
	"prev_usage_missing",
	"usage_missing",
	"timing_missing",
	"clock_anomaly",
]);
export const EVENT_KINDS = Object.freeze(["recording_on", "recording_off", "profile_set", "settings_changed", "import_run", "migrated"]);
export const TIME_SETTINGS = Object.freeze(["local", "utc"]);
export const COST_SETTINGS = Object.freeze(["off", "usd", "credits", "both"]);
export const MAX_PROFILE_MINUTES = 24 * 60;
const BUSY_TIMEOUT_MS = 2000;

const V2_SQL = `
	CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
	CREATE TABLE profiles (
		provider TEXT NOT NULL, model TEXT NOT NULL, hit_under_ms INTEGER NOT NULL, expire_over_ms INTEGER NOT NULL,
		source TEXT NOT NULL, set_at INTEGER NOT NULL, PRIMARY KEY (provider, model)
	) STRICT;
	CREATE TABLE samples (
		seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, dedup_key TEXT UNIQUE, identity TEXT NOT NULL, origin TEXT NOT NULL, kind TEXT NOT NULL,
		provider TEXT, model TEXT, api TEXT, response_model TEXT, thinking TEXT, stop_reason TEXT,
		request_start_ms REAL, end_ms REAL, end_provenance TEXT NOT NULL,
		input REAL, output REAL, cache_read REAL, cache_write REAL, cache_write_1h REAL, total_tokens REAL,
		cost_input REAL, cost_output REAL, cost_cache_read REAL, cost_cache_write REAL, cost_total REAL,
		recorded_at REAL NOT NULL
	) STRICT;
	CREATE INDEX samples_model ON samples(provider, model, request_start_ms);
	CREATE TABLE pairs (
		seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, dedup_key TEXT UNIQUE, origin TEXT NOT NULL,
		provider TEXT, model TEXT, gap_start_ms REAL, gap_end_ms REAL, end_provenance TEXT NOT NULL,
		prev_cache_read REAL, prev_cache_write REAL, prev_prompt REAL, cache_read REAL, cache_write REAL, input REAL,
		qualified INTEGER NOT NULL, tier TEXT, exclusion TEXT, recorded_at REAL NOT NULL
	) STRICT;
	CREATE INDEX pairs_model ON pairs(provider, model);
	CREATE TABLE events (
		seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, observed_at REAL NOT NULL, kind TEXT NOT NULL,
		reason TEXT, provider TEXT, model TEXT, count REAL
	) STRICT;
`;

function createFresh(db) {
	db.exec(V2_SQL);
	const put = db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)");
	put.run("recording", "off");
	put.run("dedup_secret", crypto.randomBytes(32).toString("hex"));
	put.run("time", "local");
	put.run("cost", "usd");
}

/**
 * Draft format (gzip JSON payload per row) → the old table kept intact as legacy_events (every column, the
 * original payload bytes, and its indexes), plus payload_text: the decompressed bytes decoded as strict UTF-8,
 * never re-serialized. Rows that do not decode keep payload_text NULL and their original bytes.
 */
function migrateV1(db) {
	const cols = db.prepare("PRAGMA table_info(events)").all().map((c) => c.name);
	if (!cols.includes("payload") || !cols.includes("kind")) throw new CacheInsightsError("foreign_db", "the cache-insights database has an unrecognized format");
	db.exec("ALTER TABLE events RENAME TO legacy_events");
	db.exec("ALTER TABLE legacy_events ADD COLUMN payload_text TEXT");
	const update = db.prepare("UPDATE legacy_events SET payload_text = ? WHERE rowid = ?");
	const utf8 = new TextDecoder("utf-8", { fatal: true });
	for (const row of db.prepare("SELECT rowid AS r, payload FROM legacy_events").all()) {
		try {
			update.run(utf8.decode(zlib.gunzipSync(row.payload, { maxOutputLength: 1 << 20 })), row.r);
		} catch {}
	}
	createFresh(db);
	db.prepare("INSERT INTO events (id, observed_at, kind, reason) VALUES (?, ?, 'migrated', 'from_v1')").run(newId(), Date.now());
}

const newer = (v) => new CacheInsightsError("newer_schema", `cache-insights database schema ${v} is newer than supported ${SCHEMA_VERSION}`);
const MIGRATION_REQUIRED = () =>
	new CacheInsightsError("migration_required", "the cache-insights database needs a one-time upgrade: run `node scripts/cache-insights.mjs migrate`, or /cache migrate in the TUI");

/** Checks the stored version without writing anything. */
function checkVersion(db, allowUpgrade) {
	const v = db.prepare("PRAGMA user_version").get().user_version;
	if (v > SCHEMA_VERSION) throw newer(v);
	if (v < SCHEMA_VERSION && !allowUpgrade) throw MIGRATION_REQUIRED();
}

function migrate(db) {
	const version = () => db.prepare("PRAGMA user_version").get().user_version;
	if (version() > SCHEMA_VERSION) throw newer(version());
	if (version() === SCHEMA_VERSION) return;
	db.exec("BEGIN IMMEDIATE");
	try {
		const current = version();
		if (current > SCHEMA_VERSION) throw newer(current);
		if (current === 0) {
			if (db.prepare("SELECT count(*) AS n FROM sqlite_master").get().n > 0) throw new CacheInsightsError("foreign_db", "the cache-insights database file contains unrelated tables");
			createFresh(db);
		} else if (current === 1) migrateV1(db);
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

const defaultLoadSqlite = () => import("node:sqlite");

/**
 * Opens the database, or with `create` creates it. Returns null when missing and `create` is false.
 * Only `upgrade` (default: `create`) may migrate an older schema; otherwise an older file fails with
 * "migration_required" before anything is written.
 */
export async function openCacheDb({ root, workspaceCwd, agentDir, create = false, upgrade = create, loadSqlite = defaultLoadSqlite, busyTimeoutMs = BUSY_TIMEOUT_MS } = {}) {
	const paths = resolveCachePaths({ root, workspaceCwd, agentDir });
	if (!create && !checkEntry(paths.dbPath, "file")) return null;
	let DatabaseSync;
	try {
		({ DatabaseSync } = await loadSqlite());
		if (typeof DatabaseSync !== "function") throw new Error("missing");
	} catch {
		throw new CacheInsightsError("unsupported", "this Node.js runtime has no built-in SQLite (node:sqlite); cache insights are disabled");
	}
	if (create) createFiles(paths);
	else checkEntry(paths.dbPath, "file");
	const db = new DatabaseSync(paths.dbPath);
	try {
		db.exec(`PRAGMA busy_timeout = ${Math.max(0, Number(busyTimeoutMs) | 0)}`);
		checkVersion(db, upgrade);
		db.exec("PRAGMA journal_mode = DELETE");
		migrate(db);
	} catch (err) {
		db.close();
		throw err;
	}
	return new CacheDb(db, paths);
}

/** Rejects unknown keys so a caller mistake cannot widen what is stored. */
function strict(obj, keys, what) {
	const extra = Object.keys(obj ?? {}).filter((k) => !keys.includes(k));
	if (extra.length) throw new CacheInsightsError("invalid_record", `${what} has unexpected fields: ${extra.filter((k) => /^[A-Za-z0-9_]{1,40}$/.test(k)).join(",") || "?"}`);
}
const oneOf = (v, list, what) => {
	if (!list.includes(v)) throw new CacheInsightsError("invalid_record", `${what} is not an allowed value`);
	return v;
};
const signedNum = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

const SAMPLE_KEYS = ["key", "identity", "origin", "kind", "provider", "model", "api", "responseModel", "thinking", "stopReason", "requestStartMs", "endMs", "endProvenance", "usage"];
const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "totalTokens", "cost"];
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite", "total"];
const PAIR_KEYS = ["key", "origin", "provider", "model", "gapStartMs", "gapEndMs", "endProvenance", "prevCacheRead", "prevCacheWrite", "prevPrompt", "cacheRead", "cacheWrite", "input", "qualified", "tier", "exclusion"];

export class CacheDb {
	#db;
	#secret;
	constructor(db, paths) {
		this.#db = db;
		this.paths = paths;
		this.schemaVersion = SCHEMA_VERSION;
	}

	get open() {
		return this.#db !== null;
	}

	transaction(fn) {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const out = fn();
			this.#db.exec("COMMIT");
			return out;
		} catch (err) {
			this.#db.exec("ROLLBACK");
			throw err;
		}
	}

	#meta(key) {
		return this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
	}
	#setMeta(key, value) {
		this.#db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
	}
	#event(kind, { reason = null, provider = null, model = null, count = null } = {}) {
		oneOf(kind, EVENT_KINDS, "event kind");
		if (reason !== null && !ID_RE.test(reason)) throw new CacheInsightsError("invalid_record", "event reason is not allowed");
		this.#db.prepare("INSERT INTO events (id, observed_at, kind, reason, provider, model, count) VALUES (?, ?, ?, ?, ?, ?, ?)").run(newId(), Date.now(), kind, reason, safeId(provider), safeId(model), num(count));
	}

	/** Keyed digest of opaque metadata; the parts themselves are never stored. */
	digest(parts) {
		this.#secret ??= this.#meta("dedup_secret");
		return keyedDigest(this.#secret, parts);
	}
	sampleKey(provider, model, requestStartMs) {
		return provider && model && num(requestStartMs) !== null ? this.digest(["sample", provider, model, requestStartMs]) : null;
	}

	isRecording() {
		return this.#meta("recording") === "on";
	}
	setRecording(on) {
		this.transaction(() => {
			this.#setMeta("recording", on ? "on" : "off");
			this.#event(on ? "recording_on" : "recording_off");
		});
	}

	settings() {
		const time = this.#meta("time");
		const cost = this.#meta("cost");
		return { time: TIME_SETTINGS.includes(time) ? time : "local", cost: COST_SETTINGS.includes(cost) ? cost : "usd" };
	}
	setSettings({ time, cost } = {}) {
		if (time !== undefined) oneOf(time, TIME_SETTINGS, "time setting");
		if (cost !== undefined) oneOf(cost, COST_SETTINGS, "cost setting");
		this.transaction(() => {
			if (time !== undefined) this.#setMeta("time", time);
			if (cost !== undefined) this.#setMeta("cost", cost);
			this.#event("settings_changed");
		});
		return this.settings();
	}

	/** Sets the user-approved active profile for one provider/model; a known alias updates the existing row. */
	setProfile({ provider, model, hitMinutes, expireMinutes, source = "seed" }) {
		if (!safeId(provider) || !safeId(model) || provider.includes("/")) throw new CacheInsightsError("invalid_profile", "provider and model must be plain identifiers");
		const ok = (m) => typeof m === "number" && Number.isFinite(m) && m > 0 && m <= MAX_PROFILE_MINUTES;
		if (!ok(hitMinutes) || !ok(expireMinutes) || hitMinutes > expireMinutes) {
			throw new CacheInsightsError("invalid_profile", `minutes must satisfy 0 < hit <= expire <= ${MAX_PROFILE_MINUTES}`);
		}
		oneOf(source, ["seed"], "profile source");
		model = this.getProfile(provider, model)?.model ?? model;
		this.transaction(() => {
			this.#db
				.prepare(
					"INSERT INTO profiles (provider, model, hit_under_ms, expire_over_ms, source, set_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider, model) DO UPDATE SET hit_under_ms = excluded.hit_under_ms, expire_over_ms = excluded.expire_over_ms, source = excluded.source, set_at = excluded.set_at",
				)
				.run(provider, model, Math.round(hitMinutes * MINUTE_MS), Math.round(expireMinutes * MINUTE_MS), source, Date.now());
			this.#event("profile_set", { provider, model });
		});
		return this.getProfile(provider, model);
	}
	/** The active profile for `provider` and `model`, matched exactly or through the known Opus alias. */
	getProfile(provider, model) {
		const row =
			this.#db.prepare("SELECT * FROM profiles WHERE provider = ? AND model = ?").get(provider ?? "", model ?? "") ??
			this.#db
				.prepare("SELECT * FROM profiles WHERE provider = ? ORDER BY model")
				.all(provider ?? "")
				.find((r) => sameModelId(r.model, model));
		return row ? { provider: row.provider, model: row.model, hitUnderMs: row.hit_under_ms, expireOverMs: row.expire_over_ms, source: row.source, setAt: row.set_at } : null;
	}
	listProfiles() {
		return this.#db
			.prepare("SELECT provider, model FROM profiles ORDER BY provider, model")
			.all()
			.map((r) => this.getProfile(r.provider, r.model));
	}

	/** Inserts one response or warm sample; returns false for a duplicate dedup key. */
	insertSample(s) {
		strict(s, SAMPLE_KEYS, "sample");
		const u = s.usage ?? null;
		if (u) {
			strict(u, USAGE_KEYS, "usage");
			if (u.cost) strict(u.cost, COST_KEYS, "cost");
		}
		const c = u?.cost ?? null;
		const r = this.#db
			.prepare(
				`INSERT OR IGNORE INTO samples (id, dedup_key, identity, origin, kind, provider, model, api, response_model, thinking, stop_reason, request_start_ms, end_ms, end_provenance,
				input, output, cache_read, cache_write, cache_write_1h, total_tokens, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, recorded_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				newId(),
				typeof s.key === "string" && /^[0-9a-f]{64}$/.test(s.key) ? s.key : null,
				oneOf(s.identity, IDENTITIES, "sample identity"),
				oneOf(s.origin, ORIGINS, "origin"),
				oneOf(s.kind, ["response", "warm"], "sample kind"),
				safeId(s.provider),
				safeId(s.model),
				safeId(s.api),
				safeId(s.responseModel),
				safeId(s.thinking),
				s.stopReason === null ? null : oneOf(s.stopReason, STOP_REASONS, "stop reason"),
				num(s.requestStartMs),
				num(s.endMs),
				oneOf(s.endProvenance, END_PROVENANCE, "end provenance"),
				num(u?.input),
				num(u?.output),
				num(u?.cacheRead),
				num(u?.cacheWrite),
				num(u?.cacheWrite1h),
				num(u?.totalTokens),
				num(c?.input),
				num(c?.output),
				num(c?.cacheRead),
				num(c?.cacheWrite),
				num(c?.total),
				Date.now(),
			);
		return r.changes === 1;
	}

	/**
	 * Inserts a pair, or merges it with an existing observation of the same two responses (live and historical).
	 * Merging is order-independent: an exclusion from either source wins, and the origin becomes "both".
	 * Returns true when the pair was new.
	 */
	insertPair(p) {
		strict(p, PAIR_KEYS, "pair");
		if (p.exclusion !== null) oneOf(p.exclusion, PAIR_EXCLUSIONS, "pair exclusion");
		if (p.tier !== null) oneOf(p.tier, ["strong", "weak"], "pair tier");
		if ((p.qualified === true) !== (p.exclusion === null)) throw new CacheInsightsError("invalid_record", "pair qualification and exclusion disagree");
		const key = typeof p.key === "string" && /^[0-9a-f]{64}$/.test(p.key) ? p.key : null;
		const existed = key !== null && this.#db.prepare("SELECT 1 AS x FROM pairs WHERE dedup_key = ?").get(key) !== undefined;
		this.#db
			.prepare(
				`INSERT INTO pairs (id, dedup_key, origin, provider, model, gap_start_ms, gap_end_ms, end_provenance, prev_cache_read, prev_cache_write, prev_prompt,
				cache_read, cache_write, input, qualified, tier, exclusion, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(dedup_key) DO UPDATE SET
					origin = CASE WHEN pairs.origin = excluded.origin THEN pairs.origin ELSE 'both' END,
					exclusion = coalesce(pairs.exclusion, excluded.exclusion),
					tier = CASE WHEN pairs.qualified = 1 AND excluded.qualified = 1 THEN pairs.tier ELSE NULL END,
					qualified = min(pairs.qualified, excluded.qualified)`,
			)
			.run(
				newId(),
				key,
				oneOf(p.origin, ORIGINS, "origin"),
				safeId(p.provider),
				safeId(p.model),
				signedNum(p.gapStartMs),
				signedNum(p.gapEndMs),
				oneOf(p.endProvenance, END_PROVENANCE, "end provenance"),
				num(p.prevCacheRead),
				num(p.prevCacheWrite),
				num(p.prevPrompt),
				num(p.cacheRead),
				num(p.cacheWrite),
				num(p.input),
				p.qualified === true ? 1 : 0,
				p.tier,
				p.exclusion,
				Date.now(),
			);
		return !existed;
	}

	recordImport(added, { provider = null, model = null } = {}) {
		this.transaction(() => this.#event("import_run", { provider, model, count: added }));
	}

	pairs({ provider, model } = {}) {
		const rows = provider && model ? this.#db.prepare("SELECT * FROM pairs WHERE provider = ? AND model = ? ORDER BY seq").all(provider, model) : this.#db.prepare("SELECT * FROM pairs ORDER BY seq").all();
		return rows.map((r) => ({
			origin: r.origin,
			provider: r.provider,
			model: r.model,
			gapStartMs: r.gap_start_ms,
			gapEndMs: r.gap_end_ms,
			endProvenance: r.end_provenance,
			prevCacheRead: r.prev_cache_read,
			prevCacheWrite: r.prev_cache_write,
			cacheRead: r.cache_read,
			cacheWrite: r.cache_write,
			qualified: r.qualified === 1,
			tier: r.tier,
			exclusion: r.exclusion,
		}));
	}

	/** Newest `limit` samples, oldest first. */
	history(limit = 20) {
		const n = Math.max(1, Math.min(500, Number(limit) | 0));
		return this.#db.prepare("SELECT * FROM (SELECT * FROM samples ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC").all(n);
	}

	counts() {
		const c = (sql) => this.#db.prepare(sql).get().n;
		const legacy = c("SELECT count(*) AS n FROM sqlite_master WHERE name = 'legacy_events'") ? c("SELECT count(*) AS n FROM legacy_events") : 0;
		return {
			samples: c("SELECT count(*) AS n FROM samples"),
			historical: c("SELECT count(*) AS n FROM samples WHERE origin = 'historical'"),
			live: c("SELECT count(*) AS n FROM samples WHERE origin = 'live'"),
			pairs: c("SELECT count(*) AS n FROM pairs"),
			legacy,
		};
	}

	close() {
		if (!this.#db) return;
		try {
			this.#db.close();
		} finally {
			this.#db = null;
		}
	}
}
