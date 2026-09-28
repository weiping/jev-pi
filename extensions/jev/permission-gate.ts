/**
 * tool_call(bash): hard rules in code, fuzzy judgment from Jev, thresholds in config.
 * Port of plugins/jev/scripts/permission_gate.py.
 *
 * pi semantics: return undefined = proceed; {block: true, reason} = blocked.
 * The Claude Code "ask" decision becomes a ctx.ui.confirm dialog when a UI exists.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Answer, type ChoiceAnswer, type NoulAnswer, ask, guard, log, mode, resolve, stateRead } from "./jevlib.ts";

const SCRIPT_RUNNERS = new Set(["python", "python3", "bash", "sh", "node", "ruby"]);

/** Split a command line on whitespace, respecting single and double quotes. */
export function tokenize(cmd: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: string | null = null;
	for (const ch of cmd.trim()) {
		if (quote) {
			if (ch === quote) quote = null;
			else cur += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
		} else if (/\s/.test(ch)) {
			if (cur) out.push(cur);
			cur = "";
		} else cur += ch;
	}
	if (cur) out.push(cur);
	return out;
}

export function isSimpleReadonly(cmd: string, readonlyCommands: string[]): boolean {
	if (/[;&|<>`$()]/.test(cmd)) return false; // 复合命令、重定向、替换一律交给后面判断
	return readonlyCommands.some((p) => cmd === p || cmd.startsWith(p + " "));
}

/** Deeper inspection: read the script a command is about to run, not just its name. */
export function scriptText(cmd: string, cwd: string): string {
	const argv = tokenize(cmd);
	if (argv.length >= 2 && SCRIPT_RUNNERS.has(path.basename(argv[0]))) {
		const p = path.resolve(cwd, argv[1]);
		try {
			if (fs.statSync(p).isFile()) {
				return fs.readFileSync(p, "utf-8").slice(0, 4000);
			}
		} catch {
			/* not a readable file */
		}
	}
	return "";
}

export function gateQuestions() {
	return {
		decision: {
			type: "choice" as const,
			instructions: "Should the coding agent run `command` for `user_request` without asking the user?",
			criteria: {
				allow: "Routine, clearly serves the request, stays inside repo_root, easy to undo.",
				ask: "Plausible for the request but risky, hard to undo, or reaches outside repo_root.",
				deny: "Unrelated to the request, destructive, or touches secrets or credentials.",
			},
		},
		egress: {
			type: "noul" as const,
			instructions:
				"`command` or `script` sends data to, or downloads from, a host outside this machine.",
		},
		network_requested: {
			type: "noul" as const,
			instructions:
				"`user_request` explicitly asks for network access, installing packages, or deploying.",
		},
	};
}

/** Pure decision: answers in, allow/ask/deny + reason out. */
export function gateDecision(
	a: Record<string, Answer>,
	cfg: { egress_threshold: number; deny_confidence: number; allow_confidence: number },
): { kind: "allow" | "ask" | "deny"; reason: string } {
	const d = a.decision as ChoiceAnswer;
	const egress = a.egress as NoulAnswer;
	const network = a.network_requested as NoulAnswer;
	if (egress.noul > cfg.egress_threshold && network.noul < 0.5) {
		return {
			kind: "deny",
			reason:
				"The command appears to reach the network, but the user did not ask for network access. Ask the user before retrying.",
		};
	}
	if (d.choice === "deny" && d.confidence >= cfg.deny_confidence) {
		return {
			kind: "deny",
			reason:
				"Jev judged this command unrelated to the request or destructive. Explain the intent to the user before retrying.",
		};
	}
	if (d.choice === "allow" && d.confidence >= cfg.allow_confidence) {
		return { kind: "allow", reason: `Jev: allow (${d.confidence.toFixed(2)})` };
	}
	return { kind: "ask", reason: `Jev: ${d.choice} (${d.confidence.toFixed(2)}), confirmation needed` };
}

export function registerPermissionGate(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		return guard(
			"permission_gate",
			async () => {
				// 这次 Bash 调用发生在哪个目录下，就用哪个 `.pi/jev/`（见 jevlib.resolve 的说明）
				const r = resolve(ctx?.cwd);
				const cfg = r.cfg.permission;
				const cmd = String((event.input as any).command ?? "");
				const cwd = ctx?.cwd ?? r.project;
				const enforce = mode(r.cfg) === "enforce";

				// 1. 确定的规则，代码说了算
				for (const pat of [...cfg.deny_patterns, ...(cfg.extra_deny_patterns ?? [])]) {
					if (new RegExp(pat).test(cmd)) {
						log({ hook: "permission_gate", command: cmd, action: "deny", by: "rule", rule: pat }, r.logs, r.cfg);
						return enforce
							? { block: true, reason: `Blocked by project rule: command matches \`${pat}\`.` }
							: undefined;
					}
				}
				if (isSimpleReadonly(cmd, cfg.readonly_commands)) return undefined;

				// 2. 模糊判断，一次请求并行问完
				const state = {
					user_request: stateRead("last_prompt.txt", "(unknown)", r.state) || "(unknown)",
					command: cmd,
					cwd,
					repo_root: r.project,
					script: scriptText(cmd, cwd) || "(no script file)",
				};
				let a: Record<string, Answer>;
				try {
					a = await ask("permission_gate", state, gateQuestions(), { cfg: r.cfg, logs: r.logs });
				} catch (e: any) {
					// Jev 不可用时不做决定，放行到 pi 自己的流程
					log({ hook: "permission_gate", command: cmd, error: String(e?.message ?? e) }, r.logs, r.cfg);
					return undefined;
				}

				const out = gateDecision(a, cfg);
				log({ hook: "permission_gate", command: cmd, action: out.kind, by: "jev" }, r.logs, r.cfg);
				if (!enforce) return undefined;

				if (out.kind === "deny") return { block: true, reason: out.reason };
				if (out.kind === "allow") return undefined;
				// ask: hand the decision to the user when a UI exists; block otherwise
				if (ctx?.hasUI) {
					const yes = await ctx.ui.confirm("Jev permission gate", `${out.reason}\n\n  ${cmd}\n\nAllow?`);
					return yes ? undefined : { block: true, reason: "Blocked by user" };
				}
				return { block: true, reason: out.reason };
			},
		);
	});
}
