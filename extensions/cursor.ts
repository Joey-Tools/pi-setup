import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { configFromEnv, createModelReviewer, WorkerError, WorkerManager } from "../lib/index.mjs";

const Params = Type.Object(
	{
		action: StringEnum(["run", "list", "close"] as const, { description: "run a task on a named worker, list workers, or close one" }),
		name: Type.Optional(Type.String({ description: "Worker name, 1-48 chars of [A-Za-z0-9_-] (e.g. scout, impl, tests, review). Required for run/close." })),
		task: Type.Optional(Type.String({ description: "run: self-contained task with all context the worker needs (it cannot see this conversation)" })),
		cwd: Type.Optional(Type.String({ description: "run: working directory for a new worker (default: the Pi cwd). Fixed after the first run; omit it on follow-ups. Use a separate git worktree and worker name per concurrent writer." })),
		mode: Type.Optional(StringEnum(["agent", "plan", "ask"] as const, { description: "run: agent (can edit), plan, or ask (behavioral read-only intent; not enforced, not a sandbox). Default: the worker's current mode, agent for new workers." })),
		timeoutSeconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 86400, description: "run: cancel the task after this many seconds (default 1800)" })),
		forget: Type.Optional(Type.Boolean({ description: "close: also delete the local worker record so the next run with this name starts a new Cursor session (Cursor's own history and run artifacts are kept)" })),
	},
	{ additionalProperties: false },
);

type WorkerSummary = {
	name: string;
	live: boolean;
	busy: boolean;
	cwd?: string;
	sessionId?: string;
	mode?: string;
	lastRun?: { status?: string; stopReason?: string };
	error?: string;
};

function formatList(manager: WorkerManager, workers: WorkerSummary[]): string {
	const lines = [
		`Cursor workers (${manager.profileLabel}, permissions=${manager.opts.permissionPolicy}${manager.opts.permissionPolicy === "review" ? " by the active Pi model" : ""}, max live ${manager.opts.maxWorkers})`,
		`State: ${manager.registry.scopeDir}`,
	];
	if (!workers.length) lines.push("No workers in this Pi session yet.");
	for (const w of workers) {
		if (w.error) {
			lines.push(`- ${w.name}: unreadable record (${w.error})`);
			continue;
		}
		const state = `${w.live ? "live" : "saved"}${w.busy ? ", busy" : ""}`;
		const last = w.lastRun ? ` last=${w.lastRun.status}${w.lastRun.stopReason ? `/${w.lastRun.stopReason}` : ""}` : "";
		lines.push(`- ${w.name} [${state}] mode=${w.mode ?? "?"}${last} cwd=${w.cwd} session=${w.sessionId}`);
	}
	return lines.join("\n");
}

export default function cursorWorkers(pi: ExtensionAPI) {
	let manager: WorkerManager | undefined;

	// Created lazily on first use; constructing the manager starts no processes.
	function getManager(ctx: ExtensionContext): WorkerManager {
		const piSessionId = ctx.sessionManager.getSessionId();
		if (manager && manager.opts.piSessionId === piSessionId) return manager;
		if (manager) void manager.shutdown();
		const config = configFromEnv(process.env, { agentDir: getAgentDir() });
		manager = new WorkerManager({ ...config, projectCwd: ctx.cwd, piSessionId });
		return manager;
	}

	pi.on("session_shutdown", async () => {
		const current = manager;
		manager = undefined;
		await current?.shutdown();
	});

	pi.registerTool({
		name: "cursor_worker",
		label: "Cursor worker",
		description:
			"Delegate work to persistent, named Cursor agents (native `agent acp`, using the user's Cursor subscription). " +
			"action=run sends a task to the named worker: created on first use, it keeps its own conversation across runs and Pi restarts within this Pi session. " +
			"action=list shows workers; action=close releases a worker process (its session stays resumable; forget:true drops the local record so the name starts fresh). " +
			"The Cursor model profile (default claude-opus-5-5, 1M context, high effort, fast off) is set and verified before every prompt; it and the permission policy are user-configured and cannot be changed by tool arguments. " +
			"By default (permission policy review) your current Pi model reviews each permission request Cursor sends, seeing only the task and that request: it approves routine task-scoped actions once, denies clearly prohibited ones, and escalates risky or unclear ones to the user (rejected without a UI). " +
			"The policy only gates actions Cursor asks about; reads, in-workspace edits, and user-allowlisted actions can run without asking, and no mode is a sandbox. " +
			"stopReason=end_turn means the turn ended, not that the task succeeded. The returned text is capped; the full result and ACP event log paths are included. Permission-review model usage is reported with this tool result; Cursor usage/cost is not included in Pi totals.",
		promptSnippet: "Delegate exploration, implementation, testing, and review to persistent named Cursor workers",
		promptGuidelines: [
			"Use cursor_worker to delegate expensive exploration, implementation, test runs, and code review to Cursor; keep planning, decisions, and the final synthesis yourself.",
			"Give each cursor_worker task a self-contained handoff (goal, relevant paths, constraints, acceptance criteria, tests to run); workers cannot see this conversation.",
			"Reuse a cursor_worker name for follow-ups on the same thread of work; use distinct names (scout, impl, review) for independent work, which may run in parallel.",
			"Never run two writing cursor_workers on the same checkout at once: give each concurrent writer its own git worktree via cwd. Use mode ask or plan for read-only scouting and review.",
			"A finished cursor_worker run (end_turn) does not prove success: check its reply, diffs, and test output before reporting claims as facts; if a run fails or is cancelled, do not assume its changes are complete.",
		],
		parameters: Params,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const m = getManager(ctx);
			if (params.action === "list") {
				const workers = await m.list();
				return { content: [{ type: "text", text: formatList(m, workers) }], details: { action: "list", workers } };
			}
			if (!params.name) throw new Error(`cursor_worker action=${params.action} requires name`);
			if (params.action === "close") {
				const result = await m.close(params.name, { forget: params.forget === true });
				const text = `Worker "${params.name}": ${result.wasLive ? "process released" : "no live process"}${
					result.forgotten
						? "; local worker record deleted (next run starts a new Cursor session; Cursor's own history and run artifacts remain)"
						: "; worker record kept for resume"
				}.`;
				return { content: [{ type: "text", text }], details: { action: "close", ...result } };
			}
			if (!params.task) throw new Error("cursor_worker action=run requires task");
			const name = params.name;
			const askPermission = ctx.hasUI
				? (req: { worker: string; cwd: string; title: string; message: string; review?: { reason: string; model?: string } }, dialogSignal: AbortSignal) =>
						ctx.ui.confirm(
							`Cursor worker "${req.worker}" requests permission`,
							`${req.review ? `Pi reviewer (${req.review.model ?? "unavailable"}) escalated this to you: ${req.review.reason}\n\n` : ""}${req.message}\ncwd: ${req.cwd}\n\nAllow once?`,
							{ signal: dialogSignal },
						)
				: undefined;
			// One reviewer per run: the active Pi model, one direct request per permission, no tools and no conversation.
			const reviewPermission =
				m.opts.permissionPolicy === "review" && ctx.model
					? createModelReviewer({
							model: ctx.model,
							streamSimple: (model: any, context: any, options: any) => ctx.modelRegistry.streamSimple(model, context, options),
							thinkingLevel: pi.getThinkingLevel(),
						})
					: undefined;
			let result;
			try {
				result = await m.run({
					name,
					task: params.task,
					cwd: params.cwd,
					mode: params.mode,
					timeoutMs: params.timeoutSeconds ? params.timeoutSeconds * 1000 : undefined,
					signal,
					askPermission,
					reviewPermission,
					onProgress: (p: { elapsedMs: number; toolCalls: number; resultChars: number; permissionReviews: number }) =>
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `Cursor worker "${name}" running: ${Math.round(p.elapsedMs / 1000)}s, ${p.toolCalls} tool calls, ${p.resultChars} chars${p.permissionReviews ? `, ${p.permissionReviews} permission reviews` : ""}`,
								},
							],
							details: { action: "run", status: "running", ...p },
						}),
				});
			} catch (err) {
				// Keep the reviewer's usage in Pi's totals even when the run fails.
				const failure = err instanceof WorkerError ? (err.details as { usage?: any; counts?: Record<string, number> } | undefined) : undefined;
				const usage = failure?.usage;
				if (!usage) throw err;
				return {
					content: [{ type: "text", text: (err as Error).message }],
					details: { action: "run", status: "failed", name, counts: failure?.counts },
					usage,
					isError: true,
				};
			}
			return { content: [{ type: "text", text: result.text }], details: { action: "run", ...result.details }, usage: result.usage };
		},
	});

	pi.registerCommand("cursor-workers", {
		description: "List Cursor workers for this Pi session (`/cursor-workers close <name>` releases one)",
		handler: async (args, ctx) => {
			try {
				const m = getManager(ctx);
				const [sub, name] = args.trim().split(/\s+/);
				if (sub === "close" && name) {
					const r = await m.close(name);
					ctx.ui.notify(`Worker "${name}": ${r.wasLive ? "process released" : "no live process"}; saved session kept.`, "info");
					return;
				}
				ctx.ui.notify(formatList(m, await m.list()), "info");
			} catch (err) {
				ctx.ui.notify(`cursor-workers: ${(err as Error).message}`, "error");
			}
		},
	});
}
