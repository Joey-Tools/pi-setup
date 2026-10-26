import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const SAFE_KEY = /^[A-Za-z0-9_-]{1,80}$/;

function sha(text) {
	return createHash("sha256").update(text).digest("hex");
}

export function projectKey(cwd) {
	const base = path.basename(cwd).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32) || "root";
	return `${base}-${sha(path.resolve(cwd)).slice(0, 16)}`;
}

export function sessionKey(piSessionId) {
	const id = String(piSessionId ?? "");
	return SAFE_KEY.test(id) ? id : `h-${sha(id).slice(0, 32)}`;
}

export async function ensurePrivateDir(dir) {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
}

export async function writeJsonAtomic(file, value) {
	await ensurePrivateDir(path.dirname(file));
	const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	let handle;
	try {
		handle = await fs.open(tmp, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.rename(tmp, file);
	} catch (err) {
		await handle?.close().catch(() => {});
		await fs.rm(tmp, { force: true }).catch(() => {});
		throw err;
	}
}

/**
 * Durable worker records for one project + Pi session: <stateDir>/<project>/<piSession>/workers/<name>.json.
 * One file per worker so concurrent runs of distinct workers never rewrite each other's state.
 */
export class WorkerRegistry {
	constructor({ stateDir, projectCwd, piSessionId }) {
		this.scopeDir = path.join(stateDir, projectKey(projectCwd), sessionKey(piSessionId));
		this.workersDir = path.join(this.scopeDir, "workers");
		this.runsDir = path.join(this.scopeDir, "runs");
	}

	recordPath(name) {
		return path.join(this.workersDir, `${name}.json`);
	}

	async read(name) {
		let text;
		try {
			text = await fs.readFile(this.recordPath(name), "utf8");
		} catch (err) {
			if (err.code === "ENOENT") return undefined;
			throw err;
		}
		try {
			return JSON.parse(text);
		} catch (err) {
			throw new Error(`Worker record ${this.recordPath(name)} is corrupt (${err.message}); refusing to start a fresh session over it.`);
		}
	}

	async write(name, record) {
		await writeJsonAtomic(this.recordPath(name), record);
	}

	async remove(name) {
		await fs.rm(this.recordPath(name), { force: true });
	}

	async list() {
		let names;
		try {
			names = await fs.readdir(this.workersDir);
		} catch (err) {
			if (err.code === "ENOENT") return [];
			throw err;
		}
		const out = [];
		for (const file of names.filter((n) => n.endsWith(".json")).sort()) {
			const name = file.slice(0, -5);
			try {
				const record = await this.read(name);
				if (record) out.push(record);
			} catch (err) {
				out.push({ name, error: err.message });
			}
		}
		return out;
	}

	async createRun(name, options) {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const dir = path.join(this.runsDir, `${stamp}-${name}-${randomBytes(3).toString("hex")}`);
		await ensurePrivateDir(dir);
		return new RunArtifacts(dir, options);
	}
}

/**
 * Full ACP event log and full assistant result for one run, streamed to disk. If the disk falls behind by more than
 * maxPendingBytes (or a write fails), further artifact output is dropped and writeError records why.
 */
export class RunArtifacts {
	constructor(dir, { maxPendingBytes = 16 * 1024 * 1024 } = {}) {
		this.dir = dir;
		this.eventsPath = path.join(dir, "events.jsonl");
		this.resultPath = path.join(dir, "result.md");
		this.maxPendingBytes = maxPendingBytes;
		this.writeError = undefined;
		this.events = this.#open(this.eventsPath);
		this.result = this.#open(this.resultPath);
		this.closed = false;
	}

	#open(file) {
		const stream = createWriteStream(file, { flags: "a", mode: 0o600 });
		stream.on("error", (err) => (this.writeError ??= err));
		return stream;
	}

	#write(stream, text) {
		if (this.closed || this.writeError) return;
		if (stream.writableLength + text.length > this.maxPendingBytes) {
			this.writeError = new Error(`artifact write backlog exceeded ${this.maxPendingBytes} bytes; later output was not saved`);
			return;
		}
		stream.write(text);
	}

	logEvent(event) {
		let line;
		try {
			line = JSON.stringify({ ts: new Date().toISOString(), ...event });
		} catch {
			line = JSON.stringify({ ts: new Date().toISOString(), dir: event?.dir, unserializable: true });
		}
		this.#write(this.events, `${line}\n`);
	}

	appendResult(text) {
		this.#write(this.result, text);
	}

	/** Flush and close both files; resolves after pending writes settle so writeError reflects disk failures. */
	async close() {
		if (!this.closed) {
			this.closed = true;
			this.closing = Promise.all(
				[this.events, this.result].map(
					(s) =>
						new Promise((resolve) => {
							if (s.destroyed) return resolve();
							s.once("close", resolve);
							s.end();
						}),
				),
			);
		}
		await this.closing;
	}
}
