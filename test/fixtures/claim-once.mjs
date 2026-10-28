// Separate-process once-rule claim, for the cross-process atomicity test: prints "won" or "lost".
import { ApprovalStore } from "../../lib/index.mjs";

const [stateDir, projectCwd, ruleJson, decisionId] = process.argv.slice(2);
const store = new ApprovalStore({ stateDir, projectCwd });
process.stdout.write((await store.claimOnce(JSON.parse(ruleJson), decisionId)) ? "won" : "lost");
