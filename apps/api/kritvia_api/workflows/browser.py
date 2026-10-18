"""Browser agent: give it a job on the web in plain words ("find the GST rate for printed cartons on the
CBIC site", "send our enquiry for 200 kg of basmati through the form on example.com") and it uses the
locked-down browser to do it (services/browser_agent.py has the loop and the rules).

    browse   look things up, one action at a time (pages are only read); end with an answer, or with a
             form to send
    (form)   an approval showing the page, every field and value, and the button; nothing is sent
             before a yes, and it can't be edited (reject with a comment instead)
    sent     after the yes: the form is sent exactly as approved on a fresh page; the run reports what
             the website said next
    rejected nothing is sent

Run summaries hold counts only; the job, the pages and the answer stay in the encrypted run state.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from kritvia_api.engine.context import RunContext
from kritvia_api.engine.core import ApprovalRequest, Finish, Interrupt, Workflow, registry

MAX_ACTIONS = 15

wf = registry.register(Workflow(
    "browser", title="Browser agent", start="browse", trigger="When you give it a job",
    description="Uses websites for you on a locked-down browser: looks things up and fills in forms. A form is "
                "sent only after your yes; it never signs in, pays or types passwords."))


def _host(url: str | None) -> str:
    return (urlsplit(url or "").hostname or "the website").removeprefix("www.")


@wf.step("browse", agent="browser")
async def browse(ctx: RunContext, state: dict) -> Finish | Interrupt:
    from kritvia_api.services import browser_agent as ba
    inp = state["input"]
    try:
        out = await ba.browse(ctx, ctx.services.browser, inp["task"], inp.get("url"), max_actions=MAX_ACTIONS,
                              may_submit=True)
    except ba.BrowserError as exc:
        return Finish("not_done", update={"answer": f"I couldn't use the browser: {exc}", "sources": [],
                                          "summary": {"steps": 0}}, note="browser not available")
    summary: dict[str, Any] = {"steps": out.steps, "pages": len(out.sources)}
    if out.proposal is None:
        return Finish("answered", update={"answer": out.answer, "sources": out.sources, "log": out.log,
                                          "summary": summary}, note=f"answered after {out.steps} step(s)")
    p = out.proposal
    return Interrupt(
        ApprovalRequest(agent="browser", action="browser.submit", key="decision",
                        title=f"Send the form on {_host(p['url'])}"[:140],
                        summary=f"{len(p['fields'])} field(s), then \"{p['button']['label']}\" on {p['page_title'] or p['url']}"[:300],
                        payload=p, required_roles=("approver", "venture_admin"), always_review=True),
        resume="sent", on_reject="rejected",
        update={"sources": out.sources, "log": out.log, "summary": {**summary, "form": True}},
        note="a form waits for approval")


@wf.step("sent", agent="browser")
async def sent(ctx: RunContext, state: dict) -> Finish:
    d = state.get("decision") or {}
    try:
        res = await ctx.invoke("browser.submit", approval_id=d["approval_id"])
    except Exception as exc:  # noqa: BLE001 - reported to the person; nothing is retried by itself
        return Finish("not_done", update={"answer": f"You said yes, but sending didn't work: {str(exc)[:300]}"},
                      note="form not sent")
    said = " ".join((res.get("text") or "").split())[:400]
    answer = f"Sent. {_host(res.get('url'))} then showed: {said}" if said else "Sent."
    sources = list(dict.fromkeys([*(state.get("sources") or []), res.get("url") or ""]))
    return Finish("answered", update={"answer": answer, "sources": [s for s in sources if s][:8],
                                      "summary": {**(state.get("summary") or {}), "sent": True}},
                  note="form sent after approval")


@wf.step("rejected", agent="browser")
async def rejected(ctx: RunContext, state: dict) -> Finish:
    comment = ((state.get("decision") or {}).get("comment") or "").strip()[:300]
    answer = "Okay, the form wasn't sent." + (f" Your note: {comment}" if comment else "")
    return Finish("not_done", update={"answer": answer, "summary": {**(state.get("summary") or {}), "sent": False}},
                  note="form not approved")
