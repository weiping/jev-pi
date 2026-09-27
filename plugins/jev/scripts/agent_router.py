#!/usr/bin/env python3
"""PreToolUse(Agent): subgoal dedupe, security-aware routing, and cost-aware downgrade.

A subagent starts with a fresh, purpose-built context and returns only its final report,
which is exactly the condition under which routing work to a cheaper model pays off.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import jevlib  # noqa: E402

CFG = jevlib.CFG["routing"]
SENSITIVITY = [
    "Public docs, tests, or open-source dependencies only.",
    "Ordinary application code.",
    "Secrets, .env files, credentials, CI or infrastructure configuration.",
    "Proprietary research code or customer data.",
]


def out(kind: str, reason: str, updated: dict | None = None) -> dict:
    hso = {"hookEventName": "PreToolUse", "permissionDecision": kind, "permissionDecisionReason": reason}
    if updated is not None:
        hso["updatedInput"] = updated
    return {"hookSpecificOutput": hso}


def main() -> None:
    data = jevlib.read_input()
    ti = data["tool_input"]
    task = f"{ti.get('description', '')}\n{ti.get('prompt', '')}"[:6000]
    agent = ti.get("subagent_type", "general-purpose")
    registry = jevlib.state_read("subgoals.json", {})
    recent = dict(list(registry.items())[-50:])  # choice 最多 255 个选项，这里只比最近 50 个

    from typesafe_sdk import Choice, Score

    questions = {
        "tier": Choice(instructions="Which model tier can complete `task` reliably from `task` alone?",
                       criteria={"cheap": "Mechanical or well-specified: renames, lookups, boilerplate, "
                                          "applying a described change, summarizing files.",
                                 "frontier": "Needs design judgment, debugging, ambiguity, or high-stakes changes."}),
        "sensitivity": Score(instructions="How sensitive are the files and data `task` will touch?",
                             criteria=SENSITIVITY),
    }
    if recent:
        crit = {gid: f"{g['text'][:300]} (status: {g['status']})" for gid, g in recent.items()}
        crit["new"] = "None of the existing subgoals already covers this work."
        questions["dup"] = Choice(instructions="Which existing subgoal already covers `task`, if any?",
                                  criteria=crit)
    try:
        a = jevlib.ask("agent_router", {"task": task, "requested_agent": agent}, questions)
    except Exception as e:
        jevlib.log({"hook": "agent_router", "error": repr(e)})
        jevlib.emit(None)

    level = jevlib.ceil_level(a["sensitivity"].score)  # 期望分向上取整，安全判断宁可保守
    tier = a["tier"]
    is_cheap = agent in CFG["cheap_agents"] or ti.get("model") == CFG["cheap_model"]
    result = None

    if "dup" in a and a["dup"].choice != "new" and a["dup"].confidence >= CFG["dedupe_confidence"]:
        g = registry[a["dup"].choice]
        result = out("deny", f"Duplicate of subgoal {a['dup'].choice} ({g['status']}). "
                             f"Reuse its result instead of spawning again: {g.get('result', '')[:400]}")
    elif is_cheap and level >= CFG["sensitive_level"]:
        result = out("deny", f"This task touches sensitivity level {level} data. Do not delegate it to a "
                             "cheap model; handle it in the main session or a frontier subagent.")
    elif is_cheap and tier.choice == "frontier" and tier.confidence >= CFG["tier_confidence"]:
        result = out("deny", "This task needs frontier-level judgment. Use general-purpose instead of "
                             f"{agent}, or split out the mechanical parts first.")
    elif (not is_cheap and tier.choice == "cheap" and tier.confidence >= CFG["tier_confidence"]
          and level < CFG["sensitive_level"]):
        result = out("allow", "Jev: mechanical task, running on the cheap model",
                     {**ti, "model": CFG["cheap_model"]})

    action = result["hookSpecificOutput"]["permissionDecision"] if result else "pass"
    if action != "deny":
        registry[data.get("tool_use_id", str(len(registry)))] = {"text": task[:600], "status": "running"}
        jevlib.state_write("subgoals.json", registry)
    jevlib.log({"hook": "agent_router", "agent": agent, "tier": tier.choice, "level": level,
                "action": action, "downgraded": bool(result and "updatedInput" in result["hookSpecificOutput"])})
    jevlib.emit(result if jevlib.mode() == "enforce" else None)


if __name__ == "__main__":
    jevlib.guard("agent_router", main)
