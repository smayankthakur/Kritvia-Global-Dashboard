"""Deterministic stand-ins for LiteLLM (chat, embeddings, speech)."""
from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Callable
from typing import Any

import httpx

DIM = 1024
LOCAL = {"ollama-qwen-7b", "ollama-bge-m3", "local-whisper"}


def embed_text(t: str) -> list[float]:
    """Hashing-trick bag of words: texts sharing words are close in cosine space."""
    v = [0.0] * DIM
    for w in re.findall(r"[a-z0-9]+", t.lower()):
        if len(w) < 3:
            continue
        h = int(hashlib.md5(w.encode()).hexdigest(), 16)
        v[h % DIM] += 1.0
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


class FakeLiteLLM:
    def __init__(self) -> None:
        self.rules: list[tuple[str, Any]] = []
        self.calls: list[dict[str, Any]] = []
        self.fail: dict[str, int] = {}          # deployment -> HTTP status
        self.transcript: dict[str, Any] = {"text": "", "segments": []}

    def on(self, marker: str, reply: Any) -> None:
        """Reply to chat calls whose system/user prompt contains `marker`.
        reply: dict (JSON-encoded), str, or callable(messages) -> dict|str. Later rules win."""
        self.rules.insert(0, (marker, reply))

    def chat_calls(self, marker: str | None = None) -> list[dict[str, Any]]:
        return [c for c in self.calls if c["kind"] == "chat" and (marker is None or marker in c["prompt"])]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/audio/transcriptions"):
            model = re.search(rb'name="model"\r\n\r\n([^\r]+)', request.content).group(1).decode()
            self.calls.append({"kind": "speech", "model": model, "prompt": ""})
            if model in self.fail:
                return httpx.Response(self.fail[model], json={"error": "scripted"})
            return httpx.Response(200, json=self.transcript)
        body = json.loads(request.content)
        model = body["model"]
        if path.endswith("/embeddings"):
            self.calls.append({"kind": "embed", "model": model, "prompt": ""})
            if model in self.fail:
                return httpx.Response(self.fail[model], json={"error": "scripted"})
            return httpx.Response(200, json={"data": [{"index": i, "embedding": embed_text(t)}
                                                      for i, t in enumerate(body["input"])],
                                             "usage": {"prompt_tokens": 5}})
        prompt = "\n".join(m["content"] for m in body["messages"])
        self.calls.append({"kind": "chat", "model": model, "prompt": prompt})
        if model in self.fail:
            return httpx.Response(self.fail[model], json={"error": "scripted"})
        for marker, reply in self.rules:
            if marker in prompt:
                out = reply(body["messages"]) if callable(reply) else reply
                content = out if isinstance(out, str) else json.dumps(out)
                return httpx.Response(200, json={"choices": [{"message": {"content": content}}],
                                                 "usage": {"prompt_tokens": 10, "completion_tokens": 10}})
        return httpx.Response(200, json={"choices": [{"message": {"content": "{}"}}],
                                         "usage": {"prompt_tokens": 1, "completion_tokens": 1}})
