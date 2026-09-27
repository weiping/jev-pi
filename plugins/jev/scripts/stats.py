#!/usr/bin/env python3
"""Summarize .claude/jev/logs/decisions.jsonl for /jev-stats."""
import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import jevlib  # noqa: E402

path = jevlib.LOGS / "decisions.jsonl"
if not path.exists():
    print("No Jev decisions logged yet.")
    raise SystemExit
rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
calls = [r for r in rows if "latency_ms" in r]
by_hook = defaultdict(list)
for r in calls:
    by_hook[r["hook"]].append(r)
tokens = sum(r.get("input_tokens") or 0 for r in calls)
print(f"Jev calls: {len(calls)}   input tokens: {tokens}   est. cost: ${tokens * 0.042 / 1e6:.4f}")
print(f"models: {dict(Counter(r['model'] for r in calls))}")
for hook, rs in sorted(by_hook.items()):
    lat = [r["latency_ms"] for r in rs]
    print(f"- {hook}: {len(rs)} calls, median {statistics.median(lat):.0f} ms, p90 {sorted(lat)[int(len(lat) * 0.9) - 1 if len(lat) > 1 else 0]} ms")
acts = Counter((r["hook"], r.get("action")) for r in rows if r.get("action"))
for (hook, act), n in sorted(acts.items()):
    print(f"  {hook} -> {act}: {n}")
lad = [r for r in rows if r.get("hook") == "output_ladder" and "chars_before" in r]
if lad:
    b, a = sum(r["chars_before"] for r in lad), sum(r["chars_after"] for r in lad)
    print(f"output_ladder: {b} -> {a} chars ({(1 - a / b) * 100:.0f}% hidden, recoverable)")
errors = [r for r in rows if "error" in r]
print(f"errors: {len(errors)}  mode now: {rows[-1].get('mode')}")
