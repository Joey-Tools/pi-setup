// Metadata-only import of Pi session JSONL files, read directly (never through SessionManager, which migrates
// files). Streams bounded lines, skips symlinks, and stores only allowlisted sample/pair metadata. Summaries
// contain counts and fixed reason codes only: no paths, file names, ids, or text from the files.
import fs from "node:fs";
import path from "node:path";
import { classifyEntry, decidePair, sampleFields } from "./entries.mjs";
import { CacheInsightsError, parseModelRef, sameModelId } from "./util.mjs";

const CHUNK = 500;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 4;


export function targetMatcher(targets) {
	if (!Array.isArray(targets) || targets.length === 0) throw new CacheInsightsError("no_targets", "choose provider/model targets to import (or seed a profile first)");
	const refs = targets.map((t) => {
		const ref = parseModelRef(t);
		if (!ref) throw new CacheInsightsError("invalid_target", "import targets must look like provider/model");
		return ref;
	});
	return (provider, model) => Boolean(provider) && refs.some((r) => r.provider === provider && sameModelId(r.model, model));
}

function listFiles(root, summary) {
	const files = [];
	const walk = (dir, depth) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			summary.files.unreadable++;
			return;
		}
		for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			const p = path.join(dir, e.name);
			if (e.isSymbolicLink()) summary.files.symlink++;
			else if (e.isDirectory()) depth < MAX_DEPTH ? walk(p, depth + 1) : summary.files.too_deep++;
			else if (e.isFile() && e.name.endsWith(".jsonl")) files.push(p);
		}
	};
	walk(root, 0);
	return files;
}

async function* readLines(file, maxBytes) {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	const stream = fs.createReadStream(null, { fd, highWaterMark: 1 << 16 });
	let parts = [];
	let size = 0;
	let skipping = false;
	const flush = () => {
		const out = skipping ? { oversized: true } : { line: Buffer.concat(parts).toString("utf8") };
		parts = [];
		size = 0;
		skipping = false;
		return out;
	};
	for await (const chunk of stream) {
		let start = 0;
		for (;;) {
			const nl = chunk.indexOf(10, start);
			const end = nl === -1 ? chunk.length : nl;
			if (!skipping) {
				size += end - start;
				if (size > maxBytes) {
					skipping = true;
					parts = [];
				} else parts.push(chunk.subarray(start, end));
			}
			if (nl === -1) break;
			yield flush();
			start = nl + 1;
		}
	}
	if (skipping || size > 0) yield flush();
}

const emptySummary = () => ({
	files: { scanned: 0, symlink: 0, unreadable: 0, too_deep: 0 },
	lines: 0,
	parseErrors: { invalid_json: 0, oversized_line: 0, not_object: 0 },
	responses: { matched: 0, added: 0, duplicate: 0, missing_start: 0 },
	warms: { matched: 0, added: 0, duplicate: 0 },
	pairs: { added: 0, duplicate: 0, qualified: 0, excluded: {} },
});

/**
 * Imports metadata for the given "provider/model" targets from every *.jsonl file under `sessionsDir`.
 * Re-imports, copied sessions, and hard-link aliases are idempotent through keyed dedup. Filesystem problems are
 * counted per file; database problems stop the import with a "storage" error.
 */
export async function importHistory(db, { sessionsDir, targets, maxLineBytes = MAX_LINE_BYTES } = {}) {
	const matches = targetMatcher(targets);
	let st;
	try {
		st = fs.lstatSync(sessionsDir);
	} catch {
		throw new CacheInsightsError("no_sessions", "the Pi sessions directory does not exist or cannot be read");
	}
	if (st.isSymbolicLink() || !st.isDirectory()) throw new CacheInsightsError("unsafe_path", "the Pi sessions directory must be a real directory, not a symlink");
	const summary = emptySummary();
	storage(() => db.digest(["warm-up"]));
	for (const file of listFiles(sessionsDir, summary)) {
		let pending;
		try {
			pending = await readFile(db, file, path.relative(sessionsDir, file), matches, maxLineBytes, summary);
		} catch {
			summary.files.unreadable++;
			continue;
		}
		summary.files.scanned++;
		store(db, pending, summary);
	}
	storage(() => db.recordImport(summary.responses.added + summary.warms.added));
	return summary;
}

function storage(fn) {
	try {
		return fn();
	} catch (err) {
		if (err instanceof CacheInsightsError) throw err;
		throw new CacheInsightsError("storage", "the cache-insights database could not be written (it may be busy); rows already written are kept");
	}
}

function store(db, pending, summary) {
	for (let i = 0; i < pending.length; i += CHUNK) {
		storage(() =>
			db.transaction(() => {
				for (const p of pending.slice(i, i + CHUNK)) {
					if (p.type === "pair") {
						const added = db.insertPair(p.pair);
						summary.pairs[added ? "added" : "duplicate"]++;
						if (!added) continue;
						if (p.pair.qualified) summary.pairs.qualified++;
						else summary.pairs.excluded[p.pair.exclusion] = (summary.pairs.excluded[p.pair.exclusion] ?? 0) + 1;
					} else {
						const bucket = p.type === "warm" ? summary.warms : summary.responses;
						bucket[db.insertSample(p.sample) ? "added" : "duplicate"]++;
					}
				}
			}),
		);
	}
}

/**
 * Keyed identity for an observation, never the raw ids: provider/model/request start when known (shared with
 * live recording), else the opaque session-entry id, else the file's position under the sessions dir (ambiguous
 * across copies, but stable across re-imports).
 */
function identity(db, meta, relFile, line) {
	if (meta.kind === "assistant" && meta.requestStartMs !== null && meta.provider && meta.model) return { identity: "time", key: db.sampleKey(meta.provider, meta.model, meta.requestStartMs) };
	if (meta.kind === "warm" && meta.entryTime !== null) return { identity: "time", key: db.digest(["warm", meta.provider, meta.model, meta.entryTime]) };
	if (meta.id) return { identity: "entry_id", key: db.digest(["entry", meta.kind, meta.id, meta.entryTime, meta.provider, meta.model]) };
	return { identity: "position", key: db.digest(["position", relFile, line]) };
}

/** Reads one file into pending sample/pair records. Throws only for filesystem problems. */
async function readFile(db, file, relFile, matches, maxLineBytes, summary) {
	const parents = new Map();
	const pending = [];
	let prev = null;
	let boundary = null;
	let line = 0;
	for await (const item of readLines(file, maxLineBytes)) {
		line++;
		summary.lines++;
		if (item.oversized) {
			summary.parseErrors.oversized_line++;
			continue;
		}
		if (!item.line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(item.line);
		} catch {
			summary.parseErrors.invalid_json++;
			continue;
		}
		const meta = classifyEntry(entry);
		if (meta.kind === "invalid") {
			summary.parseErrors.not_object++;
			continue;
		}
		if (meta.id) parents.set(meta.id, { kind: meta.kind, parentId: meta.parentId });
		if (meta.kind === "boundary") boundary ??= meta.reason;
		else if (meta.kind === "warm") {
			boundary ??= "warm";
			if (matches(meta.provider, meta.model)) {
				summary.warms.matched++;
				pending.push({ type: "warm", sample: { ...identity(db, meta, relFile, line), origin: "historical", thinking: null, ...sampleFields(meta, { endMs: meta.entryTime, endProvenance: meta.entryTime === null ? "unknown" : "entry_timestamp_proxy" }) } });
			}
		} else if (meta.kind === "assistant") {
			const cur = { ...meta, endMs: meta.entryTime, endProvenance: meta.entryTime === null ? "unknown" : "entry_timestamp_proxy", ...identity(db, meta, relFile, line) };
			if (matches(cur.provider, cur.model)) {
				summary.responses.matched++;
				if (cur.requestStartMs === null) summary.responses.missing_start++;
				pending.push({ type: "response", sample: { key: cur.key, identity: cur.identity, origin: "historical", thinking: null, ...sampleFields(cur, cur) } });
				if (prev) {
					const ancestry = !cur.id || !prev.id ? "legacy" : ancestryOk(parents, cur.parentId, prev.id) ? "ok" : "break";
					const pair = decidePair(prev, cur, { boundary, ancestry });
					pending.push({ type: "pair", pair: { key: db.digest(["pair", prev.key, cur.key]), origin: "historical", ...pair } });
				}
			}
			prev = cur;
			boundary = null;
		}
	}
	return pending;
}

/** True when `prevId` is reached from `parentId` through ordinary or ignored entries only. */
function ancestryOk(parents, parentId, prevId) {
	let id = parentId;
	for (let steps = 0; id && steps < 1_000_000; steps++) {
		if (id === prevId) return true;
		const p = parents.get(id);
		if (!p || (p.kind !== "ordinary" && p.kind !== "ignore")) return false;
		id = p.parentId;
	}
	return false;
}
