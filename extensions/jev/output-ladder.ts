/**
 * tool_result(bash): query-aware visibility ladder over long command output.
 * Port of plugins/jev/scripts/output_ladder.py.
 *
 * Each chunk of output is shown in full, as a two-line excerpt, or hidden, depending
 * on the current user request. The full output is saved and always recoverable.
 */
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Answer, type ChoiceAnswer, type NoulAnswer, ask, guard, loadConfig, log, mode, stateRead, stateWrite } from "./jevlib.ts";

export const LADDER: Record<string, string> = {
	full: "Directly relevant to `user_request`; the agent needs these exact lines.",
	short: "Possibly useful; a two-line excerpt is enough.",
	hide: "Not needed for `user_request`, e.g. progress bars, boilerplate, unrelated files.",
};

export function chunkLines(lines: string[], cfg: { chunk_lines: number; max_chunks: number }): [number, string[]][] {
	const size = Math.max(cfg.chunk_lines, Math.ceil(lines.length / cfg.max_chunks)); // 块数不超过上限
	const out: [number, string[]][] = [];
	for (let i = 0; i < lines.length; i += size) out.push([i, lines.slice(i, i + size)]);
	return out;
}

export function buildLadderOutput(
	lines: string[],
	chunks: [number, string[]][],
	answers: Record<string, Answer>,
	cfg: { low_confidence: number },
	savedPath: string,
): { text: string; keptChars: number; hidden: string[] } {
	const UP: Record<string, string> = { hide: "short", short: "full", full: "full" };
	const parts: string[] = [];
	const hidden: string[] = [];
	for (const [n, [start, body]] of chunks.entries()) {
		const ans = answers[`c${n}`] as ChoiceAnswer | undefined;
		if (!ans) continue;
		const level = ans.confidence >= cfg.low_confidence ? ans.choice : UP[ans.choice] ?? "full";
		const [a, b] = [start + 1, start + body.length];
		if (level === "full") {
			parts.push(body.join("\n"));
		} else if (level === "short") {
			parts.push(`[jev] lines ${a}-${b} excerpt:\n` + body.slice(0, 2).join("\n") + "\n  ...");
		} else {
			hidden.push(`${a}-${b}`);
		}
	}
	const kept = parts.reduce((s, p) => s + p.length, 0);
	const text =
		parts.join("\n") +
		`\n[jev] ${lines.length} lines total; hidden ranges: ${hidden.join(", ") || "none"}. ` +
		`Full output saved: ${savedPath} — recover with the read tool (offset/limit) or /jev:recall ${savedPath} START END`;
	return { text, keptChars: kept, hidden };
}

/** Extract the complete stdout: pi may have truncated the content, details keep the full file. */
function fullStdout(content: { type: string; text?: string }[], details: any): string {
	const full = details?.fullOutputPath;
	if (full && fs.existsSync(full)) {
		try {
			return fs.readFileSync(full, "utf-8");
		} catch {
			/* fall through to content */
		}
	}
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

export function registerOutputLadder(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		return guard(
			"output_ladder",
			async () => {
				const cfgAll = loadConfig(ctx?.cwd);
				const cfg = cfgAll.ladder;
				const stdout = fullStdout(event.content as any, event.details);
				const lines = stdout.split("\n");
				if (lines.length < cfg.min_lines) return undefined;

				const cwd = ctx?.cwd;
				const chunks = chunkLines(lines, cfg);
				const state = {
					user_request: String(stateRead("last_prompt.txt", "(unknown)", cwd) ?? "(unknown)"),
					command: String((event.input as any).command ?? ""),
					chunks: Object.fromEntries(
						chunks.map(([n, body]) => [`c${n}`, body.join("\n").slice(0, 3000)]),
					),
				};
				const questions: Record<string, any> = Object.fromEntries(
					chunks.map(
						([n]) => [
							`c${n}`,
							{
								type: "choice",
								instructions: `How much of chunk \`c${n}\` in \`chunks\` should the agent see to work on \`user_request\`?`,
								criteria: LADDER,
							},
						],
					),
				);
				questions.has_error = {
					type: "noul",
					instructions: "Any chunk contains an error, failure, or stack trace.",
				};

				let a: Record<string, Answer>;
				try {
					a = await ask("output_ladder", state, questions, cwd);
				} catch (e: any) {
					log({ hook: "output_ladder", mode: "shadow", error: String(e?.message ?? e) }, cwd);
					return undefined;
				}
				if ((a.has_error as NoulAnswer).noul >= 0.5) return undefined; // 有报错时整段原样保留

				const key = event.toolCallId.replace(/\//g, "_");
				const saved = stateWrite(`outputs/${key}.txt`, stdout, cwd);
				const { text, keptChars, hidden } = buildLadderOutput(lines, chunks, a, cfg, saved);
				log(
					{
						hook: "output_ladder",
						mode: mode(cfgAll) === "enforce" ? "enforce" : "shadow",
						lines: lines.length,
						chars_before: stdout.length,
						chars_after: keptChars,
						hidden_ranges: hidden,
					},
					cwd,
				);
				if (mode(cfgAll) !== "enforce") return undefined;
				return { content: [{ type: "text", text }] };
			},
			ctx?.cwd,
		);
	});
}
