/**
 * Slash commands and the jev_ask tool.
 * Ports of plugins/jev/skills/{init,stats,snapshot,recall} and scripts/{stats,snapshot,recall,jev_ask}.py.
 *
 * - /jev:init scans the repo through the agent (judgment work) and writes .pi/jev/ files.
 * - /jev:stats and /jev:snapshot compute mechanically, then hand the summary to the agent.
 * - /jev:recall prints saved ladder output for the human; the model recovers via the read tool.
 * - The jev_ask tool lets the model ask Jev bounded choice/score/yes-no questions on demand.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { JEV_DIR, type Question, ask, guard, jevProjects, loadConfig, mode, project, stateWrite } from "./jevlib.ts";

const INIT_INSTRUCTIONS = `Set up the Jev extension for this project. Work only inside \`.pi/jev/\` in the project root; do not touch application code.

1. Scan the repository for:
   - documentation and per-directory gotcha files (for example \`docs/*.md\`, \`*/GOTCHAS.md\`, \`CONTRIBUTING.md\`, style guides);
   - project tools: \`Makefile\` targets, \`package.json\` scripts, \`pyproject.toml\` scripts, executables under \`scripts/\`, \`tools/\` or \`bin/\`;
   - sensitive paths: secrets, credentials, infrastructure and deployment configuration.
2. Write \`.pi/jev/rules.json\`, a JSON array. Each rule has an \`id\`, a \`load\` path relative to the project root, and exactly one condition:
   - \`when_files\`: glob patterns matched against changed files (use this whenever a path decides relevance), or
   - \`when_jev\`: one factual sentence describing requests the file matters for.
   Only reference files that exist. If useful guidance files are missing, list suggestions for me instead of writing their content.
3. Write \`.pi/jev/tools.json\`, an object mapping a short tool id to \`{"what": "<one line>", "how": "<exact command or --help>"}\`. Mark destructive tools in \`how\`. The last entry must be \`"none": {"what": "None of the project tools is relevant to this request.", "how": ""}\`.
4. Write \`.pi/jev/config.json\` with only the overrides this project needs. Keep \`"mode": "shadow"\`. Put project-specific sensitive path regexes in \`"permission": {"extra_deny_patterns": [...]}\` and make sure they do not match example files such as \`.env.example\`.
5. Show me the three files and a short summary. Remind me that decisions are only logged until I set \`"mode": "enforce"\`, and that \`/jev:stats\` shows what has been logged.`;

/** One project's summary; empty string if it has no log yet. */
export function summarizeProject(root: string): string {
	const file = path.join(root, JEV_DIR, "logs", "decisions.jsonl");
	if (!fs.existsSync(file)) return "";
	const rows = fs
		.readFileSync(file, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	const calls = rows.filter((r) => "latency_ms" in r);
	const byHook = new Map<string, typeof calls>();
	for (const r of calls) {
		const list = byHook.get(r.hook) ?? [];
		list.push(r);
		byHook.set(r.hook, list);
	}
	const tokens = calls.reduce((s, r) => s + (r.input_tokens ?? 0), 0);
	const lines: string[] = [
		`Jev calls: ${calls.length}   input tokens: ${tokens}   est. cost: $${((tokens * 0.042) / 1e6).toFixed(4)}`,
	];
	const models = new Map<string, number>();
	for (const r of calls) models.set(r.model, (models.get(r.model) ?? 0) + 1);
	lines.push(`models: ${JSON.stringify(Object.fromEntries(models))}`);
	for (const [hook, rs] of [...byHook].sort()) {
		const lat = rs.map((r) => r.latency_ms as number).sort((a, b) => a - b);
		const median = lat[Math.floor(lat.length / 2)];
		const p90 = lat[Math.max(0, Math.ceil(lat.length * 0.9) - 1)];
		lines.push(`- ${hook}: ${rs.length} calls, median ${Math.round(median)} ms, p90 ${Math.round(p90)} ms`);
	}
	const acts = new Map<string, number>();
	for (const r of rows) if (r.action) acts.set(`${r.hook} -> ${r.action}`, (acts.get(`${r.hook} -> ${r.action}`) ?? 0) + 1);
	for (const [k, n] of [...acts].sort()) lines.push(`  ${k}: ${n}`);
	const lad = rows.filter((r) => r.hook === "output_ladder" && "chars_before" in r);
	if (lad.length) {
		const b = lad.reduce((s, r) => s + r.chars_before, 0);
		const a = lad.reduce((s, r) => s + r.chars_after, 0);
		lines.push(`output_ladder: ${b} -> ${a} chars (${b ? Math.round((1 - a / b) * 100) : 0}% hidden, recoverable)`);
	}
	const errors = rows.filter((r) => "error" in r).length;
	lines.push(`errors: ${errors}  mode now: ${rows[rows.length - 1]?.mode ?? "shadow"}`);
	return lines.join("\n");
}

/**
 * Port of stats.py (v0.2.1): summarize every jev project's own decisions.jsonl in one
 * place — hooks resolve to a sibling's own logs when a command or dispatch runs inside
 * it, so a single session-root summary would silently miss all of that activity.
 * A workspace with no siblings prints exactly what it always did.
 */
export function statsText(): string {
	const projects = jevProjects();
	const blocks = projects.map((root) => {
		const text = summarizeProject(root);
		return projects.length === 1 ? text : `== ${root} (${root === projects[0] ? "session root" : "sibling"}) ==\n${text || "No Jev decisions logged yet."}`;
	}).filter(Boolean);
	if (!blocks.length) return "No Jev decisions logged yet.";
	return blocks.join("\n\n");
}

function git(args: string[], cwd: string): string {
	return spawnSync("git", args, { cwd, encoding: "utf-8" }).stdout ?? "";
}

/** Port of snapshot.py: rank changed files once, write one shared snapshot. */
export async function buildSnapshot(base: string, cwd: string): Promise<{ written: string; summary: string }> {
	const files = git(["diff", "--name-only", base], cwd).split(/\s+/).filter(Boolean);
	const diff = git(["diff", base], cwd);
	if (!files.length) throw new Error(`No changes against ${base}.`);
	const questions: Record<string, Question> = Object.fromEntries(
		files.slice(0, 100).map((f, i) => [
			`f${i}`,
			{
				type: "score" as const,
				instructions: `How important is it for a reviewer of \`diff\` to read file \`${f}\` in full?`,
				criteria: ["Not needed", "Skim the diff hunk only", "Read the whole file"],
			},
		]),
	);
	const answers = await ask("snapshot", { diff: diff.slice(0, 60000) }, questions, { logs: path.join(project(), JEV_DIR, "logs") });
	const scores = files
		.slice(0, 100)
		.map((f, i) => ({ f, score: (answers[`f${i}`] as { score: number }).score }))
		.sort((x, y) => y.score - x.score);
	const out = [
		`# Change snapshot against ${base}`,
		"",
		"## Files by review priority",
		"",
		...scores.map((s) => `- ${s.f} (score ${s.score.toFixed(2)})`),
		"",
		"## Diff",
		"",
		"```diff",
		diff.slice(0, 60000),
		"```",
	].join("\n");
	const written = stateWrite("snapshot.md", out, cwd);
	return { written, summary: `${files.length} files. Top: ${scores.slice(0, 5).map((s) => s.f).join(", ")}` };
}

/** Port of recall.py: numbered lines START..END (1-based, inclusive). */
export function recallText(file: string, start = 1, end = Infinity): string {
	const all = fs.readFileSync(file, "utf-8").split("\n");
	if (all.length && all[all.length - 1] === "") all.pop(); // trailing newline
	return all
		.slice(start - 1, Math.min(end, all.length))
		.map((l, i) => `${String(start + i).padStart(6)}  ${l}`)
		.join("\n");
}

export async function registerCommands(pi: ExtensionAPI): Promise<void> {
	const { Type } = await import("typebox");
	pi.registerCommand("jev:init", {
		description: "Set up Jev for this project: generate .pi/jev/rules.json, tools.json and config.json",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Jev: scanning the repository — see the follow-up prompt", "info");
			pi.sendUserMessage(INIT_INSTRUCTIONS);
		},
	});

	pi.registerCommand("jev:stats", {
		description: "Show how the Jev extension has behaved (calls, latency, decisions, output savings)",
		handler: async (_args) => {
			const text = statsText();
			pi.sendUserMessage(
				`Current Jev decision log summary:\n\n${text}\n\nSummarize this for me in a few sentences. ` +
					"Point out anything that suggests a threshold in .pi/jev/config.json should change, for example " +
					"many ask decisions from the permission gate, or errors. Do not change the config yourself.",
			);
		},
	});

	pi.registerCommand("jev:snapshot", {
		description: "Build one shared change snapshot, then run read-only reviewers in parallel on it",
		handler: async (args, ctx) => {
			const base = args.trim() || "HEAD";
			const cwd = ctx.cwd ?? project();
			try {
				const { written, summary } = await buildSnapshot(base, cwd);
				ctx.ui.notify(`Snapshot: ${summary}`, "info");
				pi.sendUserMessage(
					`The snapshot is written to ${written} (${summary}). It is shared retrieval: the diff and the ` +
						"files worth reading have been found once. Now launch three read-only reviewer subagents " +
						"in parallel (dispatch_agent), one each for security, tests, and documentation. Give each " +
						"one its angle and tell it to read the snapshot first instead of repeating the search. " +
						"When all three report back, merge their findings into one list ordered by severity.",
				);
			} catch (e: any) {
				ctx.ui.notify(`Jev snapshot failed: ${e?.message ?? e}`, "error");
			}
		},
	});

	pi.registerCommand("jev:recall", {
		description: "Print lines START..END of a Bash output saved by the output ladder",
		handler: async (args, ctx) => {
			const [file, start, end] = args.trim().split(/\s+/);
			if (!file) {
				ctx.ui.notify("Usage: /jev:recall <saved-file> [start] [end]", "error");
				return;
			}
			try {
				const text = recallText(file, Number(start) || 1, Number(end) || Infinity);
				ctx.ui.notify(text.length > 2000 ? text.slice(0, 2000) + "\n  ..." : text, "info");
			} catch (e: any) {
				ctx.ui.notify(`Jev recall failed: ${e?.message ?? e}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "jev_ask",
		label: "Jev",
		description:
			"Ask Jev (TypeSafe System One) bounded judgment questions: one choice (pick from options), " +
			"score (position on ordered levels), or noul (probability a statement is true). Use for decisions " +
			"with a known set of answers, such as ranking candidates or checking a claim against evidence. " +
			"Never use for arithmetic, counting, or exact string checks.",
		parameters: Type.Object({
			state: Type.Any({ description: "Context the questions are evaluated against: text and/or named JSON fields" }),
			questions: Type.Any({
				description:
					'Map of question id -> question object, e.g. {"supported": {"type":"noul","instructions":"`evidence` supports `claim`."},' +
					' "best": {"type":"choice","instructions":"...","criteria":{"a":"...","b":"..."}}}',
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate) {
			return guard(
				"jev_ask",
				async () => {
					const answers = await ask("jev_ask", params.state, params.questions as Record<string, Question>);
					return {
						content: [{ type: "text" as const, text: JSON.stringify(answers, null, 2) }],
						details: { answers },
					};
				},
			).then((r) => {
				if (r && typeof r === "object" && "content" in (r as any)) return r as any;
				throw new Error("jev_ask failed — see .pi/jev/logs/decisions.jsonl");
			});
		},
	});
}

export function statusLine(): string {
	const cfg = loadConfig();
	const key = process.env.TYPESAFE_API_KEY || process.env.JEV_MOCK ? "" : " (no API key)";
	return `jev: ${mode(cfg)}${key} · ${path.join(project(), JEV_DIR)}`;
}
