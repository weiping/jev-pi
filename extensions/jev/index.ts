/**
 * Jev for pi — TypeSafe System One judgments in the agent loop.
 *
 * Port of the jev-claude-code plugin to pi mechanisms:
 * - permission gate  : tool_call(bash)  — hard rules in code, fuzzy judgment from Jev
 * - output ladder    : tool_result(bash) — query-aware visibility over long output
 * - conditional ctx  : input + before_agent_start — relevant guidance and project tools
 * - agent router     : tool_call(dispatch_agent) — dedupe, sensitivity, cost-aware downgrade
 * - commands/tool    : /jev:init /jev:stats /jev:snapshot /jev:recall + jev_ask
 *
 * Everything runs in shadow mode by default: Jev is called and every decision is
 * logged, but pi's behavior does not change until mode is switched to enforce
 * (.pi/jev/config.json or JEV_MODE=enforce).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentRouter } from "./agent-router.ts";
import { registerCommands, statusLine } from "./commands.ts";
import { loadConfig, mode } from "./jevlib.ts";
import { registerOutputLadder } from "./output-ladder.ts";
import { registerPermissionGate } from "./permission-gate.ts";
import { registerPromptContext } from "./prompt-context.ts";

export default async function jevExtension(pi: ExtensionAPI) {
	registerPermissionGate(pi);
	registerOutputLadder(pi);
	registerPromptContext(pi);
	registerAgentRouter(pi);
	await registerCommands(pi);

	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus("jev", statusLine(ctx.cwd));
		}
		return undefined;
	});

	pi.on("session_shutdown", () => undefined);
}

export { mode, loadConfig };
