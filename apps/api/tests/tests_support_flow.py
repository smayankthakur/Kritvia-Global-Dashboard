"""A small purpose-built workflow used by engine and worker tests."""
from __future__ import annotations

from kritvia_api.engine.core import ApprovalRequest, Finish, Goto, Interrupt, Workflow, registry

EXECUTIONS: list[str] = []

if "test_flow" not in registry:
    wf = registry.register(Workflow("test_flow", title="Test flow", start="prepare"))

    @wf.step("prepare", agent="tester")
    async def prepare(ctx, state):
        return Goto("ask", update={"n": state["input"].get("n", 1)}, note="prepared")

    @wf.step("ask", agent="mailer")
    async def ask(ctx, state):
        return Interrupt(ApprovalRequest(agent="mailer", action="gmail.send", title="Send test",
                                         payload={"to": "x@example.com", "subject": "hi", "body": "hello"}),
                         resume="send")

    @wf.step("send", agent="mailer")
    async def send(ctx, state):
        res = await ctx.invoke("gmail.send", approval_id=state["decision"]["approval_id"])
        EXECUTIONS.append(state["decision"]["approval_id"])
        if state["input"].get("loop"):
            return Goto("ask", update={"loops": state.get("loops", 0) + 1}) if state.get("loops", 0) < 40 \
                else Finish("looped")
        return Finish("sent", note=res["status"])

    @wf.step("explode", agent="tester")
    async def explode(ctx, state):
        raise RuntimeError("boom")


