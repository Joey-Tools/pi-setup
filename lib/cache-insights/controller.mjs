// Cache-insights extension controller: hooks, the minute status timer, live recording, and the /cache command.
// Never sends model requests, changes prompts or settings, or warms the cache. Registering opens nothing; the
// database is opened at session start only if it already exists, or created by an explicit TUI command.
import { MAX_PROFILE_MINUTES, openCacheDb } from "./db.mjs";
import { classifyEntry, decidePair, latestResponseOnBranch, sampleFields, transitionsAfter } from "./entries.mjs";
import { costRange, forecast } from "./forecast.mjs";
import { historyText, importText, learnText, statusDetails, statusLine } from "./format.mjs";
import { importHistory } from "./importer.mjs";
import { learnEnvelopes } from "./learner.mjs";
import { CacheMenu } from "./menu.mjs";
import { defaultAgentDir, defaultCacheRoot, defaultSessionsDir } from "./paths.mjs";
import { CacheInsightsError, display, errorCode, MINUTE_MS, parseMinutes, parseModelRef, promptTokens, safeId, sameModel, sameModelId } from "./util.mjs";

export const STATUS_KEY = "cache-insights";
export const CACHE_USAGE = "/cache [menu|status|on|off|history [n]|learn [provider/model]|seed <provider/model> <hitMin> <expireMin>|import [provider/model...]|settings [time local|utc] [cost off|usd|credits|both]|migrate]";
const ANCHOR_STOPS = new Set(["stop", "toolUse", "length"]);
// Recently handled responses, so a repeated message_end cannot move the anchor or pair a response with itself.
const MAX_SEEN_RESPONSES = 512;
const defaultClock = { wall: () => Date.now(), mono: () => performance.now() };
const defaultTimers = { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };
// Longest single wait for an edge-aligned refresh; the minute interval covers anything later.
const MAX_EDGE_WAIT_MS = 24 * 60 * MINUTE_MS;

// In-memory only: Pi's entry id, or provider/model/time for entries without one.
const warmKey = (e) => (typeof e?.id === "string" ? e.id : `${e?.provider}\0${e?.model}\0${e?.timestamp}`);
const mismatch = (model, responseModel) => !sameModel(model, responseModel);

export function registerCacheInsights(pi, options = {}) {
	const c = new CacheInsights(pi, options);
	c.register();
	return c;
}

export class CacheInsights {
	constructor(pi, { root, env = process.env, sessionsDir, clock = defaultClock, timers = defaultTimers, loadSqlite, resolveBaseline } = {}) {
		Object.assign(this, { pi, rootOption: root, env, sessionsDirOption: sessionsDir, clock, timers, loadSqlite, resolveBaseline });
		this.db = null;
		this.failure = null;
		this.warned = false;
		this.statusShown = false;
		this.timer = null;
		this.edge = null;
		this.ctx = null;
		this.seenResponses = new Set();
		this.seenMessages = new WeakSet();
		this.menu = new CacheMenu(this);
		this.resetSession();
	}

	/** True the first time a response is seen in this runtime (in memory only; nothing about it is stored). */
	firstSighting(message, meta) {
		if (this.seenMessages.has(message)) return false;
		this.seenMessages.add(message);
		if (meta.requestStartMs === null || !meta.provider || !meta.model) return true;
		const key = `${meta.provider}\0${meta.model}\0${meta.requestStartMs}`;
		if (this.seenResponses.has(key)) return false;
		this.seenResponses.add(key);
		if (this.seenResponses.size > MAX_SEEN_RESPONSES) this.seenResponses.delete(this.seenResponses.values().next().value);
		return true;
	}

	get root() {
		return this.rootOption ?? defaultCacheRoot(this.env);
	}

	resetSession() {
		this.anchor = null;
		this.blocked = null;
		this.systemSig = null;
		this.thinking = null;
		this.seenWarms = new Set();
		this.prevLive = null;
		this.liveBoundary = null;
		this.pendingStart = null;
	}

	register() {
		const on = (name, fn) => this.pi.on(name, async (event, ctx) => this.guard(ctx, () => fn.call(this, event ?? {}, ctx)));
		on("session_start", this.onSessionStart);
		on("session_shutdown", this.onSessionShutdown);
		on("session_tree", (_e, ctx) => (this.menu.invalidate(), this.transition(ctx, "tree", { breakPairs: true })));
		on("session_compact", (_e, ctx) => this.transition(ctx, "compaction"));
		on("model_select", this.onModelSelect);
		on("thinking_level_select", this.onThinkingSelect);
		on("before_agent_start", this.onBeforeAgentStart);
		on("message_start", this.onMessageStart);
		on("message_end", this.onMessageEnd);
		on("agent_settled", (_e, ctx) => {
			this.pollWarms(ctx);
			this.refresh(ctx);
		});
		this.pi.registerCommand("cache", {
			description: `Prompt-cache forecast from a seeded local profile; metadata-only history (${CACHE_USAGE})`,
			handler: async (args, ctx) => this.guard(ctx, () => this.command(String(args ?? ""), ctx)),
		});
	}

	// Handlers never throw into Pi and never return a value, so they cannot change prompts or decisions.
	async guard(ctx, fn) {
		try {
			if (ctx) this.ctx = ctx;
			await fn();
		} catch (err) {
			this.fail(ctx, err);
		}
		return undefined;
	}

	fail(ctx, err) {
		const code = errorCode(err);
		this.failure = { code, message: err instanceof CacheInsightsError ? err.message : null };
		this.closeDb();
		const upgrade = code === "migration_required";
		this.setStatus(ctx, upgrade ? "cache: upgrade needed" : "cache: error");
		if (!this.warned) {
			this.warned = true;
			this.notify(
				ctx,
				upgrade
					? "Cache insights: the database needs a one-time upgrade. Run /cache migrate in the TUI, or `node scripts/cache-insights.mjs migrate`. Nothing was changed."
					: `Cache insights stopped after a local problem (${code}). Existing data was kept; see /cache status. The rest of Pi is unaffected.`,
				"warning",
			);
		}
	}

	notify(ctx, message, level = "info") {
		if (ctx?.hasUI && typeof ctx.ui?.notify === "function") ctx.ui.notify(message, level);
	}

	setStatus(ctx, text) {
		if (ctx?.mode !== "tui" || typeof ctx.ui?.setStatus !== "function") return;
		if (text === undefined && !this.statusShown) return;
		ctx.ui.setStatus(STATUS_KEY, text);
		this.statusShown = text !== undefined;
	}

	startTimer() {
		if (this.timer) return;
		this.timer = this.timers.setInterval(() => this.guard(this.ctx, () => this.refresh(this.ctx)), MINUTE_MS);
		this.timer?.unref?.();
	}

	stopTimer() {
		if (this.timer) this.timers.clearInterval(this.timer);
		this.timer = null;
		this.clearEdge();
	}

	clearEdge() {
		if (this.edge) this.timers.clearTimeout?.(this.edge);
		this.edge = null;
	}

	/** One extra refresh exactly when the label can next change (hit → uncertain, uncertain → expired). */
	scheduleEdge(f) {
		this.clearEdge();
		if (!this.timer || typeof this.timers.setTimeout !== "function") return;
		const now = this.clock.wall();
		const edges = [f.state === "hit" ? f.hitUntil : null, f.expiredAfter === null ? null : f.expiredAfter + 1].filter((t) => t !== null && t > now);
		if (!edges.length) return;
		const wait = Math.min(...edges) - now;
		if (wait > MAX_EDGE_WAIT_MS) return;
		this.edge = this.timers.setTimeout(() => {
			this.edge = null;
			this.guard(this.ctx, () => this.refresh(this.ctx));
		}, wait);
		this.edge?.unref?.();
	}

	closeDb() {
		this.stopTimer();
		try {
			this.db?.close();
		} catch {}
		this.db = null;
	}

	async openDb(ctx, create, upgrade = create) {
		if (this.db) return this.db;
		const agentDir = this.rootOption ? undefined : defaultAgentDir(this.env);
		this.db = await openCacheDb({ root: this.root, workspaceCwd: ctx?.cwd ?? process.cwd(), agentDir, create, upgrade, loadSqlite: this.loadSqlite });
		if (this.db) this.startTimer();
		return this.db;
	}

	branch(ctx) {
		try {
			const b = ctx?.sessionManager?.getBranch?.();
			return Array.isArray(b) ? b : [];
		} catch {
			return [];
		}
	}

	activeModel(ctx) {
		const provider = safeId(ctx?.model?.provider);
		const model = safeId(ctx?.model?.id);
		return provider && model ? { provider, model } : null;
	}

	// ----- hooks ------------------------------------------------------------------------------

	async onSessionStart(event, ctx) {
		this.menu.invalidate();
		this.closeDb();
		this.failure = null;
		this.resetSession();
		try {
			this.thinking = safeId(this.pi.getThinkingLevel?.());
		} catch {}
		for (const e of this.branch(ctx)) if (classifyEntry(e).kind === "warm") this.seenWarms.add(warmKey(e));
		if (event.reason === "new") this.blocked = "new_session";
		// A reload loses the in-memory prompt/tool baseline, so it stays uncertain until the next response.
		else this.recoverAnchor(ctx, event.reason === "fork" ? "fork" : event.reason === "reload" ? "reload" : null);
		// Startup/resume: a recovered anchor counts only if the persisted configuration matches the current one.
		if ((event.reason === "startup" || event.reason === "resume") && this.anchor && !this.blocked) this.blocked = this.baselineBlock(ctx);
		await this.openDb(ctx, false);
		this.refresh(ctx);
	}

	async onSessionShutdown(_event, ctx) {
		this.menu.invalidate();
		this.closeDb();
		this.resetSession();
		this.setStatus(ctx, undefined);
		this.ctx = null;
	}

	/** Anchor from the latest response on the current branch only, with the saved entry time as end proxy. */
	recoverAnchor(ctx, blocked) {
		const latest = latestResponseOnBranch(this.branch(ctx));
		if (!latest) return;
		const m = latest.meta;
		if (!ANCHOR_STOPS.has(m.stopReason)) {
			this.blocked = m.stopReason === "aborted" ? "aborted" : "error";
			return;
		}
		this.anchor = { provider: m.provider, model: m.model, thinking: null, startWall: m.requestStartMs, endWall: m.entryTime, endMono: null, provenance: "entry_timestamp_proxy", usage: m.usage };
		this.blocked = blocked ?? latest.after ?? (mismatch(m.model, m.responseModel) ? "model_mismatch" : null);
	}

	/** null when the injected resolver confirms an unchanged configuration; otherwise the reason to stay uncertain. */
	baselineBlock(ctx) {
		let r;
		try {
			r = this.resolveBaseline?.(ctx, this.pi);
		} catch {}
		if (r?.status === "unchanged") return null;
		if (r?.status === "changed") return r.reason === "thinking_change" ? "thinking_change" : "system_or_tools_changed";
		return "baseline_unknown";
	}

	transition(ctx, reason, { breakPairs = false } = {}) {
		this.blocked = reason;
		this.liveBoundary ??= reason;
		if (breakPairs) this.prevLive = null;
		this.refresh(ctx);
	}

	async onModelSelect(event, ctx) {
		// Without a previous model (startup restore) the anchor/active-model comparison decides.
		const prev = event.previousModel;
		if (prev && (prev.provider !== event.model?.provider || !sameModelId(prev.id, event.model?.id))) this.transition(ctx, "model_change");
		else this.refresh(ctx);
	}

	async onThinkingSelect(event, ctx) {
		const level = safeId(event.level);
		const changed = event.previousLevel !== undefined ? safeId(event.previousLevel) !== level : this.thinking !== null && this.thinking !== level;
		this.thinking = level;
		if (changed) this.transition(ctx, "thinking_change");
		else this.refresh(ctx);
	}

	async onBeforeAgentStart(event, ctx) {
		// Compared in memory only and never stored or hashed: a changed system prompt or tool set breaks continuity.
		const o = event.systemPromptOptions ?? {};
		const sig = `${String(event.systemPrompt ?? "")}\0${JSON.stringify(o.selectedTools ?? null)}\0${JSON.stringify(o.sections ?? null)}`;
		if (this.systemSig !== null && sig !== this.systemSig) this.transition(ctx, "system_or_tools_changed");
		// Until a live response replaces it, a recovered anchor is re-verified before every request.
		else if (this.anchor?.provenance === "entry_timestamp_proxy" && !this.blocked) {
			const block = this.baselineBlock(ctx);
			if (block) this.transition(ctx, block);
		}
		this.systemSig = sig;
	}

	async onMessageStart(event, ctx) {
		if (event.message?.role !== "assistant") return;
		this.pollWarms(ctx);
		// Persisted boundaries since the previous response (system/tool changes, compaction, ...) break the live pair,
		// exactly as an import of the same file would.
		const after = latestResponseOnBranch(this.branch(ctx))?.after;
		if (after) this.liveBoundary ??= after;
	}

	async onMessageEnd(event, ctx) {
		const message = event.message;
		if (message?.role !== "assistant") return;
		const endWall = this.clock.wall();
		const endMono = this.clock.mono();
		const meta = classifyEntry({ type: "message", message });
		if (!this.firstSighting(message, meta)) return;
		if (ANCHOR_STOPS.has(meta.stopReason)) {
			this.anchor = { provider: meta.provider, model: meta.model, thinking: this.thinking, startWall: meta.requestStartMs, endWall, endMono, provenance: "message_end_received", usage: meta.usage };
			this.blocked = mismatch(meta.model, meta.responseModel) ? "model_mismatch" : null;
		} else {
			this.anchor = null;
			this.blocked = meta.stopReason === "aborted" ? "aborted" : "error";
		}
		this.recordLive(meta, endWall);
		this.refresh(ctx);
	}

	recording() {
		return Boolean(this.db && !this.failure && this.db.isRecording());
	}

	recordLive(meta, endWall) {
		if (!this.recording()) {
			this.prevLive = null;
			return;
		}
		const cur = { ...meta, endMs: endWall, endProvenance: "message_end_received" };
		cur.key = this.db.sampleKey(cur.provider, cur.model, cur.requestStartMs);
		this.db.insertSample({ key: cur.key, identity: cur.key ? "time" : "none", origin: "live", thinking: this.thinking, ...sampleFields(cur, cur) });
		if (this.prevLive) {
			const pair = decidePair(this.prevLive, cur, { boundary: this.liveBoundary, ancestry: "ok" });
			this.db.insertPair({ key: this.prevLive.key && cur.key ? this.db.digest(["pair", this.prevLive.key, cur.key]) : null, origin: "live", ...pair });
		}
		this.prevLive = cur;
		this.liveBoundary = null;
	}

	/** Successful warms appear as branch entries after completion; their start is unknown, so they make the forecast uncertain. */
	pollWarms(ctx) {
		for (const e of this.branch(ctx)) {
			const meta = classifyEntry(e);
			if (meta.kind !== "warm" || this.seenWarms.has(warmKey(e))) continue;
			this.seenWarms.add(warmKey(e));
			if (this.anchor) this.blocked = "warm";
			this.liveBoundary ??= "warm";
			if (this.recording() && meta.entryTime !== null) {
				this.db.insertSample({ key: this.db.digest(["warm", meta.provider, meta.model, meta.entryTime]), identity: "time", origin: "live", thinking: null, ...sampleFields(meta, { endMs: meta.entryTime, endProvenance: "entry_timestamp_proxy" }) });
			}
		}
	}

	/** Recomputes the forecast for the next request and updates the status bar. */
	evaluate(ctx) {
		const model = this.activeModel(ctx);
		const profile = model ? this.db.getProfile(model.provider, model.model) : null;
		const anchor = this.anchor;
		let blocked = this.blocked;
		if (anchor && !blocked) blocked = transitionsAfter(this.branch(ctx), anchor.startWall) ?? null;
		if (anchor && !blocked && (!model || anchor.provider !== model.provider || !sameModelId(anchor.model, model.model))) blocked = "model_change";
		if (anchor && !blocked && anchor.thinking && this.thinking && anchor.thinking !== this.thinking) blocked = "thinking_change";
		const f = forecast({ profile, anchor, blocked, nowWall: this.clock.wall(), nowMono: anchor?.endMono == null ? null : this.clock.mono() });
		return { model, profile, anchor, forecast: f, cost: this.cost(ctx, anchor), settings: this.db.settings() };
	}

	cost(ctx, anchor) {
		const cached = promptTokens(anchor?.usage);
		let tokens = null;
		try {
			const t = ctx?.getContextUsage?.()?.tokens;
			if (typeof t === "number" && Number.isFinite(t) && t > 0) tokens = t;
		} catch {}
		if (tokens === null && cached !== null) tokens = cached + (anchor.usage.output ?? 0);
		return costRange({ cost: ctx?.model?.cost, promptTokens: tokens, cachedTokens: cached });
	}

	refresh(ctx) {
		if (this.failure) return this.setStatus(ctx, this.failure.code === "migration_required" ? "cache: upgrade needed" : "cache: error");
		if (!this.db) return this.setStatus(ctx, undefined);
		const e = this.evaluate(ctx);
		this.setStatus(ctx, statusLine(e.forecast, e.cost, e.settings));
		this.scheduleEdge(e.forecast);
	}

	// ----- /cache -----------------------------------------------------------------------------

	async command(args, ctx) {
		const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
		const verb = action.toLowerCase();
		// Bare /cache, /cache menu, and /cache settings open the interactive menu in the TUI; elsewhere they stay read-only.
		const bare = !args.trim() || (verb === "menu" && !rest.length);
		if ((bare || (verb === "settings" && !rest.length)) && this.menu.available(ctx)) return this.menu.open(ctx, bare ? "main" : "settings");
		if (bare) return this.notify(ctx, await this.statusText(ctx));
		const writer = ["on", "off", "seed", "import", "migrate"].includes(verb) || (verb === "settings" && rest.length > 0);
		if (writer && (ctx?.mode !== "tui" || !ctx.hasUI)) {
			return this.notify(ctx, `/cache ${verb} changes local data and is only available in the interactive TUI; nothing changed.`, "warning");
		}
		if (this.failure && writer) {
			this.failure = null;
			this.warned = false;
		}
		switch (verb) {
			case "status":
				return rest.length ? this.usage(ctx) : this.notify(ctx, await this.statusText(ctx));
			case "history": {
				const n = rest[0] === undefined ? 20 : Number(rest[0]);
				if (rest.length > 1 || !Number.isInteger(n) || n < 1 || n > 200) return this.notify(ctx, "Usage: /cache history [1-200]", "warning");
				const db = await this.readDb(ctx);
				return this.notify(ctx, db ? historyText(db.history(n), db.settings().time) : "No cache-insights database yet.");
			}
			case "learn": {
				const ref = rest[0] === undefined ? null : parseModelRef(rest[0]);
				if (rest.length > 1 || (rest[0] !== undefined && !ref)) return this.notify(ctx, "Usage: /cache learn [provider/model]", "warning");
				const db = await this.readDb(ctx);
				return this.notify(ctx, db ? learnText(learnEnvelopes(db, ref ?? {}), db.listProfiles()) : "No cache-insights database yet.");
			}
			case "on":
			case "off":
				return rest.length ? this.usage(ctx) : this.setRecording(ctx, verb === "on");
			case "seed":
				return this.seed(ctx, rest);
			case "import":
				return this.import(ctx, rest);
			case "settings":
				return this.settings(ctx, rest);
			case "migrate":
				return rest.length ? this.usage(ctx) : this.migrate(ctx);
			default:
				return this.usage(ctx);
		}
	}

	usage(ctx) {
		this.notify(ctx, `Usage: ${CACHE_USAGE}`, "warning");
	}

	async readDb(ctx) {
		if (this.failure) return null;
		return this.db ?? (await this.openDb(ctx, false));
	}

	async statusText(ctx) {
		const db = await this.readDb(ctx);
		if (!db) return statusDetails({ db: null, failure: this.failure });
		const e = this.evaluate(ctx);
		const envelope = e.model ? learnEnvelopes(db, e.model)[0] : undefined;
		return statusDetails({ db, ...e, envelope, recording: db.isRecording() });
	}

	async confirm(ctx, title, message) {
		if (typeof ctx.ui?.confirm !== "function") return true;
		return Boolean(await ctx.ui.confirm(title, message));
	}

	async migrate(ctx) {
		const db = await this.openDb(ctx, false, true);
		this.refresh(ctx);
		this.notify(ctx, db ? `Cache-insights database is at schema ${db.schemaVersion}; older draft rows, if any, were kept intact.` : "Cache insights were never set up; there is nothing to migrate.");
	}

	async setRecording(ctx, on) {
		const db = await this.openDb(ctx, on, true);
		if (!db) return this.notify(ctx, "Cache insights were never set up; there is nothing to turn off.");
		db.setRecording(on);
		if (!on) this.prevLive = null;
		this.refresh(ctx);
		this.notify(
			ctx,
			on
				? `Recording is on (saved for future sessions). Pi stores metadata only, locally in ${display(db.paths.dbPath, 400)}: timestamps, provider/model ids, token counts, and catalog cost estimates. No prompts, messages, tool output, errors, headers, or paths. No extra model requests or paid warming.`
				: "Recording is off (saved). Existing data was kept; forecasts from the seeded profile continue.",
		);
	}

	async seed(ctx, rest) {
		const ref = parseModelRef(rest[0]);
		const hit = parseMinutes(rest[1]);
		const expire = parseMinutes(rest[2]);
		if (rest.length !== 3 || !ref || !Number.isFinite(hit) || !Number.isFinite(expire)) return this.notify(ctx, "Usage: /cache seed <provider/model> <hitMinutes> <expireMinutes>", "warning");
		if (!(hit > 0 && hit <= expire && expire <= MAX_PROFILE_MINUTES)) return this.notify(ctx, `Minutes must satisfy 0 < hit <= expire <= ${MAX_PROFILE_MINUTES}; nothing changed.`, "warning");
		const ok = await this.confirm(ctx, "Set cache profile", `Set the active profile for ${ref.provider}/${ref.model}: cache hit while both clocks are under ${hit} min, cache expired once both are over ${expire} min. This writes only the cache-insights database.`);
		if (!ok) return this.notify(ctx, "Cancelled; nothing changed.");
		const db = await this.openDb(ctx, true);
		const p = db.setProfile({ provider: ref.provider, model: ref.model, hitMinutes: hit, expireMinutes: expire });
		this.refresh(ctx);
		this.notify(ctx, `Active profile set for ${p.provider}/${p.model}: hit < ${hit} min, expired > ${expire} min (seeded, provisional).`);
	}

	async import(ctx, rest) {
		if (!rest.every((t) => parseModelRef(t))) return this.notify(ctx, "Usage: /cache import [provider/model ...]", "warning");
		let targets = rest;
		if (!targets.length) {
			// Read-only discovery: an older database reports migration_required instead of being upgraded before the user confirms.
			const db = await this.openDb(ctx, false);
			targets = (db?.listProfiles() ?? []).map((p) => `${p.provider}/${p.model}`);
			if (!targets.length) return this.notify(ctx, "Nothing to import yet: seed a profile (/cache seed <provider/model> <hit> <expire>) or name models (/cache import <provider/model> ...). Nothing changed.", "warning");
		}
		const ok = await this.confirm(
			ctx,
			"Import session metadata",
			`Read your local Pi session files and store metadata only (timestamps, provider/model ids, token counts, cost estimates) for: ${targets.join(", ")}. No content, errors, ids, or paths are stored. Nothing is sent anywhere.`,
		);
		if (!ok) return this.notify(ctx, "Cancelled; nothing imported.");
		const db = await this.openDb(ctx, true);
		const summary = await importHistory(db, { sessionsDir: this.sessionsDirOption ?? defaultSessionsDir(this.env), targets });
		this.refresh(ctx);
		this.notify(ctx, importText(summary));
	}

	async settings(ctx, rest) {
		if (!rest.length) {
			const s = (await this.readDb(ctx))?.settings() ?? { time: "local", cost: "usd" };
			return this.notify(ctx, `Settings: time ${s.time}, cost ${s.cost}. Change with /cache settings [time local|utc] [cost off|usd|credits|both].`);
		}
		const next = {};
		for (let i = 0; i < rest.length; i += 2) {
			const [k, v] = [rest[i]?.toLowerCase(), rest[i + 1]?.toLowerCase()];
			if (k === "time" && ["local", "utc"].includes(v) && !("time" in next)) next.time = v;
			else if (k === "cost" && ["off", "usd", "credits", "both"].includes(v) && !("cost" in next)) next.cost = v;
			else return this.notify(ctx, "Usage: /cache settings [time local|utc] [cost off|usd|credits|both]; nothing changed.", "warning");
		}
		const db = await this.openDb(ctx, true);
		const s = db.setSettings(next);
		this.refresh(ctx);
		this.notify(ctx, `Settings saved: time ${s.time}, cost ${s.cost}.`);
	}
}
