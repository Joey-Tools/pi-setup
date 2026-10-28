import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_ENTRY_TYPE = "progress-updates-state";
const WIDGET_KEY = "pi-progress-updates";
// Pi wraps each custom section in a tag of the same name, so the key must match /^[a-z][a-z0-9_-]*$/.
const PROMPT_SECTION = "progress_updates";
const MAX_PROGRESS_TEXT_LENGTH = 500;
// pi's array-widget renderer keeps only the first 10 entries and appends its
// own truncation marker. Keep the same budget here, but select from the tail
// so the newest progress updates remain visible.
const MAX_WIDGET_LINES = 10;
const MAX_VISIBLE_UPDATES = MAX_WIDGET_LINES - 1;
const MAX_SEEN_KEYS = 256;

const PROGRESS_UPDATE_GUIDANCE = `User-visible progress updates (Pi):

For tasks that require multiple meaningful steps:

- Before the first tool call, briefly state the intended approach and the immediate next step.
- After a meaningful milestone, send a concise user-visible progress update before continuing.
- A milestone is a completed phase, an important finding that changes the plan, a blocker, a resolved blocker, or substantial work completed.
- Each update should be 1–3 sentences and cover what was completed, the important finding or blocker, and the next step when useful.
- Do not narrate every individual tool call. Normally send at most one update per meaningful phase.
- Use the user's language and write the update as normal assistant text, not as hidden reasoning.
- Do not reveal private chain-of-thought, credentials, raw tool arguments, or raw tool output; mention only the relevant user-facing result.
- If the task is trivial or can be completed in one step, skip progress updates.
- Continue to provide a separate final answer after the task is complete.`;

interface ProgressStateEntry {
	type?: string;
	customType?: string;
	data?: unknown;
}

interface ProgressState {
	enabled: boolean;
}

function readPersistedState(ctx: ExtensionContext): boolean | undefined {
	const entries = ctx.sessionManager.getBranch() as ProgressStateEntry[];

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;

		const data = entry.data as Partial<ProgressState> | undefined;
		if (typeof data?.enabled === "boolean") return data.enabled;
	}

	return undefined;
}

function parseTextPhase(signature: string | undefined): "commentary" | "final_answer" | undefined {
	if (!signature?.startsWith("{")) return undefined;

	try {
		const parsed = JSON.parse(signature) as { phase?: unknown };
		if (parsed.phase === "commentary" || parsed.phase === "final_answer") return parsed.phase;
	} catch {
		// Providers may use opaque signatures that are not JSON.
	}

	return undefined;
}

function sanitizeProgressText(value: string): string {
	const withoutControls = value
		// OSC, DCS, SOS, PM, and APC strings carry payloads (titles, hyperlinks, clipboard writes); drop them whole.
		.replace(/(?:\u001b[\]PX^_]|[\u0090\u0098\u009d\u009e\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g, "")
		.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b[ -/]*[0-~]?/g, "")
		.replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
		.replace(/[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
	const compact = withoutControls.replace(/\s+/g, " ").trim();
	if (compact.length <= MAX_PROGRESS_TEXT_LENGTH) return compact;

	let end = MAX_PROGRESS_TEXT_LENGTH - 1;
	const last = compact.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return `${compact.slice(0, end)}…`;
}

function isTextBlock(block: AssistantMessage["content"][number]): block is TextContent {
	return block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
}

function extractProgressUpdates(message: AssistantMessage): string[] {
	if (!Array.isArray(message.content)) return [];
	const textBlocks = message.content.filter(isTextBlock);
	if (textBlocks.length === 0) return [];

	const phases = textBlocks.map((block) => parseTextPhase(block.textSignature));
	const hasExplicitPhase = phases.some((phase) => phase !== undefined);
	const hasToolCall = message.content.some((block) => block?.type === "toolCall");

	// OpenAI Responses/Codex preserves commentary versus final-answer phase in
	// textSignature. For other providers, text before a tool call is the
	// provider-neutral equivalent of a progress preamble.
	const candidates = hasExplicitPhase
		? textBlocks.filter((_block, index) => phases[index] === "commentary")
		: message.stopReason === "toolUse" || hasToolCall
			? textBlocks
			: [];

	return candidates.map((block) => sanitizeProgressText(block.text)).filter((text) => text.length > 0);
}

function clearWidget(ctx: ExtensionContext): void {
	if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
}

function renderWidget(ctx: ExtensionContext, updates: string[], total: number): void {
	if (ctx.mode !== "tui") return;
	if (updates.length === 0) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	const omittedUpdates = total > MAX_VISIBLE_UPDATES;
	const availableUpdateLines = MAX_VISIBLE_UPDATES - (omittedUpdates ? 1 : 0);
	const visibleUpdates = updates.slice(-availableUpdateLines);
	const lines = [
		"Progress",
		...(omittedUpdates ? ["... (older progress updates truncated)"] : []),
		...visibleUpdates.map((update) => `› ${update}`),
	];
	ctx.ui.setWidget(WIDGET_KEY, lines);
}

export default function progressUpdatesExtension(pi: ExtensionAPI): void {
	let enabled = true;
	let activeRun = false;
	let pendingNewRun = false;
	// Only the newest updates the widget can show are kept; `totalUpdates` drives the omission marker.
	let progressUpdates: string[] = [];
	let totalUpdates = 0;
	let seenProgressKeys = new Set<string>();

	function clearHistory(): void {
		progressUpdates = [];
		totalUpdates = 0;
	}

	function resetProgress(ctx?: ExtensionContext): void {
		activeRun = false;
		pendingNewRun = false;
		clearHistory();
		seenProgressKeys = new Set<string>();
		if (ctx) clearWidget(ctx);
	}

	function restoreEnabled(ctx: ExtensionContext): void {
		enabled = readPersistedState(ctx) ?? true;
	}

	function setEnabled(value: boolean): void {
		if (value === enabled) return;
		enabled = value;
		pi.appendEntry(STATE_ENTRY_TYPE, { enabled });
	}

	function remember(key: string): boolean {
		if (seenProgressKeys.has(key)) return false;
		seenProgressKeys.add(key);
		if (seenProgressKeys.size > MAX_SEEN_KEYS) {
			const oldest = seenProgressKeys.values().next().value;
			if (oldest !== undefined) seenProgressKeys.delete(oldest);
		}
		return true;
	}

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	}

	pi.registerCommand("progress", {
		description: "Toggle user-visible progress updates (/progress on|off|clear|status)",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();

			if (!value || value === "status") {
				notify(ctx, `Progress updates are ${enabled ? "enabled" : "disabled"}.`);
				return;
			}

			if (value === "on" || value === "enable" || value === "enabled") {
				setEnabled(true);
				notify(ctx, "Progress updates enabled.");
				return;
			}

			if (value === "off" || value === "disable" || value === "disabled") {
				setEnabled(false);
				resetProgress(ctx);
				notify(ctx, "Progress updates disabled.");
				return;
			}

			if (value === "clear") {
				// Keep collecting for an active run; the seen keys stay so cleared updates do not reappear.
				clearHistory();
				clearWidget(ctx);
				notify(ctx, "Progress history cleared.");
				return;
			}

			notify(ctx, "Usage: /progress [on|off|clear|status]", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreEnabled(ctx);
		resetProgress(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreEnabled(ctx);
		resetProgress(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		resetProgress(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		pendingNewRun = true;
		const sections = event.systemPromptOptions?.sections;
		if (!sections) return;
		if (enabled) sections[PROMPT_SECTION] = PROGRESS_UPDATE_GUIDANCE;
		else delete sections[PROMPT_SECTION];
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!enabled || ctx.mode !== "tui") {
			activeRun = false;
			pendingNewRun = false;
			return;
		}

		// Retries, compaction retries, and queued work start another low-level run without
		// before_agent_start; they keep the current history. A new prompt starts fresh.
		if (!activeRun || pendingNewRun) {
			clearHistory();
			seenProgressKeys = new Set<string>();
		}
		pendingNewRun = false;
		activeRun = true;
		renderWidget(ctx, progressUpdates, totalUpdates);
	});

	pi.on("message_end", async (event, ctx) => {
		if (!enabled || !activeRun || ctx.mode !== "tui" || event.message.role !== "assistant") return;

		const message = event.message as AssistantMessage;
		const updates = extractProgressUpdates(message);
		if (updates.length === 0) return;

		let changed = false;
		updates.forEach((update, index) => {
			if (!remember(`${message.timestamp}:${index}:${update}`)) return;
			progressUpdates.push(update);
			if (progressUpdates.length > MAX_VISIBLE_UPDATES) progressUpdates.shift();
			totalUpdates++;
			changed = true;
		});

		if (changed) renderWidget(ctx, progressUpdates, totalUpdates);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		activeRun = false;
		pendingNewRun = false;
		renderWidget(ctx, progressUpdates, totalUpdates);
	});
}
