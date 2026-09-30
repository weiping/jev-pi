/**
 * Offline tests for the Jev pi extension — mock Jev, no API key needed.
 * Port of tests/test_hooks.py. Run: npx -y tsx tests/test-extension.ts
 */
process.env.JEV_MOCK = "1";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ask, ceilLevel, deepMerge, jevProjects, resolve, stateRead, stateWrite } from "../extensions/jev/jevlib.ts";
import { gateDecision, isSimpleReadonly, matchesPattern, scriptText, tokenize } from "../extensions/jev/permission-gate.ts";
import { buildLadderOutput, chunkLines } from "../extensions/jev/output-ladder.ts";
import { routerDecision } from "../extensions/jev/agent-router.ts";
import { collectProjects, composeContext, globMatch, planQuestions } from "../extensions/jev/prompt-context.ts";
import { recallText, statsText } from "../extensions/jev/commands.ts";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
	try {
		await fn();
		passed++;
	} catch (e: any) {
		failures.push(`${name}: ${e?.message ?? e}`);
	}
}

// ---------- jevlib ----------

await test("deepMerge merges nested dicts, replaces lists", () => {
	const merged: any = deepMerge({ a: { b: 1, c: [1] }, mode: "shadow" }, { a: { c: [2, 3] }, mode: "enforce" });
	assert.equal(merged.a.b, 1);
	assert.deepEqual(merged.a.c, [2, 3]);
	assert.equal(merged.mode, "enforce");
});

await test("ceilLevel rounds expected scores up conservatively", () => {
	assert.equal(ceilLevel(1.4), 2);
	assert.equal(ceilLevel(1.0), 1);
	assert.equal(ceilLevel(2.000000001), 3 - 1); // tolerance guards float noise
});

await test("ask() with JEV_MOCK answers noul/choice/score shapes", async () => {
	const a = await ask("test", { x: 1 }, {
		n: { type: "noul", instructions: "is it?" },
		c: { type: "choice", instructions: "pick", criteria: { a: "A", b: "B" } },
		s: { type: "score", instructions: "how much", criteria: ["low", "high"] },
	});
	assert.equal(a.n.type, "noul");
	assert.equal((a.n as any).noul, 0.1);
	assert.equal((a.c as any).choice, "a");
	assert.equal((a.s as any).score, 0);
	assert.equal((a.s as any).legend["1"], "high");
});

await test("ask() with JEV_MOCK_ANSWERS uses canned answers", async () => {
	const canned = path.join(os.tmpdir(), `jev-canned-${Date.now()}.json`);
	fs.writeFileSync(canned, JSON.stringify({ n: { noul: 0.9 } }));
	process.env.JEV_MOCK_ANSWERS = canned;
	const a = await ask("test", {}, { n: { type: "noul", instructions: "?" } });
	assert.equal((a.n as any).noul, 0.9);
	delete process.env.JEV_MOCK_ANSWERS;
	fs.rmSync(canned);
});

// ---------- permission gate ----------

await test("isSimpleReadonly passes plain known commands, rejects metachars", () => {
	const ro = ["ls", "git status", "rg"];
	assert.ok(isSimpleReadonly("ls", ro));
	assert.ok(isSimpleReadonly("git status", ro));
	assert.ok(!isSimpleReadonly("ls; rm -rf /", ro));
	assert.ok(!isSimpleReadonly("cat foo | sh", ro));
	assert.ok(!isSimpleReadonly("rm -rf /", ro));
});

await test("tokenize respects quotes; scriptText reads runner scripts", () => {
	assert.deepEqual(tokenize('python "my script.py" --x 1'), ["python", "my script.py", "--x", "1"]);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-gate-"));
	fs.writeFileSync(path.join(dir, "run.sh"), "echo secrets\n");
	assert.equal(scriptText("bash run.sh", dir), "echo secrets\n");
	assert.equal(scriptText("bash missing.sh", dir), "");
});

const gateCfg = { egress_threshold: 0.5, deny_confidence: 0.8, allow_confidence: 0.85 };
const choice = (choice: string, confidence: number): any => ({ type: "choice", choice, confidence, probabilities: {} });
const noul = (n: number): any => ({ type: "noul", noul: n });

await test("gateDecision: egress without user request denies", () => {
	const out = gateDecision(
		{ decision: choice("allow", 0.99), egress: noul(0.9), network_requested: noul(0.1) },
		gateCfg,
	);
	assert.equal(out.kind, "deny");
	assert.match(out.reason, /network/);
});

await test("gateDecision: high-confidence deny denies", () => {
	const out = gateDecision({ decision: choice("deny", 0.95), egress: noul(0), network_requested: noul(0) }, gateCfg);
	assert.equal(out.kind, "deny");
});

await test("gateDecision: high-confidence allow allows", () => {
	const out = gateDecision({ decision: choice("allow", 0.9), egress: noul(0), network_requested: noul(0) }, gateCfg);
	assert.equal(out.kind, "allow");
});

await test("matchesPattern: allow rule lets git add/commit compounds through, push not", () => {
	const allow = ["^git (add|commit)\\b"];
	assert.ok(matchesPattern("git add package.json && git commit -m \"x\"", allow));
	assert.equal(matchesPattern("git push origin master", allow), null);
});

await test("matchesPattern: deny list still catches what an allow rule would let pass", () => {
	// deny is checked before allow in the gate; keep both lists honest on their own
	assert.ok(matchesPattern("cat ~/.ssh/id_rsa", ["\\.ssh"]));
	assert.equal(matchesPattern("git add . && git commit -m ok", ["\\.ssh"]), null);
});

await test("default config ships audited read-only gh/npm prefixes and allow_patterns", () => {
	const def = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extensions", "jev", "config", "default.json"), "utf8"));
	for (const c of ["gh run view", "gh issue view", "gh repo list", "gh search", "npm view", "npm ls"]) {
		assert.ok(def.permission.readonly_commands.includes(c), `readonly: ${c}`);
	}
	assert.ok(def.permission.allow_patterns.some((p: string) => p.includes("git (add|commit)")));
	assert.ok(Array.isArray(def.permission.extra_allow_patterns));
});

await test("gateDecision: everything else asks", () => {
	assert.equal(gateDecision({ decision: choice("allow", 0.7), egress: noul(0), network_requested: noul(0) }, gateCfg).kind, "ask");
	assert.equal(gateDecision({ decision: choice("deny", 0.5), egress: noul(0), network_requested: noul(0) }, gateCfg).kind, "ask");
});

// ---------- output ladder ----------

await test("chunkLines respects the max-chunks cap", () => {
	const chunks = chunkLines(Array.from({ length: 500 }, (_, i) => `l${i}`), { chunk_lines: 25, max_chunks: 10 });
	assert.ok(chunks.length <= 10);
	assert.equal(chunks.reduce((s, [, b]) => s + b.length, 0), 500);
});

await test("buildLadderOutput levels chunks and upgrades low confidence", () => {
	const lines = Array.from({ length: 90 }, (_, i) => `line ${i}`);
	const chunks = chunkLines(lines, { chunk_lines: 30, max_chunks: 60 });
	const answers: any = {
		c0: choice("full", 0.9),
		c1: choice("short", 0.9),
		c2: choice("hide", 0.9),
	};
	const { text, hidden, keptChars } = buildLadderOutput(lines, chunks, answers, { low_confidence: 0.6 }, "/tmp/saved.txt");
	assert.match(text, /90 lines total/);
	assert.equal(hidden.length, 1);
	assert.match(text, /excerpt:/);
	assert.ok(text.includes("/tmp/saved.txt"));
	assert.ok(keptChars > 0);
	// low confidence upgrades one level
	const up = buildLadderOutput(lines, chunks, { c0: choice("hide", 0.3), c1: choice("hide", 0.9), c2: choice("hide", 0.9) }, { low_confidence: 0.6 }, "/tmp/saved.txt");
	assert.match(up.text, /excerpt:/); // hide -> short
});

// ---------- agent router ----------

const routeCfg = { sensitive_level: 2, tier_confidence: 0.8, dedupe_confidence: 0.8 };

await test("routerDecision: duplicate subgoal denies with pointer", () => {
	const out = routerDecision(
		{ tier: choice("cheap", 0.9), sensitivity: { type: "score", score: 0, confidence: 1, probabilities: {} }, dup: choice("g7", 0.95) } as any,
		false,
		routeCfg,
	);
	assert.equal(out.action, "deny");
	assert.match(out.reason!, /__DUP__g7/);
});

await test("routerDecision: sensitive data never goes to a cheap agent", () => {
	const out = routerDecision(
		{ tier: choice("cheap", 0.95), sensitivity: { type: "score", score: 2.6, confidence: 1, probabilities: {} } } as any,
		true,
		routeCfg,
	);
	assert.equal(out.action, "deny");
	assert.match(out.reason!, /sensitivity level 3/);
});

await test("routerDecision: frontier-tier work blocks cheap agents", () => {
	const out = routerDecision(
		{ tier: choice("frontier", 0.9), sensitivity: { type: "score", score: 0.5, confidence: 1, probabilities: {} } } as any,
		true,
		routeCfg,
	);
	assert.equal(out.action, "deny");
});

await test("routerDecision: mechanical work on a good agent downgrades", () => {
	const out = routerDecision(
		{ tier: choice("cheap", 0.9), sensitivity: { type: "score", score: 0.2, confidence: 1, probabilities: {} } } as any,
		false,
		routeCfg,
	);
	assert.equal(out.action, "downgrade");
});

await test("routerDecision: default passes", () => {
	const out = routerDecision(
		{ tier: choice("frontier", 0.9), sensitivity: { type: "score", score: 1.0, confidence: 1, probabilities: {} } } as any,
		false,
		routeCfg,
	);
	assert.equal(out.action, "pass");
});

// ---------- prompt context ----------

await test("globMatch handles *, ?, and path boundaries", () => {
	assert.ok(globMatch("docs/*.md", "docs/a.md"));
	assert.ok(!globMatch("docs/*.md", "docs/sub/a.md"));
	assert.ok(globMatch("*.test.ts", "a.test.ts"));
	assert.ok(globMatch("**/GOTCHAS.md", "a/b/GOTCHAS.md"));
	assert.ok(!globMatch("*.py", "a.ts"));
});

await test("planQuestions/composeContext load glob rules, jev rules, and top tools", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-ctx-"));
	fs.writeFileSync(path.join(dir, "guide.md"), "read me first");
	const rules = [
		{ id: "r1", load: "guide.md", when_files: ["*.md"] },
		{ id: "r2", load: "guide.md", when_jev: "request is about guides" },
	];
	const tools = { fmt: { what: "formatter", how: "make fmt" }, none: { what: "none relevant", how: "" } };
	const projects = [{ root: dir, projectJev: path.join(dir, ".pi", "jev"), rules, tools, files: ["guide.md"] }];
	const plan = planQuestions("format the guide", projects);
	assert.ok(plan.questions.rule_r2, "index-0 rule id is unprefixed");
	assert.ok(plan.questions.tool, "tool question present");
	assert.equal((plan.questions.tool as any).criteria.none, "none relevant");
	assert.deepEqual(plan.preloaded.map(([, r]) => r.id), ["r1"], "glob rule preloads");
	const answers: any = {
		rule_r2: noul(0.7),
		tool: { type: "choice", choice: "fmt", confidence: 0.9, probabilities: { fmt: 0.8, none: 0.2 } },
	};
	const ctx = composeContext(projects, plan, answers, { rule_threshold: 0.6, tool_top_k: 3, tool_min_prob: 0.2, max_chars: 9000 });
	assert.match(ctx, /read me first/);
	assert.match(ctx, /formatter/);
	assert.match(ctx, /make fmt/);
	// below threshold: jev rule not loaded, tool filtered out; glob rule still loads
	const ctx2 = composeContext(projects, plan, { rule_r2: noul(0.2), tool: { type: "choice", choice: "none", confidence: 0.9, probabilities: { none: 1 } } }, { rule_threshold: 0.6, tool_top_k: 3, tool_min_prob: 0.2, max_chars: 9000 });
	assert.ok(ctx2.includes("read me first"), "glob-matched rule still loads");
	assert.ok(!ctx2.includes("formatter"), "below-threshold tool filtered out");
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- meta-workspace: per-invocation resolve + sibling projects ----------

function makeMetaWorkspace(): string {
	const meta = fs.mkdtempSync(path.join(os.tmpdir(), "jev-meta-"));
	for (const [name, secret] of [["root-repo", "TOP_SECRET"], ["sibling-repo", "SIB_SECRET"]] as const) {
		const repo = path.join(meta, name);
		fs.mkdirSync(path.join(repo, ".pi", "jev"), { recursive: true });
		spawnSync("git", ["init", "-q"], { cwd: repo });
		fs.writeFileSync(
			path.join(repo, ".pi", "jev", "config.json"),
			JSON.stringify({ permission: { extra_deny_patterns: [secret] } }),
		);
	}
	return meta;
}

await test("resolve(hint) picks the nearest .pi/jev, falling back to the session root", () => {
	const meta = makeMetaWorkspace();
	process.env.JEV_SESSION_ROOT = meta;
	const rootRepo = path.join(meta, "root-repo");
	const sibling = path.join(meta, "sibling-repo");

	const rRoot = resolve(path.join(rootRepo, "src", "main.ts"));
	assert.equal(rRoot.project, rootRepo);
	assert.ok(rRoot.cfg.permission.extra_deny_patterns.includes("TOP_SECRET"));

	const rSib = resolve(path.join(sibling, "deep", "dir", "file.txt"));
	assert.equal(rSib.project, sibling);
	assert.ok(rSib.cfg.permission.extra_deny_patterns.includes("SIB_SECRET"));
	assert.ok(!rSib.cfg.permission.extra_deny_patterns.includes("TOP_SECRET"), "sibling isolation both ways");

	assert.equal(resolve().project, meta, "no hint falls back to session root");
	assert.equal(resolve(path.join(os.tmpdir())).project, meta, "unrelated hint falls back to session root");

	assert.deepEqual(jevProjects(), [meta, rootRepo, sibling]);
	delete process.env.JEV_SESSION_ROOT;
	fs.rmSync(meta, { recursive: true, force: true });
});

await test("prompt-context merges siblings into one request with per-project ids", () => {
	const meta = makeMetaWorkspace();
	process.env.JEV_SESSION_ROOT = meta;
	const rootRepo = path.join(meta, "root-repo");
	const sibling = path.join(meta, "sibling-repo");
	for (const [repo, tag] of [[rootRepo, "one"], [sibling, "two"]] as const) {
		fs.writeFileSync(
			path.join(repo, ".pi", "jev", "rules.json"),
			JSON.stringify([{ id: tag, load: "GOTCHAS.md", when_jev: `request touches ${tag}` }]),
		);
		fs.writeFileSync(
			path.join(repo, ".pi", "jev", "tools.json"),
			JSON.stringify({ fmt: { what: `${tag} formatter`, how: `make ${tag}` }, none: { what: `nothing for ${tag}`, how: "" } }),
		);
		fs.writeFileSync(path.join(repo, "GOTCHAS.md"), `guidance for ${tag}`);
	}

	const projects = collectProjects(jevProjects());
	assert.equal(projects.length, 2, "meta itself has no rules; both siblings participate");
	const plan = planQuestions("touch one and two", projects);
	// first participant (root-repo) is index 0 and unprefixed; sibling is s1_
	assert.ok(plan.questions.rule_one);
	assert.ok(plan.questions.rule_s1_two);
	assert.ok((plan.questions.tool as any).criteria.fmt);
	assert.ok((plan.questions.tool as any).criteria["s1:fmt"]);
	assert.equal((plan.questions.tool as any).criteria.none, "nothing for one", "first project's none text wins");
	const answers: any = {
		rule_one: noul(0.9),
		rule_s1_two: noul(0.9),
		tool: { type: "choice", choice: "s1:fmt", confidence: 0.9, probabilities: { "s1:fmt": 0.9, fmt: 0.1, none: 0 } },
	};
	const ctx = composeContext(projects, plan, answers, { rule_threshold: 0.6, tool_top_k: 3, tool_min_prob: 0.2, max_chars: 9000 });
	assert.match(ctx, /guidance for one/);
	assert.match(ctx, /guidance for two/);
	assert.match(ctx, /two formatter/);
	assert.ok(!ctx.includes("one formatter"), "only the picked sibling tool is listed");
	fs.rmSync(meta, { recursive: true, force: true });
});

await test("agent_router and agent_done share one state via the same resolve hint", () => {
	const meta = makeMetaWorkspace();
	process.env.JEV_SESSION_ROOT = meta;
	const sibling = path.join(meta, "sibling-repo");
	// router registers under the sibling's state dir...
	const r = resolve(sibling);
	stateWrite("subgoals.json", { call1: { text: "port the router", status: "running" } }, r.state);
	// ...and done reads through the same hint
	const registry: any = stateRead("subgoals.json", {}, resolve(sibling).state);
	assert.equal(registry.call1.status, "running");
	assert.ok(fs.existsSync(path.join(sibling, ".pi", "jev", "state", "subgoals.json")));
	delete process.env.JEV_SESSION_ROOT;
	fs.rmSync(meta, { recursive: true, force: true });
});

await test("statsText summarizes every sibling with headers", () => {
	const meta = makeMetaWorkspace();
	process.env.JEV_SESSION_ROOT = meta;
	const rootRepo = path.join(meta, "root-repo");
	const logs = path.join(rootRepo, ".pi", "jev", "logs");
	fs.mkdirSync(logs, { recursive: true });
	fs.writeFileSync(path.join(logs, "decisions.jsonl"), JSON.stringify({ ts: "t", mode: "shadow", hook: "permission_gate", command: "ls", action: "allow", by: "jev", latency_ms: 5, input_tokens: 100, model: "jev-mock" }) + "\n");
	const text = statsText();
	assert.match(text, /\(session root\) ==/);
	assert.match(text, /== .*root-repo \(sibling\) ==/);
	assert.match(text, /== .*sibling-repo \(sibling\) ==/);
	assert.match(text, /No Jev decisions logged yet\./);
	delete process.env.JEV_SESSION_ROOT;
	fs.rmSync(meta, { recursive: true, force: true });
});

// ---------- commands ----------

await test("recallText prints numbered ranges 1-based inclusive", () => {
	const f = path.join(os.tmpdir(), `jev-recall-${Date.now()}.txt`);
	fs.writeFileSync(f, "a\nb\nc\nd\n");
	assert.equal(recallText(f, 2, 3), "     2  b\n     3  c");
	assert.equal(recallText(f).split("\n").length, 4);
	fs.rmSync(f);
});



// ---------- summary ----------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
	for (const f of failures) console.error(`FAIL ${f}`);
	process.exit(1);
}
