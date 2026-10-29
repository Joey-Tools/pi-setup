// Interactive /cache menu for the TUI, built only on Pi's ctx.ui.select/input/confirm/editor. Every write goes
// through the controller's existing validated actions (seed and import keep their own confirmations). One menu runs
// at a time; session start, shutdown, and tree changes invalidate it, so a late dialog answer can never write.
import { historyText, learnText } from "./format.mjs";
import { learnEnvelopes } from "./learner.mjs";
import { display, MINUTE_MS, parseMinutes, parseModelRef } from "./util.mjs";
import { MAX_PROFILE_MINUTES } from "./db.mjs";
import { localZone, timezoneGuide, zoneSummary } from "./tz.mjs";

class MenuClosed extends Error {}

/**
 * A read-only view of `target` with some members replaced. Everything else is read from the original object, and
 * its methods are bound to it, so hosts that use private fields or getters keep working. The original is untouched.
 */
function forward(target, overrides) {
	return new Proxy(target, {
		get(t, prop) {
			if (Object.hasOwn(overrides, prop)) return overrides[prop];
			const value = Reflect.get(t, prop, t);
			return typeof value === "function" ? value.bind(t) : value;
		},
		has: (t, prop) => Object.hasOwn(overrides, prop) || Reflect.has(t, prop),
		set: () => false,
		defineProperty: () => false,
		deleteProperty: () => false,
	});
}
const BACK = "Back";
const minutes = (ms) => String(Math.round((ms / MINUTE_MS) * 1000) / 1000);
const refText = (r) => `${display(r.provider, 60)}/${display(r.model, 80)}`;
const TIME_CHOICES = { "Local time": "local", UTC: "utc" };
const COST_CHOICES = { Off: "off", USD: "usd", "GitHub credits": "credits", "USD and GitHub credits": "both" };

export class CacheMenu {
	constructor(controller) {
		this.c = controller;
		this.generation = 0;
		this.active = null;
	}

	available(ctx) {
		return ctx?.mode === "tui" && Boolean(ctx.hasUI) && typeof ctx.ui?.select === "function";
	}

	/** Ends any open menu: its pending dialogs are aborted and their late answers ignored. */
	invalidate() {
		this.generation++;
		this.active?.abort();
		this.active = null;
	}

	async open(ctx, start = "main") {
		if (this.active) return this.c.notify(ctx, "A /cache menu is already open.");
		const ac = new AbortController();
		const generation = this.generation;
		this.active = ac;
		const live = () => generation === this.generation && !ac.signal.aborted;
		const ask = async (fn) => {
			if (!live()) throw new MenuClosed();
			const answer = await fn();
			if (!live()) throw new MenuClosed();
			return answer;
		};
		const raw = ctx.ui;
		const ui = forward(raw, {
			select: async (title, choices) => ask(() => raw.select(title, choices, { signal: ac.signal })).then((r) => (choices.includes(r) ? r : undefined)),
			input: async (title, placeholder) => ask(() => (typeof raw.input === "function" ? raw.input(title, placeholder, { signal: ac.signal }) : undefined)).then((r) => (typeof r === "string" ? r : undefined)),
			confirm: async (title, message) => ask(() => (typeof raw.confirm === "function" ? raw.confirm(title, message, { signal: ac.signal }) : false)).then(Boolean),
			editor: typeof raw.editor === "function" ? async (title, text) => ask(() => raw.editor(title, text)) : undefined,
			notify: (message, level) => (live() ? raw.notify?.(message, level) : undefined),
		});
		const mctx = forward(ctx, { ui });
		try {
			await (start === "settings" ? this.settings(mctx) : this.main(mctx));
		} catch (err) {
			if (!(err instanceof MenuClosed)) throw err;
		} finally {
			if (this.active === ac) this.active = null;
		}
	}

	/**
	 * Runs a write action the way an explicit /cache command would (clearing a previous failure first). If it was
	 * cancelled before opening anything, the previous failure is kept, so the menu does not repeat its warning.
	 */
	async write(fn) {
		const { failure, warned } = this.c;
		this.c.failure = null;
		this.c.warned = false;
		await fn();
		if (failure && !this.c.failure && !this.c.db) Object.assign(this.c, { failure, warned });
	}

	/** Existing database, read-only (never created or upgraded here). null when absent or not usable. */
	async readDb(ctx) {
		try {
			return await this.c.readDb(ctx);
		} catch (err) {
			this.c.fail(ctx, err);
			return null;
		}
	}

	async view(ctx, title, text) {
		if (ctx.ui.editor) await ctx.ui.editor(`${title} (read-only; edits are ignored)`, text);
		else this.c.notify(ctx, text);
	}

	/** Why the stored data cannot be shown or changed right now, or null. */
	blocked() {
		const f = this.c.failure;
		if (!f) return null;
		if (f.code === "migration_required") return "The cache-insights database needs a one-time upgrade before this can be used. Choose \"Upgrade the database\" in /cache (it asks first); nothing changed.";
		return `Cache insights cannot use the database right now (${display(f.code, 40)}); see Status and forecast. Nothing changed.`;
	}

	async main(ctx) {
		for (;;) {
			const db = await this.readDb(ctx);
			const model = this.c.activeModel(ctx);
			const recording = Boolean(db?.isRecording());
			const f = this.c.failure;
			const s = f ? null : (db?.settings() ?? { time: "local", cost: "usd" });
			const state = f ? (f.code === "migration_required" ? "upgrade needed" : `needs attention (${display(f.code, 40)})`) : db ? `recording ${recording ? "on" : "off"}` : "not set up";
			const title = `Cache insights · ${model ? refText(model) : "no active model"} · ${state} · ${s ? `time ${s.time} · cost ${s.cost}` : "settings unknown"}`;
			const gated = (fn) => () => (this.blocked() ? this.c.notify(ctx, this.blocked(), "warning") : fn());
			const actions = {
				"Status and forecast": () => this.c.statusText(ctx).then((text) => this.view(ctx, "Cache status", text)),
				"Display settings": gated(() => this.settings(ctx)),
				[f ? "Recording (unavailable)" : recording ? "Recording: on (turn off)" : "Recording: off (turn on)"]: gated(() => this.write(() => this.c.setRecording(ctx, !recording))),
				"Seed or edit a model profile": gated(() => this.profile(ctx, db)),
				"Import session metadata": gated(() => this.import(ctx, db)),
				"Learning candidates": gated(() => this.learn(ctx, db)),
				"Recent history": gated(() => this.history(ctx)),
				[f?.code === "migration_required" ? "Upgrade the database (needed)" : "Upgrade the database"]: () => this.migrate(ctx),
			};
			const choice = await ctx.ui.select(title, [...Object.keys(actions), "Close"]);
			if (!choice || choice === "Close") return;
			await actions[choice]();
		}
	}

	async settings(ctx) {
		for (;;) {
			const db = await this.readDb(ctx);
			if (this.blocked()) return this.c.notify(ctx, this.blocked(), "warning");
			const s = db?.settings() ?? { time: "local", cost: "usd" };
			const timeLabel = `Times: ${s.time === "utc" ? "UTC" : "local"} (change)`;
			const costLabel = `Cost: ${s.cost} (change)`;
			const zone = localZone(this.c.clock.wall());
			const guide = "Local timezone guide";
			const choice = await ctx.ui.select(`Display settings · local time zone: ${zoneSummary(zone)}`, [timeLabel, costLabel, guide, BACK]);
			if (!choice || choice === BACK) return;
			if (choice === guide) {
				await this.view(ctx, "Local timezone guide", timezoneGuide(zone));
				continue;
			}
			const [key, map] = choice === timeLabel ? ["time", TIME_CHOICES] : ["cost", COST_CHOICES];
			const picked = await ctx.ui.select(key === "time" ? "Show times in" : "Show the approximate cost as", [...Object.keys(map), BACK]);
			if (picked && picked !== BACK) await this.write(() => this.c.settings(ctx, [key, map[picked]]));
		}
	}

	/** Choices of models: the active one, seeded profiles, then a typed entry. Returns a label → ref map. */
	modelChoices(ctx, db, { current = "Current model" } = {}) {
		const out = new Map();
		const add = (label, ref) => {
			let l = label;
			for (let i = 2; out.has(l); i++) l = `${label} (${i})`;
			out.set(l, ref);
		};
		const model = this.c.activeModel(ctx);
		const profiles = db?.listProfiles() ?? [];
		const describe = (r) => {
			const p = profiles.find((x) => x.provider === r.provider && x.model === r.model) ?? db?.getProfile(r.provider, r.model);
			return p ? `hit < ${minutes(p.hitUnderMs)} min, expired > ${minutes(p.expireOverMs)} min` : "no profile";
		};
		if (model) add(`${current}: ${refText(model)} (${describe(model)})`, model);
		for (const p of profiles) if (!model || p.provider !== model.provider || p.model !== model.model) add(`${refText(p)} (${describe(p)})`, { provider: p.provider, model: p.model });
		return { choices: out, profiles };
	}

	async typedModels(ctx, title, { multiple = false } = {}) {
		const text = await ctx.ui.input(title, multiple ? "provider/model (several separated by spaces)" : "provider/model");
		if (!text?.trim()) return null;
		const refs = text.trim().split(/[\s,]+/).map(parseModelRef);
		if (refs.some((r) => !r)) {
			this.c.notify(ctx, "Models must look like provider/model; nothing changed.", "warning");
			return null;
		}
		if (!multiple && refs.length > 1) {
			this.c.notify(ctx, "Choose exactly one model (provider/model); nothing changed.", "warning");
			return null;
		}
		return refs;
	}

	async profile(ctx, db) {
		const { choices } = this.modelChoices(ctx, db);
		const other = "Other model (type provider/model)";
		const choice = await ctx.ui.select("Seed or edit a model profile", [...choices.keys(), other, BACK]);
		if (!choice || choice === BACK) return;
		const ref = choice === other ? (await this.typedModels(ctx, "Model to profile"))?.[0] : choices.get(choice);
		if (!ref) return;
		const existing = db?.getProfile(ref.provider, ref.model);
		const ask = async (what, current) => {
			const hint = current ? `Enter keeps ${current}` : "for example 25";
			const text = await ctx.ui.input(`${what} for ${refText(ref)}, in minutes (${hint}; Esc cancels)`, current ? `${current} (Enter keeps)` : "minutes");
			if (text === undefined) return null;
			if (!text.trim()) return current ? parseMinutes(current) : null;
			const n = parseMinutes(text.trim());
			if (!Number.isFinite(n)) {
				this.c.notify(ctx, "Minutes must be a plain number such as 25 or 2.5; nothing changed.", "warning");
				return null;
			}
			return n;
		};
		const hit = await ask("Cache hit while both clocks are under", existing && minutes(existing.hitUnderMs));
		if (hit === null) return this.c.notify(ctx, "Cancelled; nothing changed.");
		const expire = await ask("Cache expired once both clocks are over", existing && minutes(existing.expireOverMs));
		if (expire === null) return this.c.notify(ctx, "Cancelled; nothing changed.");
		if (!(hit > 0 && hit <= expire && expire <= MAX_PROFILE_MINUTES)) return this.c.notify(ctx, `Minutes must satisfy 0 < hit <= expire <= ${MAX_PROFILE_MINUTES}; nothing changed.`, "warning");
		await this.write(() => this.c.seed(ctx, [`${ref.provider}/${ref.model}`, String(hit), String(expire)]));
	}

	async import(ctx, db) {
		const { choices, profiles } = this.modelChoices(ctx, db);
		const all = profiles.length ? `All seeded models (${profiles.length})` : null;
		const other = "Other models (type provider/model)";
		const choice = await ctx.ui.select("Import session metadata (metadata only; you confirm before anything is written)", [...(all ? [all] : []), ...choices.keys(), other, BACK]);
		if (!choice || choice === BACK) return;
		const refs = choice === all ? profiles : choice === other ? await this.typedModels(ctx, "Models to import", { multiple: true }) : [choices.get(choice)];
		if (!refs?.length) return;
		await this.write(() => this.c.import(ctx, refs.map((r) => `${r.provider}/${r.model}`)));
	}

	async learn(ctx, db) {
		if (!db) return this.c.notify(ctx, "No cache-insights database yet.");
		const { choices } = this.modelChoices(ctx, db);
		const allLabel = "All models";
		const other = "Other model (type provider/model)";
		const choice = await ctx.ui.select("Learning candidates (observations; they never change a profile)", [allLabel, ...choices.keys(), other, BACK]);
		if (!choice || choice === BACK) return;
		const ref = choice === allLabel ? {} : choice === other ? (await this.typedModels(ctx, "Model to show"))?.[0] : choices.get(choice);
		if (!ref) return;
		await this.view(ctx, "Learning candidates", learnText(learnEnvelopes(db, ref), db.listProfiles()));
	}

	async history(ctx) {
		const other = "Other (1-200)";
		const choice = await ctx.ui.select("Recent history: how many samples?", ["20", "50", "100", "200", other, BACK]);
		if (!choice || choice === BACK) return;
		const typed = choice === other ? await ctx.ui.input("Samples to show (1-200)", "20") : choice;
		if (typed === undefined) return;
		const n = /^\d+$/.test(typed.trim()) ? Number(typed.trim()) : Number.NaN;
		if (!Number.isInteger(n) || n < 1 || n > 200) return this.c.notify(ctx, "Choose 1 to 200 samples.", "warning");
		const db = await this.readDb(ctx);
		await this.view(ctx, "Recent history", db ? historyText(db.history(n), db.settings().time) : "No cache-insights database yet.");
	}

	async migrate(ctx) {
		const ok = await ctx.ui.confirm("Upgrade the cache-insights database", "Upgrade an older cache-insights database in place. Older rows are kept intact. Nothing else changes.");
		if (!ok) return this.c.notify(ctx, "Cancelled; nothing changed.");
		await this.write(() => this.c.migrate(ctx));
	}
}
