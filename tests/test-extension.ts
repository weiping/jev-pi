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

import { ask, ceilLevel, deepMerge } from "../extension/jev/jevlib.ts";
import { gateDecision, isSimpleReadonly, scriptText, tokenize } from "../extension/jev/permission-gate.ts";
import { buildLadderOutput, chunkLines } from "../extension/jev/output-ladder.ts";
import { routerDecision } from "../extension/jev/agent-router.ts";
import { buildContext, globMatch } from "../extension/jev/prompt-context.ts";
import { recallText, statsText } from "../extension/jev/commands.ts";

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

await test("buildContext loads glob rules, jev rules, and top tools", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-ctx-"));
	fs.writeFileSync(path.join(dir, "guide.md"), "read me first");
	const rules = [
		{ id: "r1", load: "guide.md", when_files: ["*.md"] },
		{ id: "r2", load: "guide.md", when_jev: "request is about guides" },
	];
	const tools = { fmt: { what: "formatter", how: "make fmt" }, none: { what: "none", how: "" } };
	const answers: any = {
		rule_r2: noul(0.7),
		tool: { type: "choice", choice: "fmt", confidence: 0.9, probabilities: { fmt: 0.8, none: 0.2 } },
	};
	const ctx = buildContext(rules, tools, ["guide.md"], answers, [rules[0]], { rule_threshold: 0.6, tool_top_k: 3, tool_min_prob: 0.2, max_chars: 9000 }, dir);
	assert.match(ctx, /read me first/);
	assert.match(ctx, /formatter/);
	assert.match(ctx, /make fmt/);
	// below threshold: rule not loaded twice, tool filtered out
	const ctx2 = buildContext(rules, tools, [], { rule_r2: noul(0.2), tool: { type: "choice", choice: "none", confidence: 0.9, probabilities: { none: 1 } } }, [], { rule_threshold: 0.6, tool_top_k: 3, tool_min_prob: 0.2, max_chars: 9000 }, dir);
	assert.equal(ctx2, "");
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- commands ----------

await test("recallText prints numbered ranges 1-based inclusive", () => {
	const f = path.join(os.tmpdir(), `jev-recall-${Date.now()}.txt`);
	fs.writeFileSync(f, "a\nb\nc\nd\n");
	assert.equal(recallText(f, 2, 3), "     2  b\n     3  c");
	assert.equal(recallText(f).split("\n").length, 4);
	fs.rmSync(f);
});

await test("statsText reports empty when a project has no logs", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-stats-"));
	spawnSync("git", ["init", "-q"], { cwd: dir });
	assert.match(statsText(dir), /No Jev decisions logged/);
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- summary ----------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
	for (const f of failures) console.error(`FAIL ${f}`);
	process.exit(1);
}
