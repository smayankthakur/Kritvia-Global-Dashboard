"""A tiny stdio MCP server for the runner's tests: echoes, and shows a setting it was started with."""
import json
import os
import sys

for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg:
        continue
    m = msg["method"]
    if m == "initialize":
        res = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "fake", "version": "1"}}
    elif m == "tools/list":
        res = {"tools": [{"name": "echo", "description": "Echo text", "annotations": {"readOnlyHint": True},
                          "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}}]}
    elif m == "tools/call":
        a = msg["params"]["arguments"]
        res = {"content": [{"type": "text", "text": f"{a.get('text')} (key {os.environ.get('FAKE_KEY', '-')})"}]}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "no"}}), flush=True)
        continue
    print("log line that is not JSON", flush=True)
    print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": res}), flush=True)
