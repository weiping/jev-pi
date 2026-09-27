"""Minimal fake Anthropic Messages API that scripts tool calls, to drive the real Claude Code binary."""
import json, sys, itertools
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCRIPT_PATH = sys.argv[2]  # re-read on every request, so a test can switch scripts
LOG = open(sys.argv[3], "a")
ids = itertools.count(1)

def main_step(body):
    # 以主会话里已有的 assistant 轮数决定下一步
    script = json.load(open(SCRIPT_PATH))
    n = sum(1 for m in body["messages"] if m["role"] == "assistant")
    return script[n] if n < len(script) else {"text": "done"}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200); self.send_header("content-type","application/json"); self.end_headers(); self.wfile.write(b"{}")
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])) or b"{}")
        LOG.write(json.dumps({"path": self.path, "body": body}) + "\n"); LOG.flush()
        if not self.path.startswith("/v1/messages") or "count_tokens" in self.path:
            self.send_response(200); self.send_header("content-type","application/json"); self.end_headers()
            self.wfile.write(json.dumps({"input_tokens": 100}).encode()); return
        msgs = json.dumps(body.get("messages", [])[:1])
        is_main = any(t.get("name") == "Bash" for t in body.get("tools", []))
        if "SUBAGENT_TASK" in msgs:
            step = {"text": "Renamed price to unitPrice in 2 files."}
        elif is_main:
            step = main_step(body)
        else:
            step = {"text": "ok"}
        mid = f"msg_{next(ids)}"
        if "tool" in step:
            block = {"type": "tool_use", "id": f"toolu_{next(ids)}", "name": step["tool"], "input": {}}
            stop = "tool_use"
        else:
            block = {"type": "text", "text": ""}
            stop = "end_turn"
        if not body.get("stream"):
            content = [{**block, "input": step["input"]}] if "tool" in step else [{"type": "text", "text": step["text"]}]
            msg = {"id": mid, "type": "message", "role": "assistant", "model": body.get("model"), "content": content,
                   "stop_reason": stop, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 5}}
            self.send_response(200); self.send_header("content-type","application/json"); self.end_headers()
            self.wfile.write(json.dumps(msg).encode()); return
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        def ev(t, d): self.wfile.write(f"event: {t}\ndata: {json.dumps(d)}\n\n".encode())
        ev("message_start", {"type": "message_start", "message": {"id": mid, "type": "message", "role": "assistant",
            "model": body.get("model"), "content": [], "stop_reason": None, "stop_sequence": None,
            "usage": {"input_tokens": 10, "output_tokens": 1}}})
        ev("content_block_start", {"type": "content_block_start", "index": 0, "content_block": block})
        if "tool" in step:
            ev("content_block_delta", {"type": "content_block_delta", "index": 0,
               "delta": {"type": "input_json_delta", "partial_json": json.dumps(step["input"])}})
        else:
            ev("content_block_delta", {"type": "content_block_delta", "index": 0,
               "delta": {"type": "text_delta", "text": step["text"]}})
        ev("content_block_stop", {"type": "content_block_stop", "index": 0})
        ev("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None},
            "usage": {"output_tokens": 5}})
        ev("message_stop", {"type": "message_stop"})

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
