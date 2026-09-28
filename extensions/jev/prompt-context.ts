/**
 * Conditional project context: remember the request, load relevant guidance,
 * suggest project tools. Port of plugins/jev/scripts/prompt_context.py (v0.2
 * meta-workspace semantics, synced from jev-claude-code 197272b) +
 * session_context.py.
 *
 * Meta-workspace support: besides the session's own project root, this also looks one
 * level down for sibling directories that carry their own `.pi/jev/` — a repo living
 * inside a meta-workspace root that is not itself part of that root's git tree. Each
 * such sibling is treated as its own Jev project: its own `git diff` scope, its own
 * rules.json/tools.json, `load` paths resolved relative to its own directory. One
 * level deep only. The session's own project root is always project index 0 with
 * unprefixed question ids, so a workspace with no siblings behaves exactly as before.
 *
 * - pi.on("input") records the current user request to session-root state.
 * - pi.on("before_agent_start") computes the context and injects it as a
 *   system-prompt section. Sections are re-sent every request, so re-injection
 *   after compaction is inherent — the pinned context survives /compact.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type Answer,
	type ChoiceAnswer,
	type NoulAnswer,
	ask,
	guard,
	jevProjects,
	loadConfig,
	log,
	mode,
	projectFile,
	resolve,
	stateWrite,
} from "./jevlib.ts";

export const SECTION_TAG = "jev-project-context";

export interface Rule {
	id: string;
	load: string;
	when_files?: string[];
	when_jev?: string;
}

export interface ProjectEntry {
	root: string;
	projectJev: string;
	rules: Rule[];
	tools: Record<string, { what: string; how: string }>;
	files: string[];
}

export function touchedFiles(root: string): string[] {
	const cmds = [
		["diff", "--name-only", "HEAD"],
		["ls-files", "--others", "--exclude-standard"],
	];
	const files: string[] = [];
	for (const args of cmds) {
		const r = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
		files.push(...r.stdout.split(/\s+/).filter(Boolean));
	}
	return [...new Set(files)];
}

/** Each jev project that has rules or tools, with its own changed-file scope. */
export function collectProjects(roots: string[]): ProjectEntry[] {
	const projects: ProjectEntry[] = [];
	for (const root of roots) {
		const projectJev = path.join(root, ".pi", "jev");
		const rules = projectFile("rules.json", projectJev, []) as Rule[];
		const tools = projectFile("tools.json", projectJev, {});
		if (rules.length || Object.keys(tools).length) {
			projects.push({ root, projectJev, rules, tools, files: touchedFiles(root) });
		}
	}
	return projects;
}

export interface Plan {
	questions: Record<string, any>;
	askState: Record<string, unknown>;
	/** Glob-matched rules that load without asking Jev: [(root, rule)]. */
	preloaded: [string, Rule][];
	/** "{i}:{tid}" (or plain tid for project 0) -> [root, tid, tool]. */
	toolLookup: Map<string, [string, string, { what: string; how: string }]>;
	toolCriteria: Record<string, string>;
}

/** Build the single merged Jev request across all projects, with per-project id namespacing. */
export function planQuestions(prompt: string, projects: ProjectEntry[]): Plan {
	const questions: Record<string, any> = {};
	const askState: Record<string, unknown> = { user_request: prompt };
	const preloaded: [string, Rule][] = [];
	const toolCriteria: Record<string, string> = {};
	const toolLookup = new Map<string, [string, string, { what: string; how: string }]>();
	let noneText: string | undefined;

	projects.forEach((p, i) => {
		const tag = i === 0 ? "" : `s${i}_`; // 会话根不加前缀，跟单项目时的问题 id 完全一致
		for (const rule of p.rules) {
			if (rule.when_files && p.files.some((f) => rule.when_files!.some((g) => globMatch(g, f)))) {
				preloaded.push([p.root, rule]);
			}
			if (rule.when_jev) questions[`rule_${tag}${rule.id}`] = { type: "noul", instructions: rule.when_jev };
		}
		askState[`changed_files${i === 0 ? "" : `_${i}`}`] = p.files.slice(0, 200);
		for (const [tid, tool] of Object.entries(p.tools)) {
			if (tid === "none") {
				if (noneText === undefined) noneText = tool.what;
				continue;
			}
			const key = i === 0 ? tid : `s${i}:${tid}`;
			toolCriteria[key] = tool.what;
			toolLookup.set(key, [p.root, tid, tool]);
		}
	});
	if (Object.keys(toolCriteria).length) {
		toolCriteria.none = noneText || "None of the project tools is relevant to this request.";
		questions.tool = {
			type: "choice",
			instructions: "Which project tool, if any, helps with `user_request`?",
			criteria: toolCriteria,
		};
	}
	return { questions, askState, preloaded, toolLookup, toolCriteria };
}

/** Pure composition: Jev answers in, context string out. */
export function composeContext(
	projects: ProjectEntry[],
	plan: Plan,
	answers: Record<string, Answer> | null,
	cfg: { rule_threshold: number; tool_top_k: number; tool_min_prob: number; max_chars: number },
): string {
	const loaded: [string, Rule][] = [...plan.preloaded];
	if (answers) {
		projects.forEach((p, i) => {
			const tag = i === 0 ? "" : `s${i}_`;
			for (const rule of p.rules) {
				if (!rule.when_jev) continue;
				const ans = answers[`rule_${tag}${rule.id}`] as NoulAnswer | undefined;
				if (ans && ans.noul >= cfg.rule_threshold) loaded.push([p.root, rule]);
			}
		});
	}
	let picked: string[] = [];
	if (answers && answers.tool) {
		const probs = (answers.tool as ChoiceAnswer).probabilities;
		picked = [...Object.keys(probs)]
			.sort((x, y) => probs[y] - probs[x])
			.slice(0, cfg.tool_top_k)
			.filter((k) => k in plan.toolCriteria && k !== "none" && probs[k] >= cfg.tool_min_prob);
	}

	const blocks: string[] = [];
	for (const [root, rule] of loaded) {
		const p = path.join(root, rule.load);
		if (fs.existsSync(p)) {
			blocks.push(`Project guidance from ${rule.load} applies to this request:\n` + fs.readFileSync(p, "utf-8"));
		}
	}
	if (picked.length) {
		const lines = picked.map((k) => {
			const [_root, tid, tool] = plan.toolLookup.get(k)!;
			return `- ${tid}: ${tool.what} Usage: ${tool.how}`;
		});
		blocks.push("Project tools relevant to this request (read the help before use):\n" + lines.join("\n"));
	}
	return blocks.join("\n\n").slice(0, cfg.max_chars);
}

export function registerPromptContext(pi: ExtensionAPI): void {
	pi.on("input", (event) => {
		// Record the current request into the session root; never transform it.
		if (event.text) {
			try {
				stateWrite("last_prompt.txt", event.text);
			} catch {
				/* state unavailable; other handlers fall back to (unknown) */
			}
		}
		return undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		return guard("prompt_context", async () => {
			const cfg = loadConfig().context; // 会话根配置决定 context 行为
			const projects = collectProjects(jevProjects());
			if (!projects.length) return undefined; // 还没运行 /jev:init，不花一次调用

			const plan = planQuestions(event.prompt, projects);
			let answers: Record<string, Answer> | null = null;
			if (Object.keys(plan.questions).length) {
				try {
					answers = await ask("prompt_context", plan.askState, plan.questions);
				} catch (e: any) {
					log({ hook: "prompt_context", error: String(e?.message ?? e) });
				}
			}

			const context = composeContext(projects, plan, answers, cfg);
			stateWrite("pinned_context.md", context); // 固定在会话根，compaction 后重注入
			log({
				hook: "prompt_context",
				rules: plan.preloaded.map(([, rule]) => rule.id),
				tools: (answers?.tool as ChoiceAnswer | undefined)?.choice ?? [],
				chars: context.length,
				projects: projects.map((p) => p.root),
			});
			if (!context || mode() !== "enforce") return undefined;

			// In-place section update; pi records the delta and matches later updates by tag.
			event.systemPromptOptions.sections[SECTION_TAG] = context;
			return undefined;
		});
	});

	// Re-injection after compaction is inherent: sections are re-sent with every
	// request and before_agent_start refreshes them from pinned_context state.
	pi.on("session_compact", (_event, _ctx) => {
		log({ hook: "session_compact", note: "pinned context re-injects on next request" });
		return undefined;
	});
}

/** fnmatch-style glob: `*` and `?` wildcards; `*` stays within one path segment unless the pattern uses a double-star prefix. */
export function globMatch(pattern: string, file: string): boolean {
	const re = new RegExp(
		"^" +
			pattern
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/\?/g, "[^/]")
				.replace(/\*\*\/|\*/g, (m) => (m === "**/" ? "(?:.*/)?.*" : "[^/]*")) +
			"$",
	);
	return re.test(file);
}

// resolve is re-exported for command handlers that need the same per-invocation semantics
export { resolve };
