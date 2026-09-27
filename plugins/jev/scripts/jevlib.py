"""Shared helpers for the Jev plugin: paths, config, client, mock transport, logging, state."""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path

PLUGIN_ROOT = Path(os.environ.get("CLAUDE_PLUGIN_ROOT") or Path(__file__).resolve().parents[1])


def _project_dir() -> Path:
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env:
        return Path(env)
    r = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    return Path(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else Path.cwd()


PROJECT = _project_dir()
PROJECT_JEV = PROJECT / ".claude" / "jev"      # 项目级配置：config.json、rules.json、tools.json
STATE = PROJECT_JEV / "state"                   # 运行时状态，自动被 git 忽略
LOGS = PROJECT_JEV / "logs"                     # 决策日志，自动被 git 忽略
PYTHON = sys.executable                         # 装了 SDK 的插件虚拟环境解释器


def _load(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def _merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in over.items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


# 插件默认配置，叠加项目里的 .claude/jev/config.json
CFG = _merge(_load(PLUGIN_ROOT / "config" / "default.json", {}), _load(PROJECT_JEV / "config.json", {}))


def project_file(name: str, default):
    """rules.json / tools.json live in the project; missing means the feature is off."""
    return _load(PROJECT_JEV / name, default)


def mode() -> str:
    """shadow: ask Jev and log, never change Claude Code's behavior. enforce: act on answers."""
    return os.environ.get("JEV_MODE", CFG.get("mode", "shadow"))


def read_input() -> dict:
    return json.load(sys.stdin)


def emit(obj: dict | None) -> None:
    """Print hook JSON (or nothing) and exit 0. Printing nothing means: no decision."""
    if obj:
        print(json.dumps(obj, ensure_ascii=False))
    sys.exit(0)


def _ensure(d: Path) -> None:
    d.mkdir(parents=True, exist_ok=True)
    ignore = d / ".gitignore"
    if not ignore.exists():
        ignore.write_text("*\n", encoding="utf-8")


def state_read(name: str, default=None):
    p = STATE / name
    if not p.exists():
        return default
    text = p.read_text(encoding="utf-8")
    return json.loads(text) if name.endswith(".json") else text


def state_write(name: str, value) -> Path:
    _ensure(STATE)
    p = STATE / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(value, ensure_ascii=False, indent=2) if name.endswith(".json") else value,
                 encoding="utf-8")
    return p


def log(event: dict) -> None:
    _ensure(LOGS)
    event = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "mode": mode(), **event}
    with (LOGS / "decisions.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")


# ---------- mock transport: exercise the real SDK code path without an API key ----------

def _mock_handler(request):
    import httpx2

    body = json.loads(request.content)
    canned = {}
    path = os.environ.get("JEV_MOCK_ANSWERS")
    if path and Path(path).exists():
        canned = json.loads(Path(path).read_text(encoding="utf-8"))
    answers = {}
    for qid, q in body["questions"].items():
        if qid in canned:
            answers[qid] = {"type": q["type"], **canned[qid]}
        elif q["type"] == "noul":
            answers[qid] = {"type": "noul", "noul": 0.1}
        elif q["type"] == "choice":
            keys = list(q["criteria"])
            rest = round(0.1 / max(len(keys) - 1, 1), 4)
            probs = {k: (0.9 if i == 0 else rest) for i, k in enumerate(keys)}
            answers[qid] = {"type": "choice", "choice": keys[0], "confidence": 0.9, "probabilities": probs}
        else:  # score
            n = len(q["criteria"])
            answers[qid] = {"type": "score", "score": 0.0, "confidence": 0.9,
                            "legend": {str(i): c for i, c in enumerate(q["criteria"])},
                            "probabilities": {str(i): (1.0 if i == 0 else 0.0) for i in range(n)}}
    payload = {"model": "jev-mock", "answers": answers,
               "usage": {"input_tokens": len(request.content) // 4, "output_tokens": 0}}
    return httpx2.Response(200, json=payload)


def ask(hook: str, state, questions: dict):
    """One Jev request; the server evaluates all questions in parallel."""
    from typesafe_sdk import RetryPolicy, TypeSafeClient

    budget = CFG.get("timeout_s", 8)
    # 单次请求和含重试的总耗时都限制在预算内，保证比 hook 的超时先结束
    kwargs = {"model": CFG["model"], "timeout": budget / 2,
              "retry": RetryPolicy(max_retries=1, timeout=budget)}
    if os.environ.get("JEV_MOCK"):
        import httpx2
        kwargs.update(api_key="mock", transport=httpx2.MockTransport(_mock_handler))
    started = time.time()
    with TypeSafeClient(**kwargs) as client:
        res = client.system_one(state=state, questions=questions)
    log({"hook": hook, "model": res.model, "latency_ms": int((time.time() - started) * 1000),
         "input_tokens": res.usage.input_tokens, "questions": list(questions),
         "answers": {k: v.model_dump() for k, v in res.answers.items()}})
    return res.answers


def guard(hook: str, main) -> None:
    """Run a hook; any unexpected error means: no decision, exit 0, error logged."""
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        try:
            log({"hook": hook, "error": repr(e)})
        finally:
            sys.exit(0)


def ceil_level(score: float) -> int:
    return int(math.ceil(score - 1e-9))
