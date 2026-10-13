"""A model provider for the NixOS module's VM test: OpenAI chat completions on
127.0.0.1:9999, streamed or not, always answering STUB-OK. Each request's path,
model and Authorization header is appended to the log file given as argv[1], so the
test can check the agent turn reached it with the key from the instance's credential.
"""

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = sys.argv[1]
REPLY = "STUB-OK"
MODEL = "stub-model"


class Handler(BaseHTTPRequestHandler):
    def log_request_json(self, body):
        with open(LOG, "a") as log:
            log.write(json.dumps({
                "method": self.command,
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
                "model": body.get("model"),
                "stream": bool(body.get("stream")),
            }) + "\n")

    def send_json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.log_request_json({})
        if self.path.rstrip("/").endswith("/models"):
            self.send_json(200, {"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "stub"}]})
        else:
            self.send_json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        self.log_request_json(body)
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self.send_json(404, {"error": {"message": "not found"}})
            return
        created = int(time.time())
        usage = {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
        if not body.get("stream"):
            self.send_json(200, {
                "id": "chatcmpl-stub", "object": "chat.completion", "created": created, "model": MODEL,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": REPLY}, "finish_reason": "stop"}],
                "usage": usage,
            })
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        chunk = {"id": "chatcmpl-stub", "object": "chat.completion.chunk", "created": created, "model": MODEL}
        for choice, extra in (
            ({"index": 0, "delta": {"role": "assistant", "content": REPLY}, "finish_reason": None}, {}),
            ({"index": 0, "delta": {}, "finish_reason": "stop"}, {}),
            (None, {"choices": [], "usage": usage}),
        ):
            event = dict(chunk, **({"choices": [choice]} if choice else {}), **extra)
            self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("127.0.0.1", 9999), Handler).serve_forever()
