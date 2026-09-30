"""Structured LLM calls on top of the tier router.

LLMs extract, classify, plan and write. They never do arithmetic: every
number that reaches a client (price, quantity, total) comes from code.
`complete_json` enforces a Pydantic schema and repairs once on invalid output.
"""
from __future__ import annotations

import json
import re
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from kritvia_api.services.model_router import CallContext, ModelRouter

T = TypeVar("T", bound=BaseModel)

_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


class LLMOutputError(Exception):
    pass


def _extract_json(text: str) -> str:
    text = _FENCE.sub("", text.strip())
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        raise LLMOutputError("model did not return a JSON object")
    return text[start : end + 1]


def _schema_hint(model: type[BaseModel]) -> str:
    return json.dumps(model.model_json_schema(), separators=(",", ":"))


async def complete_json(
    router: ModelRouter,
    ctx: CallContext,
    *,
    tier: str,
    system: str,
    prompt: str,
    schema: type[T],
    sensitive: bool = False,
    temperature: float = 0.0,
) -> T:
    sys = (
        f"{system}\n\nRespond with ONE JSON object only, no prose, matching this JSON schema:\n"
        f"{_schema_hint(schema)}"
    )
    messages = [{"role": "system", "content": sys}, {"role": "user", "content": prompt}]
    last_error = ""
    for attempt in range(2):
        res = await router.chat(ctx, tier=tier, messages=messages, sensitive=sensitive,
                                temperature=temperature, response_format={"type": "json_object"})
        try:
            return schema.model_validate_json(_extract_json(res.content))
        except ValidationError as exc:
            # locations and messages only — never echo input values (they may be personal data)
            last_error = "; ".join(f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}"
                                   for e in exc.errors(include_input=False, include_url=False))[:800]
        except (LLMOutputError, ValueError) as exc:
            last_error = type(exc).__name__ + (": no JSON object" if isinstance(exc, LLMOutputError) else "")
        if last_error:
            messages = messages + [
                {"role": "assistant", "content": res.content[:4000]},
                {"role": "user", "content": f"That was invalid: {last_error}\nReturn corrected JSON only."},
            ]
    raise LLMOutputError(f"invalid structured output after repair: {last_error}")


async def complete_text(
    router: ModelRouter,
    ctx: CallContext,
    *,
    tier: str,
    system: str,
    prompt: str,
    sensitive: bool = False,
    temperature: float = 0.2,
    max_tokens: int | None = None,
) -> str:
    params = {"temperature": temperature}
    if max_tokens:
        params["max_tokens"] = max_tokens
    res = await router.chat(ctx, tier=tier, sensitive=sensitive,
                            messages=[{"role": "system", "content": system},
                                      {"role": "user", "content": prompt}], **params)
    return res.content.strip()
