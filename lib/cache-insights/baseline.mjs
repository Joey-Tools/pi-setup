// Startup/resume baseline check, in memory only. The configuration persisted on the current branch (system-message
// checkpoints and patches, tool declarations, thinking level) is compared with the current one. Host helpers are
// injected by the thin Pi adapter, so this core stays dependency-free. Nothing here is stored, hashed, or logged.

/** Stable JSON with sorted keys, for comparing tool declarations in memory. */
function stable(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	const keys = Object.keys(value)
		.filter((k) => value[k] !== undefined && typeof value[k] !== "function")
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
}

/** Declaration fields only (name, description, parameters), preserving cache-relevant tool order. */
export function toolDeclarations(tools) {
	if (!Array.isArray(tools)) return null;
	const out = [];
	for (const t of tools) {
		if (!t || typeof t.name !== "string" || typeof t.description !== "string" || !t.parameters || typeof t.parameters !== "object") return null;
		out.push(stable({ name: t.name, description: t.description, parameters: t.parameters }));
	}
	return out;
}

/**
 * Creates `resolveBaseline(ctx, pi)` from host helpers:
 *   buildSessionContext(entries) → { messages, thinkingLevel }   (@earendil-works/pi-coding-agent)
 *   getCurrentSystemPrompt(messages) → string                    (@earendil-works/pi-ai)
 *   getCurrentTools(messages) → Tool[]                           (@earendil-works/pi-ai)
 * The resolver returns { status: "unchanged" } or { status: "changed", reason } or { status: "unknown" }.
 * Anything missing, empty, or not comparable is "unknown", never "unchanged".
 */
export function createBaselineResolver({ buildSessionContext, getCurrentSystemPrompt, getCurrentTools } = {}) {
	if (typeof buildSessionContext !== "function" || typeof getCurrentSystemPrompt !== "function" || typeof getCurrentTools !== "function") return () => ({ status: "unknown" });
	return (ctx, pi) => {
		try {
			const context = buildSessionContext(ctx.sessionManager.getBranch());
			const persistedPrompt = getCurrentSystemPrompt(context.messages);
			const persistedTools = toolDeclarations(getCurrentTools(context.messages));
			const currentPrompt = ctx.getSystemPrompt();
			const all = pi.getAllTools();
			const active = pi.getActiveTools();
			const currentTools = Array.isArray(active) && Array.isArray(all) ? toolDeclarations(active.map((name) => all.find((t) => t?.name === name))) : null;
			const persistedThinking = context.thinkingLevel;
			const currentThinking = pi.getThinkingLevel();
			if (typeof persistedPrompt !== "string" || !persistedPrompt || typeof currentPrompt !== "string" || !persistedTools || !currentTools) return { status: "unknown" };
			if (typeof persistedThinking !== "string" || typeof currentThinking !== "string") return { status: "unknown" };
			if (persistedPrompt !== currentPrompt || stable(persistedTools) !== stable(currentTools)) return { status: "changed", reason: "system_or_tools_changed" };
			if (persistedThinking !== currentThinking) return { status: "changed", reason: "thinking_change" };
			return { status: "unchanged" };
		} catch {
			return { status: "unknown" };
		}
	};
}
