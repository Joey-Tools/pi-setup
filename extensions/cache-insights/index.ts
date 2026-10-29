import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCacheInsights } from "../../lib/cache-insights/index.mjs";

// Prompt-cache forecast from a seeded local profile (/cache). Independent of the Cursor bridge and of progress
// updates. Registering opens nothing and starts no timer: the database is opened at session start only if it
// already exists, or created by an explicit /cache command in the TUI.
export default function cacheInsights(pi: ExtensionAPI): void {
	registerCacheInsights(pi);
}
