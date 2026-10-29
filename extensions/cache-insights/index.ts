import { buildSessionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { createBaselineResolver, registerCacheInsights } from "../../lib/cache-insights/index.mjs";

// Prompt-cache forecast from a seeded local profile (/cache). Independent of the Cursor bridge and of progress
// updates. Registering opens nothing and starts no timer: the database is opened at session start only if it
// already exists, or created by an explicit /cache command in the TUI. Pi's own helpers project the persisted
// system prompt and tools of the current branch, so a recovered anchor is verified in memory.
export default function cacheInsights(pi: ExtensionAPI): void {
	registerCacheInsights(pi, { resolveBaseline: createBaselineResolver({ buildSessionContext, getCurrentSystemPrompt, getCurrentTools }) });
}
