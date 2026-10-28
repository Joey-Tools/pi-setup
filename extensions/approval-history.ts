import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { ApprovalStore, APPROVALS_USAGE, approvalsCommand, configFromEnv } from "../lib/index.mjs";

// User-initiated only: a slash command, never a tool, so the model cannot read or change rules through it.
export default function approvalHistory(pi: ExtensionAPI) {
	pi.registerCommand("approvals", {
		description: `Review Cursor permission decisions and manage exact allow/block rules (${APPROVALS_USAGE})`,
		handler: async (args, ctx) => {
			let store: ApprovalStore;
			try {
				const config = configFromEnv(process.env, { agentDir: getAgentDir() });
				store = new ApprovalStore({ stateDir: config.stateDir, projectCwd: ctx.cwd });
			} catch (err) {
				ctx.ui.notify(`approvals: ${(err as Error).message}`, "error");
				return;
			}
			await approvalsCommand(args, ctx, { store });
		},
	});
}
