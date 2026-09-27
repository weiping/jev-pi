/**
 * Shared helpers for the Jev pi extension: paths, config, client, mock transport,
 * logging, state. Direct port of plugins/jev/scripts/jevlib.py.
 *
 * Project-level files live in <project>/.pi/jev/ (config.json, rules.json, tools.json);
 * runtime state in .pi/jev/state/ and decision logs in .pi/jev/logs/, each self-ignored.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXT_ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---------- project paths ----------

let projectCache: string | null = null;

export function project(): string {
	if (projectCache) return projectCache;
	const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" });
	projectCache =
		r.status === 0 && r.stdout.trim() ? r.stdout.trim() : process.cwd();
	return projectCache;
}

export function projectDir(cwd?: string): string {
	// Event contexts carry the real working directory; use it when provided.
	if (cwd && cwd !== projectCache) {
		const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8" });
		if (r.status === 0 && r.stdout.trim()) {
			projectCache = r.stdout.trim();
			return projectCache;
		}
	}
	return project();
}

export function piJev(cwd?: string): string {
	return path.join(projectDir(cwd), ".pi", "jev");
}
export function stateDir(cwd?: string): string {
	return path.join(piJev(cwd), "state");
}
export function logsDir(cwd?: string): string {
	return path.join(piJev(cwd), "logs");
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

/** Plugin defaults, deep-merged with the project's .pi/jev/config.json. */
export function loadConfig(cwd?: string): any {
	const defaults = loadJson(path.join(EXT_ROOT, "config", "default.json"), {});
	const projectCfg = loadJson(path.join(piJev(cwd), "config.json"), {});
	return deepMerge(defaults, projectCfg);
}

/** rules.json / tools.json live in the project; missing means the feature is off. */
export function projectFile(name: string, fallback: unknown, cwd?: string): any {
	return loadJson(path.join(piJev(cwd), name), fallback);
}

/** shadow: ask Jev and log, never change behavior. enforce: act on answers. */
export function mode(cfg: any): string {
	return process.env.JEV_MODE || cfg.mode || "shadow";
}

// ---------- state ----------

function ensure(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	const ignore = path.join(dir, ".gitignore");
	if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
}

export function stateRead(name: string, fallback: any = null, cwd?: string): any {
	const p = path.join(stateDir(cwd), name);
	if (!fs.existsSync(p)) return fallback;
	const text = fs.readFileSync(p, "utf-8");
	return name.endsWith(".json") ? JSON.parse(text) : text;
}

export function stateWrite(name: string, value: any, cwd?: string): string {
	ensure(stateDir(cwd));
	const p = path.join(stateDir(cwd), name);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, name.endsWith(".json") ? JSON.stringify(value, null, 2) : String(value));
	return p;
}

export function log(event: Record<string, unknown>, cwd?: string): void {
	ensure(logsDir(cwd));
	const row = { ts: new Date().toISOString().replace("T", " ").slice(0, 19), ...event };
	fs.appendFileSync(path.join(logsDir(cwd), "decisions.jsonl"), JSON.stringify(row) + "\n");
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
	cwd?: string,
): Promise<Record<string, Answer>> {
	const cfg = loadConfig(cwd);
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
			mode: mode(cfg),
			model: res.model,
			latency_ms: Date.now() - started,
			input_tokens: res.usage?.input_tokens ?? 0,
			questions: Object.keys(questions),
			answers: res.answers,
		},
		cwd,
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
export async function guard<R>(hook: string, fn: () => Promise<R | void> | R | void, cwd?: string): Promise<R | void> {
	try {
		return await fn();
	} catch (e: any) {
		try {
			log({ hook, mode: mode(loadConfig(cwd)), error: String(e?.message ?? e) }, cwd);
		} catch {
			/* logging itself failed; stay silent */
		}
		return undefined;
	}
}
