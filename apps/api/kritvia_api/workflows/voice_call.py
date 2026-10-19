"""AI phone call to a customer (services/voice_calls.py has the call itself and its rules).

    ask       the call to approve: who, why, and the exact opening line (it says it is the business's AI
              assistant). Always reviewed by a person; the number can't be changed.
    dial      after the yes: dialled (when the business has recorded its DLT registration and switched
              outbound calling on), otherwise a test call to answer in the app
    rejected  no call
"""
from __future__ import annotations

from kritvia_api.engine.context import RunContext
from kritvia_api.engine.core import ApprovalRequest, Finish, Interrupt, Workflow, registry

wf = registry.register(Workflow(
    "voice_call", title="AI phone calls", start="ask", trigger="When you ask Kritvia to call a customer",
    description="Kritvia's AI assistant phones a customer for you (a reminder, a callback they asked for) after "
                "your yes, and answers your business number. Calls say they are from an AI assistant.", starts="request"))


@wf.step("ask", agent="voice")
async def ask(ctx: RunContext, state: dict) -> Interrupt | Finish:
    from kritvia_api.services import twilio_voice as tw
    from kritvia_api.services import voice_calls as vc
    inp = state["input"]
    phone = tw.normalise_phone(str(inp.get("phone") or ""))
    purpose = " ".join(str(inp.get("purpose") or "").split())[:300]
    if phone is None or len(purpose) < 3:
        return Finish("not_done", update={"answer": "A call needs a phone number and what it is about."})
    async with ctx.tx() as conn:
        s = await vc.settings_for(conn, ctx.venture_id)
        name, _ = await vc.business_line(conn, ctx.venture_id)
    callee = (str(inp.get("name") or "").strip() or None)
    opening = vc.outbound_opening(name, s, callee, purpose)
    return Interrupt(
        ApprovalRequest(agent="voice", action="voice.call", key="decision",
                        title=f"Phone {callee or tw.mask(phone)}"[:140], summary=purpose,
                        payload={"phone": phone, "name": callee, "purpose": purpose, "opening": opening},
                        required_roles=("approver", "venture_admin"), always_review=True),
        resume="dial", on_reject="rejected", note="a call waits for approval")


@wf.step("dial", agent="voice")
async def dial(ctx: RunContext, state: dict) -> Finish:
    d = state.get("decision") or {}
    try:
        res = await ctx.invoke("voice.call", approval_id=d["approval_id"])
    except Exception as exc:  # noqa: BLE001 - told to the person; nothing is retried by itself
        return Finish("not_done", update={"answer": f"You said yes, but the call wasn't made: {str(exc)[:300]}"},
                      note="call not made")
    return Finish("answered", update={"answer": res.get("note"), "call_id": res.get("call_id"),
                                      "summary": {"test": bool(res.get("test"))}},
                  note="test call" if res.get("test") else "call placed")


@wf.step("rejected", agent="voice")
async def rejected(ctx: RunContext, state: dict) -> Finish:
    return Finish("not_done", update={"answer": "Okay, no call."}, note="call not approved")
