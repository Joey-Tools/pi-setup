// Stable public API of the cache-insights feature (used by the extension, the CLI, and tests).
// Independent of the Cursor bridge: nothing here imports lib/index.mjs or its modules.
export { CacheInsights, CACHE_USAGE, registerCacheInsights, STATUS_KEY } from "./controller.mjs";
export { COST_SETTINGS, MAX_PROFILE_MINUTES, openCacheDb, SCHEMA_VERSION, TIME_SETTINGS } from "./db.mjs";
export { CLOCK_TOLERANCE_MS, costRange, forecast, LABELS } from "./forecast.mjs";
export { importHistory } from "./importer.mjs";
export { learnEnvelopes } from "./learner.mjs";
export { CACHE_DB_FILE, defaultAgentDir, defaultCacheRoot, defaultSessionsDir } from "./paths.mjs";
export { CacheInsightsError, parseMinutes, parseModelRef, sameModel } from "./util.mjs";
