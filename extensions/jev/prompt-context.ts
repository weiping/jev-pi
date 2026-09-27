/**
 * Conditional project context: remember the request, load relevant guidance,
 * suggest project tools. Port of plugins/jev/scripts/prompt_context.py +
 * session_context.py.
 *
 * - pi.on("input") records the current user request to state (other handlers
 *   use it as the "current query").
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
	loadConfig,
	log,
	mode,
	piJev,
	projectDir,
	projectFile,
	stateWrite,
} from "./jevlib.ts";

export const SECTION_TAG = "jev-project-context";

export function touchedFiles(cwd: string): string[] {
	const cmds = [
		["diff", "--name-only", "HEAD"],
		["ls-files", "--others", "--exclude-standard"],
	];
	const files: string[] = [];
	for (const args of cmds) {
		const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
		files.push(...r.stdout.split(/\s+/).filter(Boolean));
	}
	return [...new Set(files)];
}

export interface Rule {
	id: string;
	load: string;
	when_files?: string[];
	when_jev?: string;
}

/** Pure composition: rules + tool answers in, context string out. */
export function buildContext(
	rules: Rule[],
	tools: Record<string, { what: string; how: string }>,
	files: string[],
	answers: Record<string, Answer> | null,
	loadedByGlob: Rule[],
	cfg: { rule_threshold: number; tool_top_k: number; tool_min_prob: number; max_chars: number },
	project: string,
): string {
	const loaded = [...loadedByGlob];
	if (answers) {
		for (const r of rules) {
			if (r.when_jev) {
				const ans = answers[`rule_${r.id}`] as NoulAnswer | undefined;
				if (ans && ans.noul >= cfg.rule_threshold) loaded.push(r);
			}
		}
	}
	let picked: string[] = [];
	if (answers && answers.tool) {
		const probs = (answers.tool as ChoiceAnswer).probabilities;
		picked = [...Object.keys(probs)]
			.sort((x, y) => probs[y] - probs[x])
			.slice(0, cfg.tool_top_k)
			.filter((k) => k in tools && k !== "none" && probs[k] >= cfg.tool_min_prob);
	}

	const blocks: string[] = [];
	for (const r of loaded) {
		const p = path.join(project, r.load);
		if (fs.existsSync(p)) {
			blocks.push(`Project guidance from ${r.load} applies to this request:\n` + fs.readFileSync(p, "utf-8"));
		}
	}
	if (picked.length) {
		blocks.push(
			"Project tools relevant to this request (read the help before use):\n" +
				picked.map((k) => `- ${k}: ${tools[k]?.what ?? k} Usage: ${tools[k]?.how ?? ""}`).join("\n"),
		);
	}
	return blocks.join("\n\n").slice(0, cfg.max_chars);
}

export function registerPromptContext(pi: ExtensionAPI): void {
	pi.on("input", (event) => {
		// Record the current request; never transform it.
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
		return guard(
			"prompt_context",
			async () => {
				const cwd = ctx?.cwd ?? projectDir();
				const cfgAll = loadConfig(cwd);
				const rules = projectFile("rules.json", [], cwd) as Rule[];
				const tools = projectFile("tools.json", {}, cwd);
				if (!rules.length && !tools) return undefined; // 还没运行 /jev:init，不花一次调用
				const files = touchedFiles(cwd);

				const loadedByGlob = rules.filter(
					(r) =>
						r.when_files &&
						files.some((f) => r.when_files!.some((g) => globMatch(g, f))),
				);

				const questions: Record<string, any> = {};
				for (const r of rules) if (r.when_jev) questions[`rule_${r.id}`] = { type: "noul", instructions: r.when_jev };
				if (tools && Object.keys(tools).length) {
					questions.tool = {
						type: "choice",
						instructions: "Which project tool, if any, helps with `user_request`?",
						criteria: Object.fromEntries(Object.entries(tools).map(([k, v]: any) => [k, v.what])),
					};
				}

				let answers: Record<string, Answer> | null = null;
				if (Object.keys(questions).length) {
					try {
						answers = await ask("prompt_context", { user_request: event.prompt, changed_files: files.slice(0, 200) }, questions, cwd);
					} catch (e: any) {
						log({ hook: "prompt_context", mode: "shadow", error: String(e?.message ?? e) }, cwd);
					}
				}

				const context = buildContext(rules, tools, files, answers, loadedByGlob, cfgAll.context, projectDir(cwd));
				stateWrite("pinned_context.md", context, cwd);
				log(
					{
						hook: "prompt_context",
						mode: mode(cfgAll) === "enforce" ? "enforce" : "shadow",
						rules: loadedByGlob.map((r) => r.id),
						tools: (answers?.tool as ChoiceAnswer | undefined)?.choice ?? [],
						chars: context.length,
					},
					cwd,
				);
				if (!context || mode(cfgAll) !== "enforce") return undefined;

				// In-place section update; pi records the delta and matches later updates by tag.
				event.systemPromptOptions.sections[SECTION_TAG] = context;
				return undefined;
			},
			ctx?.cwd,
		);
	});

	// Re-injection after compaction is inherent: sections are re-sent with every
	// request and before_agent_start refreshes them from pinned_context state.
	pi.on("session_compact", (_event, ctx) => {
		log({ hook: "session_compact", mode: mode(loadConfig(ctx?.cwd)), note: "pinned context re-injects on next request" }, ctx?.cwd);
		return undefined;
	});
}

/** fnmatch-style glob: * and ? wildcards, * does not cross "/" unless pattern has no "/". */
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
