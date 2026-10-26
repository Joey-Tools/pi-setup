import { spawn } from "node:child_process";

export class AcpError extends Error {
	constructor(message, { code, data, method } = {}) {
		super(message);
		this.name = "AcpError";
		this.code = code;
		this.data = data;
		this.method = method;
	}
}

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const liveGroups = new Set();
let exitHookInstalled = false;

function killGroup(pid, signal) {
	try {
		if (process.platform === "win32") return false;
		process.kill(-pid, signal);
		return true;
	} catch {
		return false;
	}
}

function installExitHook() {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => {
		for (const pid of liveGroups) killGroup(pid, "SIGKILL");
	});
}

/**
 * One line-delimited JSON-RPC 2.0 connection to an ACP agent child process.
 * The child runs in its own process group so a stubborn agent and its tool subprocesses can be killed together.
 */
export class AcpConnection {
	constructor({
		command,
		args = [],
		cwd,
		env = process.env,
		maxFrameBytes = 8 * 1024 * 1024,
		maxMalformedFrames = 50,
		stderrLimit = 16 * 1024,
		killGraceMs = 2000,
		onNotification = () => {},
		onRequest = async () => {
			throw new AcpError("Method not found", { code: METHOD_NOT_FOUND });
		},
		onEvent = () => {},
		onClose = () => {},
	}) {
		Object.assign(this, { command, args, cwd, env, maxFrameBytes, maxMalformedFrames, stderrLimit, killGraceMs });
		this.handlers = { onNotification, onRequest, onEvent, onClose };
		this.nextId = 1;
		this.pending = new Map();
		this.buffer = "";
		this.stderr = "";
		this.malformed = 0;
		this.closed = false;
		this.closeError = undefined;
		this.child = undefined;
		this.exited = new Promise((resolve) => (this.resolveExited = resolve));
	}

	start() {
		if (this.child) throw new Error("connection already started");
		const child = spawn(this.command, this.args, {
			cwd: this.cwd,
			env: this.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			shell: false,
			windowsHide: true,
		});
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => this.#onData(chunk));
		child.stderr.on("data", (chunk) => {
			this.stderr = (this.stderr + chunk).slice(-this.stderrLimit);
		});
		child.stdin.on("error", (err) => this.#fail(new AcpError(`agent stdin error: ${err.message}`)));
		child.on("error", (err) => {
			this.#fail(new AcpError(`failed to start ${this.command}: ${err.message}`));
			if (!child.pid) this.resolveExited({ code: null, signal: null });
		});
		child.on("exit", (code, signal) => {
			if (child.pid) liveGroups.delete(child.pid);
			this.exitInfo = { code, signal };
			this.#fail(new AcpError(`agent process exited (code=${code}, signal=${signal})${this.#stderrSuffix()}`));
			this.resolveExited(this.exitInfo);
		});
		if (child.pid) {
			liveGroups.add(child.pid);
			installExitHook();
		}
		return this;
	}

	get pid() {
		return this.child?.pid;
	}

	stderrTail() {
		return this.stderr;
	}

	#stderrSuffix() {
		const tail = this.stderr.trim();
		return tail ? `\nagent stderr (tail):\n${tail.slice(-2000)}` : "";
	}

	#write(msg) {
		if (this.closed) throw this.closeError ?? new AcpError("connection closed");
		this.handlers.onEvent({ dir: "send", msg });
		this.child.stdin.write(`${JSON.stringify(msg)}\n`);
	}

	request(method, params, { timeoutMs = 60000, signal } = {}) {
		if (this.closed) return Promise.reject(this.closeError ?? new AcpError("connection closed", { method }));
		if (signal?.aborted) return Promise.reject(new AcpError(`ACP request ${method} aborted`, { method, code: "ABORTED" }));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const entry = { method, resolve, reject, timer: undefined, cleanup: () => {} };
			const settle = (fn, value) => {
				if (!this.pending.has(id)) return;
				this.pending.delete(id);
				clearTimeout(entry.timer);
				entry.cleanup();
				fn(value);
			};
			entry.resolve = (v) => settle(resolve, v);
			entry.reject = (e) => settle(reject, e);
			if (timeoutMs > 0) {
				entry.timer = setTimeout(
					() => entry.reject(new AcpError(`ACP request ${method} timed out after ${timeoutMs}ms`, { method, code: "TIMEOUT" })),
					timeoutMs,
				);
			}
			if (signal) {
				const onAbort = () => entry.reject(new AcpError(`ACP request ${method} aborted`, { method, code: "ABORTED" }));
				signal.addEventListener("abort", onAbort, { once: true });
				entry.cleanup = () => signal.removeEventListener("abort", onAbort);
			}
			this.pending.set(id, entry);
			try {
				this.#write({ jsonrpc: "2.0", id, method, params });
			} catch (err) {
				entry.reject(err);
			}
		});
	}

	notify(method, params) {
		if (this.closed) return false;
		try {
			this.#write({ jsonrpc: "2.0", method, params });
			return true;
		} catch {
			return false;
		}
	}

	#onData(chunk) {
		if (this.closed) return;
		this.buffer += chunk;
		let idx;
		while ((idx = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			if (line.length > this.maxFrameBytes) return this.#protocolFailure(`frame of ${line.length} bytes exceeds limit ${this.maxFrameBytes}`);
			if (line.trim()) this.#onLine(line);
			if (this.closed) return;
		}
		if (this.buffer.length > this.maxFrameBytes) this.#protocolFailure(`unterminated frame exceeds limit ${this.maxFrameBytes}`);
	}

	#protocolFailure(reason) {
		this.buffer = "";
		this.handlers.onEvent({ dir: "error", error: reason });
		this.#fail(new AcpError(`ACP protocol failure: ${reason}`, { code: "PROTOCOL" }));
		void this.terminate();
	}

	#onLine(line) {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			msg = undefined;
		}
		if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
			this.malformed++;
			this.handlers.onEvent({ dir: "recv-malformed", line: line.slice(0, 2000) });
			if (this.malformed > this.maxMalformedFrames) this.#protocolFailure(`more than ${this.maxMalformedFrames} malformed frames`);
			return;
		}
		this.handlers.onEvent({ dir: "recv", msg });
		const hasId = msg.id !== undefined && msg.id !== null;
		if (hasId && typeof msg.method !== "string") {
			const entry = this.pending.get(msg.id);
			if (!entry) return;
			if (msg.error) {
				const e = msg.error;
				entry.reject(new AcpError(`ACP ${entry.method} failed: ${e.message ?? "error"} (code ${e.code})${e.data ? ` ${JSON.stringify(e.data).slice(0, 1000)}` : ""}`, { code: e.code, data: e.data, method: entry.method }));
			} else {
				entry.resolve(msg.result);
			}
			return;
		}
		if (typeof msg.method !== "string") return;
		if (!hasId) {
			try {
				this.handlers.onNotification(msg.method, msg.params);
			} catch (err) {
				this.handlers.onEvent({ dir: "error", error: `notification handler: ${err?.message ?? err}` });
			}
			return;
		}
		this.#handleRequest(msg);
	}

	async #handleRequest(msg) {
		let response;
		try {
			const result = await this.handlers.onRequest(msg.method, msg.params);
			response = { jsonrpc: "2.0", id: msg.id, result: result ?? null };
		} catch (err) {
			const code = Number.isInteger(err?.code) ? err.code : INTERNAL_ERROR;
			response = { jsonrpc: "2.0", id: msg.id, error: { code, message: err?.message ?? String(err) } };
		}
		try {
			this.#write(response);
		} catch {
			// connection already closed
		}
	}

	#fail(error) {
		if (this.closed) return;
		this.closed = true;
		this.closeError = error;
		for (const entry of [...this.pending.values()]) entry.reject(error);
		this.pending.clear();
		this.buffer = "";
		try {
			this.handlers.onClose(error);
		} catch {
			// ignore
		}
	}

	/** Stop the agent: close stdin, SIGTERM the process group, then SIGKILL after a grace period. Idempotent. */
	async terminate(reason = "terminated by client") {
		if (!this.child) return;
		this.#fail(new AcpError(`ACP connection ${reason}`));
		if (this.terminating) return this.terminating;
		const child = this.child;
		this.terminating = (async () => {
			try {
				child.stdin.end();
			} catch {
				// ignore
			}
			if (this.exitInfo) {
				killGroup(child.pid, "SIGKILL");
				return;
			}
			if (!killGroup(child.pid, "SIGTERM")) child.kill("SIGTERM");
			let timer;
			const exitedInTime = await Promise.race([
				this.exited.then(() => true),
				new Promise((r) => (timer = setTimeout(() => r(false), this.killGraceMs))),
			]);
			clearTimeout(timer);
			// Kill leftover tool subprocesses in the group even if the leader exited.
			if (!killGroup(child.pid, "SIGKILL") && !exitedInTime) child.kill("SIGKILL");
			if (!exitedInTime) {
				await Promise.race([this.exited, new Promise((r) => (timer = setTimeout(r, this.killGraceMs)))]);
				clearTimeout(timer);
			}
		})();
		return this.terminating;
	}
}
