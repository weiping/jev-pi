/**
 * Shared helpers for the Jev pi extension: paths, config, client, mock transport,
 * logging, state. Port of plugins/jev/scripts/jevlib.py.
 *
 * Path model (v0.2 semantics, synced from jev-claude-code 197272b):
 * - `project()` is the SESSION root: the git toplevel of pi's working directory.
 *   It is resolved once and never changes, mirroring CLAUDE_PROJECT_DIR.
 * - `resolve(hint)` re-resolves the NEAREST `.pi/jev/` for a single hook invocation,
 *   walking up from the invocation's own cwd (a Bash command or dispatched agent may
 *   run inside a sibling checkout of a meta-workspace that carries its own config,
 *   state and logs). Falls back to the session root.
 * - `jevProjects()` lists the session root plus any direct child that carries its own
 *   `.pi/jev/` — shared by prompt-context (per-project rules/tools) and stats.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXT_ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---------- session root (stable for the whole session) ----------

let sessionRoot: string | null = null;

/** Session root: JEV_SESSION_ROOT override (checked every call, wins over cache), else the git toplevel of pi's working directory. */
export function project(): string {
	if (process.env.JEV_SESSION_ROOT) {
		sessionRoot = path.resolve(process.env.JEV_SESSION_ROOT);
		return sessionRoot;
	}
	if (sessionRoot) return sessionRoot;
	const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" });
	sessionRoot = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : process.cwd();
	return sessionRoot;
}

/** The `.pi/jev/` a single hook invocation should use, and its merged config. */
export interface Resolved {
	/** Project root whose `.pi/jev/` won the resolution. */
	project: string;
	projectJev: string;
	state: string;
	logs: string;
	cfg: any;
}

export const JEV_DIR = path.join(".pi", "jev");

/**
 * Re-resolve the nearest `.pi/jev/` starting from `hint` (a hook's own cwd), instead of
 * the session root fixed from pi's working directory. A Bash command or dispatched agent
 * operating inside a sibling checkout of a meta-workspace — its own independent git
 * repository, ignored by the session root's tree — picks up THAT sibling's own
 * `.pi/jev/config.json`, state and logs. Falls back to the session root when no hint is
 * given, the hint cannot be resolved, or no ancestor of the hint carries `.pi/jev/`.
 */
export function resolve(hint?: string): Resolved {
	let root = project();
	if (hint) {
		let p: string;
		try {
			p = fs.statSync(hint).isFile() ? path.dirname(path.resolve(hint)) : path.resolve(hint);
		} catch {
			p = path.resolve(hint); // nonexistent path: treat it as a directory hint (matches pathlib semantics)
		}
		for (const d of [p, ...ancestors(p)]) {
			if (fs.existsSync(path.join(d, JEV_DIR)) && fs.statSync(path.join(d, JEV_DIR)).isDirectory()) {
				root = d;
				break;
			}
		}
	}
	return resolvedFor(root);
}

function resolvedFor(root: string): Resolved {
	const projectJev = path.join(root, JEV_DIR);
	return {
		project: root,
		projectJev,
		state: path.join(projectJev, "state"),
		logs: path.join(projectJev, "logs"),
		cfg: mergeCfg(projectJev),
	};
}

function* ancestors(p: string): Generator<string> {
	let cur = path.dirname(p);
	while (cur !== path.dirname(cur)) {
		yield cur;
		cur = path.dirname(cur);
	}
}

/**
 * The session's own project root (always first), plus any direct child directory that
 * carries its own `.pi/jev/` — a sibling checkout in a meta-workspace, its own
 * independent git repository rather than part of the session root's git tree.
 * Deliberately one level deep only, to stay fast and match the common
 * "meta-repo with sibling repos" shape. Shared by prompt-context (matching each
 * project's own rules.json/tools.json against its own changed files) and stats
 * (summarizing every project's own decisions.jsonl in one place).
 */
export function jevProjects(): string[] {
	const root = project();
	const roots = [root];
	let children: string[] = [];
	try {
		children = fs
			.readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => path.join(root, d.name))
			.sort();
	} catch {
		/* unreadable root */
	}
	for (const d of children) {
		if (d !== root && fs.existsSync(path.join(d, JEV_DIR))) roots.push(d);
	}
	return roots;
}

// ---------- config ----------

function loadJson(file: string, fallback: unknown): any {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return fallback;
	}
}

export function deepMerge<T>(base: T, over: any): T {
	if (typeof base !== "object" || base === null || Array.isArray(base) || typeof over !== "object" || over === null) {
		return (over === undefined ? base : over) as T;
	}
	const out: any = { ...base };
	for (const k of Object.keys(over)) {
		out[k] = k in out ? deepMerge((out as any)[k], over[k]) : over[k];
	}
	return out as T;
}

function mergeCfg(projectJev: string): any {
	return deepMerge(loadJson(path.join(EXT_ROOT, "config", "default.json"), {}), loadJson(path.join(projectJev, "config.json"), {}));
}

/** Session-root config. Per-invocation callers should use `resolve(hint).cfg` instead. */
export function loadConfig(): any {
	return mergeCfg(path.join(project(), JEV_DIR));
}

/** rules.json / tools.json live in a project; missing means the feature is off. */
export function projectFile(name: string, projectJev: string, fallback: unknown): any {
	return loadJson(path.join(projectJev, name), fallback);
}

/** shadow: ask Jev and log, never change behavior. enforce: act on answers. */
export function mode(cfg?: any): string {
	return process.env.JEV_MODE || (cfg ?? loadConfig()).mode || "shadow";
}

// ---------- state (base = a Resolved.state directory; session root by default) ----------

function ensure(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	const ignore = path.join(dir, ".gitignore");
	if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
}

export function stateRead(name: string, fallback: any = null, base?: string): any {
	const p = path.join(base ?? path.join(project(), JEV_DIR, "state"), name);
	if (!fs.existsSync(p)) return fallback;
	const text = fs.readFileSync(p, "utf-8");
	return name.endsWith(".json") ? JSON.parse(text) : text;
}

export function stateWrite(name: string, value: any, base?: string): string {
	const dir = base ?? path.join(project(), JEV_DIR, "state");
	ensure(dir);
	const p = path.join(dir, name);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, name.endsWith(".json") ? JSON.stringify(value, null, 2) : String(value));
	return p;
}

export function log(event: Record<string, unknown>, base?: string, cfg?: any): void {
	const dir = base ?? path.join(project(), JEV_DIR, "logs");
	ensure(dir);
	const row = { ts: new Date().toISOString().replace("T", " ").slice(0, 19), mode: mode(cfg), ...event };
	fs.appendFileSync(path.join(dir, "decisions.jsonl"), JSON.stringify(row) + "\n");
}

// ---------- question and answer types ----------

export interface NoulQuestion {
	type: "noul";
	instructions: string | object;
	criteria?: { true?: string; false?: string };
}
export interface ChoiceQuestion {
	type: "choice";
	instructions: string | object;
	criteria: Record<string, string | object | null>;
}
export interface ScoreQuestion {
	type: "score";
	instructions: string | object;
	criteria: string[] | object;
}
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
	type: "noul";
	noul: number;
}
export interface ChoiceAnswer {
	type: "choice";
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}
export interface ScoreAnswer {
	type: "score";
	score: number;
	confidence: number;
	legend?: Record<string, string>;
	probabilities: Record<string, number>;
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export function ceilLevel(score: number): number {
	return Math.ceil(score - 1e-9);
}

// ---------- mock transport: exercise the real request path without an API key ----------

function mockAnswer(q: Question, canned: any): Answer {
	if (canned) return { type: q.type, ...canned } as Answer;
	if (q.type === "noul") return { type: "noul", noul: 0.1 };
	if (q.type === "score") {
		const criteria = (q as ScoreQuestion).criteria as string[];
		return {
			type: "score",
			score: 0,
			confidence: 0.9,
			legend: Object.fromEntries(criteria.map((c, i) => [String(i), c])),
			probabilities: Object.fromEntries(criteria.map((_, i) => [String(i), i === 0 ? 1 : 0])),
		};
	}
	const keys = Object.keys((q as ChoiceQuestion).criteria);
	const rest = Math.round((0.1 / Math.max(keys.length - 1, 1)) * 1e4) / 1e4;
	return {
		type: "choice",
		choice: keys[0],
		confidence: 0.9,
		probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.9 : rest])),
	};
}

// ---------- one Jev request; the server evaluates all questions in parallel ----------

export async function ask(
	hook: string,
	state: unknown,
	questions: Record<string, Question>,
	opts?: { cfg?: any; logs?: string },
): Promise<Record<string, Answer>> {
	const cfg = opts?.cfg ?? loadConfig();
	const budgetMs = (cfg.timeout_s ?? 8) * 1000;
	const started = Date.now();

	let res: any;
	if (process.env.JEV_MOCK) {
		const cannedPath = process.env.JEV_MOCK_ANSWERS;
		const canned = cannedPath && fs.existsSync(cannedPath) ? JSON.parse(fs.readFileSync(cannedPath, "utf-8")) : {};
		const answers = Object.fromEntries(
			Object.entries(questions).map(([qid, q]) => [qid, mockAnswer(q, canned[qid])]),
		);
		res = { model: "jev-mock", answers, usage: { input_tokens: 0, output_tokens: 0 } };
	} else {
		const apiKey = process.env.TYPESAFE_API_KEY;
		if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");
		// Per-attempt timeout is half the budget; one retry keeps the total inside it.
		const body = JSON.stringify({ state, model: cfg.model, questions });
		res = await withRetry(budgetMs, async (signal) => {
			const r = await fetch("https://api.typesafe.ai/v1/systemone", {
				method: "POST",
				headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
				body,
				signal,
			});
			if (!r.ok) throw new Error(`TypeSafe API ${r.status}`);
			return r.json();
		});
	}

	log(
		{
			hook,
			model: res.model,
			latency_ms: Date.now() - started,
			input_tokens: res.usage?.input_tokens ?? 0,
			questions: Object.keys(questions),
			answers: res.answers,
		},
		opts?.logs,
		cfg,
	);
	return res.answers;
}

async function withRetry<T>(budgetMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const deadline = Date.now() + budgetMs;
	let lastErr: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw lastErr instanceof Error ? lastErr : new Error("Jev timeout");
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), Math.min(remaining, Math.ceil(budgetMs / 2)));
		try {
			return await fn(ctrl.signal);
		} catch (e) {
			lastErr = e;
		} finally {
			clearTimeout(timer);
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error("Jev request failed");
}

/** Run a handler; any unexpected error means: no decision, error logged. */
export async function guard<R>(hook: string, fn: () => Promise<R | void> | R | void, r?: Resolved): Promise<R | void> {
	try {
		return await fn();
	} catch (e: any) {
		try {
			log({ hook, error: String(e?.message ?? e) }, r?.logs, r?.cfg);
		} catch {
			/* logging itself failed; stay silent */
		}
		return undefined;
	}
}
