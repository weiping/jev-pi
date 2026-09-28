/**
 * Assembly smoke: load the extension factory the way pi would and assert every
 * command, tool, and event handler is registered. No LLM, no API key, no pi binary —
 * safe for CI. Run: npm run smoke
 */

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean) {
	if (cond) passed++;
	else failures.push(name);
}

const commands: string[] = [];
const tools: string[] = [];
const events: string[] = [];
const shortcuts: string[] = [];

const fakePi: any = {
	on: (evt: string) => void events.push(evt),
	registerCommand: (name: string) => void commands.push(name),
	registerTool: (t: { name: string }) => void tools.push(t.name),
	registerShortcut: (k: string) => void shortcuts.push(k),
	sendUserMessage: () => {},
};

const mod = await import("../extensions/jev/index.ts");
check("factory is an async function", typeof mod.default === "function");
await mod.default(fakePi);

check("command /jev:init", commands.includes("jev:init"));
check("command /jev:stats", commands.includes("jev:stats"));
check("command /jev:snapshot", commands.includes("jev:snapshot"));
check("command /jev:recall", commands.includes("jev:recall"));
check("tool jev_ask registered", tools.includes("jev_ask"));
check("event tool_call (gate + router)", events.filter((e) => e === "tool_call").length === 2);
check("event tool_result (ladder + agent_done)", events.filter((e) => e === "tool_result").length === 2);
check("event input (last_prompt)", events.includes("input"));
check("event before_agent_start (context injection)", events.includes("before_agent_start"));
check("event session_compact (re-injection note)", events.includes("session_compact"));
check("event session_start (status line)", events.includes("session_start"));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
	for (const f of failures) console.error(`FAIL ${f}`);
	process.exit(1);
}
