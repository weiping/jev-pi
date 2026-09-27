#!/usr/bin/env bash
# End-to-end test: install the plugin from this repo as a marketplace, then drive the real
# Claude Code binary with a scripted fake Messages API. No Anthropic or TypeSafe key needed.
# Usage (from the repo root): bash tests/e2e.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d); PORT=${E2E_PORT:-8765}
export CLAUDE_CONFIG_DIR="$WORK/claude-config"          # 隔离的 Claude Code 配置，不碰你自己的 ~/.claude
trap 'kill ${MOCK:-0} 2>/dev/null || true; rm -rf "$WORK"' EXIT

# 1. 像用户一样从市场安装
claude plugin marketplace add "$REPO" >/dev/null
claude plugin install jev@jev-engineering >/dev/null

# 2. 一个带项目配置的示例仓库
P="$WORK/demo"; mkdir -p "$P/src" "$P/docs" "$P/.claude/jev"; cd "$P"; git init -q
echo 'export const price = (c) => c * 100;' > src/cart.tsx
echo 'Use 2-space indentation and named exports in TSX.' > docs/style-guide.md
echo 'STRIPE_KEY=sk_live_dummy' > .env
echo '[{"id": "frontend-style", "when_files": ["src/*.tsx"], "load": "docs/style-guide.md"}]' > .claude/jev/rules.json
echo '{"test": {"what": "Run the test suite.", "how": "npm test"}, "none": {"what": "No tool is relevant.", "how": ""}}' > .claude/jev/tools.json
git add -A && git -c user.email=e@e -c user.name=e commit -qm init
echo 'export const tax = 0.1;' >> src/cart.tsx

export ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT ANTHROPIC_API_KEY=sk-ant-dummy CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
echo '[{"text": "warm-up"}]' > "$WORK/script.json"
python3 "$REPO/tests/e2e_mock_api.py" "$PORT" "$WORK/script.json" "$WORK/api.log" & MOCK=$!
sleep 1

# 3. 第一次会话触发 SessionStart 里的 setup.sh，在插件数据目录装好虚拟环境
claude -p "hello" < /dev/null > /dev/null
DATA="$CLAUDE_CONFIG_DIR/plugins/data/jev-jev-engineering"
[ -f "$DATA/requirements.txt" ] || { echo "setup.sh did not finish:"; cat "$DATA/setup.log"; exit 1; }
VENV="$DATA/venv/bin/python"
echo "plugin venv: $VENV"

# 4. 正式会话：按脚本出招，Jev 走模拟传输，执行模式
cp "$REPO/tests/e2e_script.json" "$WORK/script.json"; : > "$WORK/api.log"
JEV_MOCK=1 JEV_MOCK_ANSWERS="$REPO/tests/e2e_answers.json" JEV_MODE=enforce \
  claude -p "Rename the price helper in the cart" --output-format json < /dev/null > "$WORK/result.json"

"$VENV" - "$WORK/api.log" << 'PYEOF'
import json, sys
log = [json.loads(l) for l in open(".claude/jev/logs/decisions.jsonl")]
acts = [(r["hook"], r.get("action"), r.get("by")) for r in log if r.get("action")]
assert ("permission_gate", "deny", "rule") in acts, acts
assert ("permission_gate", "allow", "jev") in acts, acts
assert any(r.get("hook") == "output_ladder" and r.get("hidden_ranges") for r in log)
assert any(r.get("hook") == "agent_router" and r.get("downgraded") for r in log)
reqs = [json.loads(l)["body"] for l in open(sys.argv[1])]
dump = json.dumps(reqs)
assert "UserPromptSubmit hook additional context" in dump and "style-guide" in dump
assert "Blocked by project rule" in dump and "hidden ranges" in dump
haiku = [b["model"] for b in reqs if "haiku" in b.get("model", "")]
assert haiku, "subagent was not downgraded"
assert any(g["status"] == "done" for g in json.load(open(".claude/jev/state/subgoals.json")).values())
print("e2e ok: installed from the marketplace, venv set up by SessionStart,")
print("        context injected, rule deny, jev allow, output ladder applied,")
print("        subagent downgraded to", haiku[0], "and recorded as done")
PYEOF
