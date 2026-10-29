// The in-memory baseline check through its public factory, with fake host helpers shaped like Pi's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBaselineResolver } from "../../lib/cache-insights/index.mjs";

const read = { name: "read", description: "Synthetic read tool", parameters: { type: "object", properties: { path: { type: "string" } } } };
const bash = { name: "bash", description: "Synthetic bash tool", parameters: { properties: {}, type: "object" } };

/** Fake host: the branch projects to `persisted`; the running Pi reports `current`. */
function run(persisted, current, helpers = {}) {
	const resolve = createBaselineResolver({
		buildSessionContext: (entries) => ({ messages: entries, thinkingLevel: persisted.thinking }),
		getCurrentSystemPrompt: () => persisted.prompt,
		getCurrentTools: () => persisted.tools,
		...helpers,
	});
	const ctx = { sessionManager: { getBranch: () => [{ role: "system" }] }, getSystemPrompt: () => current.prompt };
	const pi = { getActiveTools: () => current.active, getAllTools: () => current.all, getThinkingLevel: () => current.thinking };
	return resolve(ctx, pi);
}
const same = { prompt: "Synthetic baseline\n\nSynthetic rules", tools: [read, bash], thinking: "high" };
const now = (o = {}) => ({ prompt: same.prompt, active: ["read", "bash"], all: [{ ...read, execute() {}, renderCall() {} }, bash, { name: "extra", description: "inactive", parameters: {} }], thinking: "high", ...o });

test("unchanged prompt, ordered tool declarations (ignoring functions and inactive tools), and thinking", () => {
	assert.deepEqual(run(same, now()), { status: "unchanged" });
	assert.deepEqual(run(same, now({ all: [bash, { ...read, parameters: { properties: { path: { type: "string" } }, type: "object" } }] })), { status: "unchanged" }, "key order inside schemas does not matter");
});

test("a changed prompt, tool set, tool declaration, or thinking level is a change", () => {
	const changed = { status: "changed", reason: "system_or_tools_changed" };
	assert.deepEqual(run(same, now({ prompt: `${same.prompt}\n\nNew rule` })), changed);
	assert.deepEqual(run(same, now({ active: ["read"] })), changed);
	assert.deepEqual(run(same, now({ active: ["bash", "read"] })), changed, "tool order can affect the cached prefix");
	assert.deepEqual(run(same, now({ all: [{ ...read, description: "Edited" }, bash] })), changed);
	assert.deepEqual(run(same, now({ all: [{ ...read, parameters: { type: "object", properties: {} } }, bash] })), changed);
	assert.deepEqual(run(same, now({ thinking: "low" })), { status: "changed", reason: "thinking_change" });
});

test("anything missing or not comparable is unknown, never unchanged", () => {
	const unknown = { status: "unknown" };
	assert.deepEqual(run({ ...same, prompt: "" }, now()), unknown, "no persisted system prompt");
	assert.deepEqual(run({ ...same, tools: undefined }, now()), unknown);
	assert.deepEqual(run(same, now({ all: [{ name: "read", description: "Synthetic read tool" }, bash] })), unknown, "tool metadata without parameters");
	assert.deepEqual(run(same, now({ active: ["read", "bash", "ghost"] })), unknown, "an active tool without metadata");
	assert.deepEqual(run({ ...same, thinking: undefined }, now()), unknown);
	assert.deepEqual(run(same, now({ prompt: undefined })), unknown);
	assert.deepEqual(
		run(same, now(), {
			buildSessionContext: () => {
				throw new Error("boom");
			},
		}),
		unknown,
	);
	assert.deepEqual(createBaselineResolver({})({}, {}), unknown, "without host helpers");
});
