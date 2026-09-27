/**
 * tool_call(dispatch_agent): subgoal dedupe, security-aware routing, cost-aware downgrade.
 * Port of plugins/jev/scripts/agent_router.py + agent_done.py.
 *
 * A subagent starts with a fresh, purpose-built context and returns only its final
 * report — exactly the condition under which routing work to a cheaper model pays off.
 *
 * pi's dispatch tool input carries task + role (and model only where the harness
 * supports it), so the downgrade action mutates `input.model` when present and
 * otherwise blocks with guidance.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Answer, type ChoiceAnswer, type ScoreAnswer, ask, ceilLevel, guard, loadConfig, log, mode, projectDir, stateRead, stateWrite } from "./jevlib.ts";

export const DISPATCH_TOOLS = ["dispatch_agent", "dispatch-agent", "agent", "Task", "task"];

export const SENSITIVITY = [
	"Public docs, tests, or open-source dependencies only.",
	"Ordinary application code.",
	"Secrets, .env files, credentials, CI or infrastructure configuration.",
	"Proprietary research code or customer data.",
];

export interface Subgoal {
	text: string;
	status: "running" | "done";
	result?: string;
	model?: string;
}

/** Pure decision: answers in, action out. */
export function routerDecision(
	a: Record<string, Answer>,
	isCheap: boolean,
	cfg: { sensitive_level: number; tier_confidence: number; dedupe_confidence: number },
): { action: "pass" | "deny" | "downgrade"; reason?: string } {
	const tier = a.tier as ChoiceAnswer;
	const level = ceilLevel((a.sensitivity as ScoreAnswer).score); // 期望分向上取整，安全判断宁可保守

	if (a.dup) {
		const dup = a.dup as ChoiceAnswer;
		if (dup.choice !== "new" && dup.confidence >= cfg.dedupe_confidence) {
			return { action: "deny", reason: `__DUP__${dup.choice}` };
		}
	}
	if (isCheap && level >= cfg.sensitive_level) {
		return {
			action: "deny",
			reason:
				`This task touches sensitivity level ${level} data. Do not delegate it to a cheap model; ` +
				"handle it in the main session or a frontier subagent.",
		};
	}
	if (isCheap && tier.choice === "frontier" && tier.confidence >= cfg.tier_confidence) {
		return {
			action: "deny",
			reason:
				"This task needs frontier-level judgment. Use a general-purpose agent instead, " +
				"or split out the mechanical parts first.",
		};
	}
	if (!isCheap && tier.choice === "cheap" && tier.confidence >= cfg.tier_confidence && level < cfg.sensitive_level) {
		return { action: "downgrade", reason: "Jev: mechanical task, running on the cheap model" };
	}
	return { action: "pass" };
}

export function registerAgentRouter(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (!DISPATCH_TOOLS.includes(event.toolName)) return undefined;
		return guard(
			"agent_router",
			async () => {
				const cwd = ctx?.cwd ?? projectDir();
				const cfgAll = loadConfig(cwd);
				const cfg = cfgAll.routing;
				const input = event.input as Record<string, any>;
				const task = String(`${input.description ?? ""}\n${input.task ?? input.prompt ?? ""}`).slice(0, 6000);
				const agent = String(input.subagent_type ?? input.role ?? "general-purpose");
				const registry = (stateRead("subgoals.json", {}, cwd) ?? {}) as Record<string, Subgoal>;
				const recent = Object.fromEntries(Object.entries(registry).slice(-50)); // choice 最多 255 个选项

				const questions: Record<string, any> = {
					tier: {
						type: "choice",
						instructions: "Which model tier can complete `task` reliably from `task` alone?",
						criteria: {
							cheap: "Mechanical or well-specified: renames, lookups, boilerplate, applying a described change, summarizing files.",
							frontier: "Needs design judgment, debugging, ambiguity, or high-stakes changes.",
						},
					},
					sensitivity: {
						type: "score",
						instructions: "How sensitive are the files and data `task` will touch?",
						criteria: SENSITIVITY,
					},
				};
				if (Object.keys(recent).length) {
					questions.dup = {
						type: "choice",
						instructions: "Which existing subgoal already covers `task`, if any?",
						criteria: {
							...Object.fromEntries(
								Object.entries(recent).map(([gid, g]) => [gid, `${g.text.slice(0, 300)} (status: ${g.status})`]),
							),
							new: "None of the existing subgoals already covers this work.",
						},
					};
				}

				let a: Record<string, Answer>;
				try {
					a = await ask("agent_router", { task, requested_agent: agent }, questions, cwd);
				} catch (e: any) {
					log({ hook: "agent_router", mode: "shadow", error: String(e?.message ?? e) }, cwd);
					return undefined;
				}

				const isCheap =
					cfg.cheap_agents.includes(agent) || input.model === cfg.cheap_model;
				const out = routerDecision(a, isCheap, cfg);
				const enforce = mode(cfgAll) === "enforce";

				let result: { block: boolean; reason: string } | undefined;
				if (out.action === "deny") {
					if (out.reason?.startsWith("__DUP__")) {
						const gid = out.reason.slice("__DUP__".length);
						const g = registry[gid];
						result = {
							block: true,
							reason: `Duplicate of subgoal ${gid} (${g?.status}). Reuse its result instead of spawning again: ${g?.result ?? ""}`.slice(0, 500),
						};
					} else {
						result = { block: true, reason: out.reason! };
					}
				} else if (out.action === "downgrade") {
					if ("model" in input) {
						input.model = cfg.cheap_model; // 原地改写，pi 会用改写后的参数执行
					} else if (enforce) {
						result = {
							block: true,
							reason:
								"Jev: mechanical task — this dispatch tool cannot select a cheap model, so handle it " +
								"in the main session with minimal ceremony instead of spawning a subagent.",
						};
					}
				}

				if (!result) {
					registry[event.toolCallId] = { text: task.slice(0, 600), status: "running" };
					stateWrite("subgoals.json", registry, cwd);
				}
				log(
					{
						hook: "agent_router",
						mode: enforce ? "enforce" : "shadow",
						agent,
						tier: (a.tier as ChoiceAnswer).choice,
						level: ceilLevel((a.sensitivity as ScoreAnswer).score),
						action: result ? "deny" : out.action,
						downgraded: out.action === "downgrade" && "model" in input,
					},
					cwd,
				);
				return enforce ? result : undefined;
			},
			ctx?.cwd,
		);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!DISPATCH_TOOLS.includes(event.toolName)) return undefined;
		return guard(
			"agent_done",
			async () => {
				const cwd = ctx?.cwd ?? projectDir();
				const registry = (stateRead("subgoals.json", {}, cwd) ?? {}) as Record<string, Subgoal>;
				const entry = registry[event.toolCallId];
				if (!entry) return undefined;
				const text = (event.content as any[])
					.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join(" ");
				entry.status = event.isError ? "running" : "done";
				entry.result = text.slice(0, 600);
				stateWrite("subgoals.json", registry, cwd);
				log({ hook: "agent_done", mode: "shadow", subgoal: event.toolCallId, status: entry.status }, cwd);
				return undefined;
			},
			ctx?.cwd,
		);
	});
}
