// Stable public API of the cache-insights feature (used by the extension, the CLI, and tests).
// Independent of the Cursor bridge: nothing here imports lib/index.mjs or its modules.
export { CacheInsights, CACHE_USAGE, registerCacheInsights, STATUS_KEY } from "./controller.mjs";
export { AUTO_SETTINGS, COST_SETTINGS, MAX_PROFILE_MINUTES, openCacheDb, SCHEMA_VERSION, TIME_SETTINGS } from "./db.mjs";
export { CLOCK_TOLERANCE_MS, costRange, forecast, LABELS } from "./forecast.mjs";
export { createBaselineResolver } from "./baseline.mjs";
export { importHistory } from "./importer.mjs";
export {
	AUTO_BLOCKERS,
	AUTO_MIN_LATER_MISSES,
	AUTO_MIN_REUSE_PAIRS,
	AUTO_POLICY,
	autoDecision,
	EVIDENCE_MISSING,
	EVIDENCE_STAGES,
	evidenceReport,
	learnEnvelopes,
} from "./learner.mjs";
export { CACHE_DB_FILE, defaultAgentDir, defaultCacheRoot, defaultSessionsDir } from "./paths.mjs";
export { CacheInsightsError, parseMinutes, parseModelRef, sameModel } from "./util.mjs";
