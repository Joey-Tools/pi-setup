export class ProfileError extends Error {
	constructor(message, diagnostics) {
		super(message);
		this.name = "ProfileError";
		this.diagnostics = diagnostics;
	}
}

/** Order matters: the model must be selected first because it determines which context/effort/fast values exist. */
export function profileSteps(profile) {
	return [
		["model", profile.model],
		["context", profile.context],
		["effort", profile.effort],
		["fast", profile.fast],
	];
}

function offeredValues(option) {
	const out = [];
	for (const entry of option?.options ?? []) {
		if (Array.isArray(entry?.options)) {
			for (const inner of entry.options) if (inner?.value !== undefined) out.push(String(inner.value));
		} else if (entry?.value !== undefined) {
			out.push(String(entry.value));
		}
	}
	return out;
}

export function summarizeConfig(configOptions) {
	if (!Array.isArray(configOptions)) return "(no configOptions)";
	return configOptions
		.map((o) => {
			const values = offeredValues(o);
			return `${o.id}=${JSON.stringify(o.currentValue)}${values.length ? ` [${values.slice(0, 20).join(", ")}${values.length > 20 ? ", ..." : ""}]` : ""}`;
		})
		.join("; ");
}

/** Return a list of mismatches between the session's current config and the required profile. Empty means verified. */
export function verifyProfile(configOptions, profile) {
	const mismatches = [];
	for (const [id, expected] of profileSteps(profile)) {
		const option = Array.isArray(configOptions) ? configOptions.find((o) => o?.id === id) : undefined;
		if (!option) mismatches.push(`${id}: missing (expected ${expected})`);
		else if (String(option.currentValue) !== expected) mismatches.push(`${id}: ${JSON.stringify(option.currentValue)} (expected ${expected})`);
	}
	return mismatches;
}

/**
 * Apply the required profile with sequential session/set_config_option calls and verify the final state.
 * Throws ProfileError (fail closed) if an option or value is not offered, a call fails, or the result mismatches.
 */
export async function applyProfile(conn, sessionId, initialConfig, profile, { timeoutMs, signal } = {}) {
	let config = initialConfig;
	for (const [configId, value] of profileSteps(profile)) {
		const option = Array.isArray(config) ? config.find((o) => o?.id === configId) : undefined;
		if (!option) {
			throw new ProfileError(
				`Cursor ACP session does not expose config option "${configId}"; refusing to prompt without the required profile. Is the client sending clientCapabilities._meta.parameterizedModelPicker? Current config: ${summarizeConfig(config)}`,
				{ configId, config },
			);
		}
		const offered = offeredValues(option);
		if (offered.length && !offered.includes(value)) {
			throw new ProfileError(
				`Cursor ACP does not offer ${configId}=${value} (offered: ${offered.join(", ")}); refusing to downgrade.`,
				{ configId, value, offered },
			);
		}
		let result;
		try {
			result = await conn.request("session/set_config_option", { sessionId, configId, value }, { timeoutMs, signal });
		} catch (err) {
			throw new ProfileError(`session/set_config_option ${configId}=${value} failed: ${err.message}`, { configId, value });
		}
		if (!Array.isArray(result?.configOptions)) {
			throw new ProfileError(`session/set_config_option ${configId}=${value} returned no configOptions; cannot verify profile.`, { configId, result });
		}
		config = result.configOptions;
	}
	const mismatches = verifyProfile(config, profile);
	if (mismatches.length) {
		throw new ProfileError(`Cursor profile verification failed: ${mismatches.join("; ")}. Current config: ${summarizeConfig(config)}`, { mismatches });
	}
	return config;
}
