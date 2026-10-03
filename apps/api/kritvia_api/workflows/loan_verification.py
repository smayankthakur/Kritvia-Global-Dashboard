"""Loan document verification (loan DSAs, brokers and lenders; built first for Truhome Finance).

  load -> classify -> extract_fields -> check -> (complete | draft_followup
       -> [approval: gmail.send, loan_officer, sensitive] -> send_followup)

Hard rules:
* EVERY model call here uses tier 'private' with sensitive=True: the router
  refuses to send it anywhere but the local model.
* Checklists and pass/fail rules are per-venture configuration evaluated by code.
  The agent flags; the loan officer decides.
* Documents were OCR'd, PII-masked (Aadhaar/card numbers) and encrypted at
  upload; raw documents are visible only to the loan_officer role (DB policy).
* Processing requires a recorded, unwithdrawn consent for 'loan_processing'.
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta
from typing import Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.engine.context import RunContext
from kritvia_api.engine.core import ApprovalRequest, Finish, Goto, Interrupt, Workflow, registry
from kritvia_api.services.memory import TEXT_PURPOSE
from kritvia_api.services.pii import PAN
from kritvia_api.workflows.common import name_similarity, parse_date, today_ist

async def _authorize(conn, venture_id: uuid.UUID, inp: dict) -> None:
    """Only someone who can see the application (loan_officer, by DB policy) may start this."""
    try:
        app_id = uuid.UUID(str(inp.get("application_id")))
    except ValueError:
        raise LookupError("application not found") from None
    ok = (await conn.execute(text("SELECT 1 FROM loan_applications WHERE id = :a AND venture_id = :v"),
                             {"a": app_id, "v": venture_id})).first()
    if ok is None:
        raise LookupError("application not found")


wf = registry.register(Workflow(
    "loan_verification", title="Loan document verification", start="load", venture_kinds=("finance", "general"),
    authorize_input=_authorize,
    description="Classifies and extracts loan documents with the local model only, checks them against the "
                "lending checklist and drafts a follow-up listing exactly what is missing or mismatched."))

DOC_TYPES = ["pan_card", "aadhaar", "passport", "voter_id", "bank_statement", "salary_slip", "itr", "form16",
             "property_deed", "sale_agreement", "utility_bill", "photo", "other"]

DEFAULT_CHECKLIST = {
    "items": [
        {"doc_type": "pan_card", "label": "PAN card", "min_count": 1},
        {"doc_type": "aadhaar", "label": "Aadhaar (masked copy is fine)", "min_count": 1},
        {"doc_type": "bank_statement", "label": "Bank statements (last 6 months)", "min_count": 1,
         "max_age_days": 45},
        {"doc_type": "salary_slip", "label": "Salary slips (last 3 months)", "min_count": 3, "max_age_days": 100},
        {"doc_type": "itr", "label": "ITR (last 2 years)", "min_count": 2},
    ],
    "rules": [
        {"id": "name_consistent", "kind": "same_name", "severity": "high"},
        {"id": "dob_consistent", "kind": "same_field", "params": {"field": "dob"}, "severity": "high"},
        {"id": "pan_consistent", "kind": "same_field", "params": {"field": "pan"}, "severity": "high"},
        {"id": "pan_format", "kind": "pan_format", "severity": "medium"},
        {"id": "statement_covers_6m", "kind": "coverage_months",
         "params": {"doc_type": "bank_statement", "months": 6}, "severity": "medium"},
    ],
}


class Classification(BaseModel):
    doc_type: Literal[tuple(DOC_TYPES)]  # type: ignore[valid-type]
    confidence: float = Field(ge=0, le=1)


class DocFields(BaseModel):
    name: str | None = Field(default=None, description="person's full name as printed")
    father_name: str | None = None
    dob: str | None = Field(default=None, description="date of birth, YYYY-MM-DD")
    pan: str | None = Field(default=None, description="PAN exactly as printed")
    address: str | None = None
    document_date: str | None = Field(default=None, description="issue/statement/slip date, YYYY-MM-DD")
    period_start: str | None = Field(default=None, description="statement period start, YYYY-MM-DD")
    period_end: str | None = Field(default=None, description="statement period end, YYYY-MM-DD")
    employer: str | None = None
    bank_name: str | None = None
    account_holder: str | None = None
    assessment_year: str | None = None
    property_address: str | None = None


class SameName(BaseModel):
    same_person: bool
    reason: str


async def _doc_text(ctx: RunContext, conn, document_id: uuid.UUID, limit: int = 6000) -> str:
    rows = (await conn.execute(text("SELECT venture_id, text_enc FROM chunks WHERE document_id = :d ORDER BY ord"),
                               {"d": document_id})).all()
    out, size = [], 0
    crypto = ctx.crypto(conn)
    for r in rows:
        t = (await crypto.decrypt(r.venture_id, TEXT_PURPOSE, r.text_enc)).decode()
        out.append(t)
        size += len(t)
        if size > limit:
            break
    return "\n".join(out)[:limit]


@wf.step("load", agent="loan_intake")
async def load(ctx: RunContext, state: dict) -> Goto | Finish:
    app_id = uuid.UUID(state["input"]["application_id"])
    async with ctx.tx() as conn:
        app = (await conn.execute(text(
            "SELECT a.id, a.loan_type, a.reference, a.consent_id, a.data_principal,"
            " (SELECT c.withdrawn_at IS NULL FROM consents c WHERE c.id = a.consent_id"
            "   AND c.purpose = 'loan_processing' AND c.data_principal = a.data_principal) AS consent_ok"
            " FROM loan_applications a WHERE a.id = :id"), {"id": app_id})).first()
        if app is None:
            return Finish("application_not_found")
        if not app.consent_ok:
            ctx.note("no active consent for loan_processing — nothing processed")
            return Finish("blocked_no_consent", update={"summary": {"blocked": "consent"}})
        cl = (await conn.execute(text(
            "SELECT id, items, rules FROM document_checklists WHERE venture_id = :v AND loan_type = :t AND active"
            " ORDER BY version DESC LIMIT 1"), {"v": ctx.venture_id, "t": app.loan_type})).first()
        await conn.execute(text("UPDATE loan_applications SET status = 'verifying', last_run_id = :r,"
                                " updated_at = now(), checklist_id = :c WHERE id = :id"),
                           {"r": ctx.run_id, "c": cl.id if cl else None, "id": app_id})
    checklist = {"items": cl.items, "rules": cl.rules} if cl else DEFAULT_CHECKLIST
    if cl is None:
        ctx.note(f"no checklist configured for '{app.loan_type}'; using the default template")
    return Goto("classify", update={"application_id": str(app_id), "reference": app.reference,
                                    "checklist": checklist,
                                    "summary": {"reference": app.reference, "loan_type": app.loan_type}})


@wf.step("classify", agent="classifier")
async def classify(ctx: RunContext, state: dict) -> Goto:
    allowed = sorted({i["doc_type"] for i in state["checklist"]["items"]} | set(DOC_TYPES))
    n = 0
    async with ctx.tx() as conn:
        docs = (await conn.execute(text(
            "SELECT ld.id, ld.document_id, d.title FROM loan_documents ld JOIN documents d ON d.id = ld.document_id"
            " WHERE ld.application_id = :a AND ld.status = 'received' ORDER BY ld.created_at"),
            {"a": uuid.UUID(state["application_id"])})).all()
        texts = {d.id: await _doc_text(ctx, conn, d.document_id, 3000) for d in docs}
    for d in docs:
        c = await ctx.llm_json(
            tier="private", sensitive=True, schema=Classification,
            system=("Classify an Indian KYC / income / property document. Choose the single best doc_type from: "
                    + ", ".join(allowed)),
            prompt=f"Filename: {d.title}\n\n{texts[d.id]}")
        async with ctx.tx() as conn:
            await conn.execute(text("UPDATE loan_documents SET doc_type = :t, confidence = :c, status = 'classified'"
                                    " WHERE id = :id"), {"t": c.doc_type, "c": c.confidence, "id": d.id})
        n += 1
    return Goto("extract_fields", note=f"classified {n} document(s)")


@wf.step("extract_fields", agent="extraction")
async def extract_fields(ctx: RunContext, state: dict) -> Goto:
    n = 0
    async with ctx.tx() as conn:
        docs = (await conn.execute(text(
            "SELECT id, document_id, doc_type FROM loan_documents WHERE application_id = :a"
            " AND status = 'classified' ORDER BY created_at"), {"a": uuid.UUID(state["application_id"])})).all()
        texts = {d.id: await _doc_text(ctx, conn, d.document_id) for d in docs}
    for d in docs:
        f = await ctx.llm_json(
            tier="private", sensitive=True, schema=DocFields,
            system=(f"Extract fields from this {d.doc_type.replace('_', ' ')}. Copy values exactly as printed; "
                    "leave a field null if absent. Dates as YYYY-MM-DD."),
            prompt=texts[d.id])
        async with ctx.tx() as conn:
            enc = await ctx.crypto(conn).encrypt(ctx.venture_id, "loan_documents.fields", f.model_dump_json())
            await conn.execute(text("UPDATE loan_documents SET fields_enc = :f, status = 'extracted' WHERE id = :id"),
                               {"f": enc, "id": d.id})
        n += 1
    return Goto("check", note=f"extracted fields from {n} document(s)")


async def _confirm_same_person(ctx: RunContext, a: str, b: str) -> bool:
    r = await ctx.llm_json(tier="private", sensitive=True, schema=SameName,
                           system="Decide if two names printed on Indian documents refer to the same person "
                                  "(initials, order, spelling variants).",
                           prompt=f"Name A: {a}\nName B: {b}")
    return r.same_person


@wf.step("check", agent="rule_engine")
async def check(ctx: RunContext, state: dict) -> Goto | Finish:
    checklist, today = state["checklist"], today_ist()
    async with ctx.tx() as conn:
        rows = (await conn.execute(text(
            "SELECT id, doc_type, fields_enc FROM loan_documents WHERE application_id = :a AND status = 'extracted'"),
            {"a": uuid.UUID(state["application_id"])})).all()
        docs = []
        for r in rows:
            fields = json.loads(await ctx.crypto(conn).decrypt(ctx.venture_id, "loan_documents.fields", r.fields_enc))
            docs.append({"id": str(r.id), "doc_type": r.doc_type, "fields": fields})

    present: dict[str, int] = {}
    for d in docs:
        present[d["doc_type"]] = present.get(d["doc_type"], 0) + 1
    missing, stale, mismatches, passed = [], [], [], []
    doc_issues: dict[str, list[dict]] = {}

    for item in checklist["items"]:
        have = [d for d in docs if d["doc_type"] == item["doc_type"]]
        if item.get("max_age_days"):
            fresh = []
            for d in have:
                dt = parse_date(d["fields"].get("period_end") or d["fields"].get("document_date"))
                if dt and (today - dt).days > int(item["max_age_days"]):
                    stale.append({"doc_type": item["doc_type"], "label": item["label"], "document": d["id"],
                                  "age_days": (today - dt).days})
                    doc_issues.setdefault(d["id"], []).append({"code": "stale", "severity": "medium"})
                else:
                    fresh.append(d)
            have = fresh
        need = int(item.get("min_count", 1))
        if item.get("required", True) and len(have) < need:
            missing.append({"doc_type": item["doc_type"], "label": item["label"], "have": len(have), "need": need})

    person_docs = [d for d in docs if d["fields"].get("name") or d["fields"].get("account_holder")]
    for rule in checklist.get("rules", []):
        kind, rid, sev = rule["kind"], rule["id"], rule.get("severity", "medium")
        if kind == "same_name":
            names = [(d, d["fields"].get("name") or d["fields"].get("account_holder")) for d in person_docs]
            bad = []
            for i in range(1, len(names)):
                a, b = names[0][1], names[i][1]
                sim = name_similarity(a, b)
                same = sim >= 0.9 or (sim >= 0.6 and await _confirm_same_person(ctx, a, b))
                if not same:
                    bad.append(names[i][0]["id"])
            (mismatches.append({"rule": rid, "field": "name", "documents": [names[0][0]["id"], *bad],
                                "severity": sev}) if bad else passed.append(rid))
        elif kind == "same_field":
            field = rule["params"]["field"]
            vals = {}
            for d in docs:
                v = d["fields"].get(field)
                if v:
                    key = str(parse_date(v) or v).replace(" ", "").upper()
                    vals.setdefault(key, []).append(d["id"])
            (mismatches.append({"rule": rid, "field": field, "documents": [x for ids in vals.values() for x in ids],
                                "severity": sev}) if len(vals) > 1 else passed.append(rid))
        elif kind == "pan_format":
            bad = [d["id"] for d in docs if d["fields"].get("pan")
                   and not PAN.fullmatch(d["fields"]["pan"].replace(" ", "").upper())]
            (mismatches.append({"rule": rid, "field": "pan", "documents": bad, "severity": sev})
             if bad else passed.append(rid))
        elif kind == "coverage_months":
            p = rule["params"]
            spans = []
            for d in docs:
                if d["doc_type"] != p["doc_type"]:
                    continue
                s, e = parse_date(d["fields"].get("period_start")), parse_date(d["fields"].get("period_end"))
                if s and e and e >= s:
                    spans.append((s, e))
            covered = 0
            if spans:
                start, end = min(s for s, _ in spans), max(e for _, e in spans)
                covered = (end - start + timedelta(days=1)).days / 30.4
            if present.get(p["doc_type"]) and covered + 0.2 < int(p["months"]):
                mismatches.append({"rule": rid, "field": "period", "documents": [], "severity": sev,
                                   "detail": f"covers {covered:.1f} of {p['months']} months"})
            elif present.get(p["doc_type"]):
                passed.append(rid)
    for m in mismatches:
        for doc_id in m["documents"]:
            doc_issues.setdefault(doc_id, []).append({"code": m["rule"], "severity": m["severity"]})

    result = {"present": present, "missing": missing, "stale": stale, "mismatches": mismatches, "passed": passed,
              "checked_at": today.isoformat()}
    complete = not (missing or stale or mismatches)
    async with ctx.tx() as conn:
        await conn.execute(text("UPDATE loan_applications SET checklist_result = CAST(:r AS jsonb), status = :s,"
                                " updated_at = now() WHERE id = :id"),
                           {"r": json.dumps(result), "s": "complete" if complete else "needs_info",
                            "id": uuid.UUID(state["application_id"])})
        for doc_id, issues in doc_issues.items():
            await conn.execute(text("UPDATE loan_documents SET issues = CAST(:i AS jsonb) WHERE id = :id"),
                               {"i": json.dumps(issues), "id": uuid.UUID(doc_id)})
    summary = {**state.get("summary", {}), "missing": len(missing), "stale": len(stale),
               "mismatches": len(mismatches), "complete": complete}
    if complete:
        return Finish("complete", update={"result": result, "summary": summary},
                      note="all checklist items present and consistent")
    return Goto("draft_followup", update={"result": result, "summary": summary},
                note=f"{len(missing)} missing, {len(stale)} stale, {len(mismatches)} mismatch(es)")


FIELD_LABELS = {"name": "name", "dob": "date of birth", "pan": "PAN", "period": "statement period",
                "address": "address"}


def followup_items(result: dict[str, Any], docs_by_id: dict[str, str]) -> list[str]:
    items = [f"{m['label']}: {m['need'] - m['have']} more needed" if m["have"] else f"{m['label']}"
             for m in result["missing"]]
    items += [f"A more recent {s['label'].split('(')[0].strip().lower()} (the one we have is {s['age_days']} days old)"
              for s in result["stale"]]
    for m in result["mismatches"]:
        label = FIELD_LABELS.get(m["field"], m["field"])
        where = ", ".join(sorted({docs_by_id.get(d, "a document").replace("_", " ") for d in m["documents"]}))
        if m["field"] == "period":
            items.append(f"Bank statements covering the full period ({m.get('detail', '')})")
        elif m["rule"] == "pan_format":
            items.append(f"A clearer copy of the PAN card (the PAN could not be read correctly on: {where})")
        else:
            items.append(f"Clarification: the {label} differs across your documents ({where})")
    return items


@wf.step("draft_followup", agent="loan_followup")
async def draft_followup(ctx: RunContext, state: dict) -> Interrupt | Finish:
    async with ctx.tx() as conn:
        app = (await conn.execute(text("SELECT applicant_enc FROM loan_applications WHERE id = :id"),
                                  {"id": uuid.UUID(state["application_id"])})).first()
        applicant = json.loads(await ctx.crypto(conn).decrypt(ctx.venture_id, "loan_applications.applicant",
                                                              app.applicant_enc))
        docs = (await conn.execute(text("SELECT id, doc_type FROM loan_documents WHERE application_id = :a"),
                                   {"a": uuid.UUID(state["application_id"])})).all()
    items = followup_items(state["result"], {str(d.id): d.doc_type or "document" for d in docs})
    if not applicant.get("email"):
        ctx.note("applicant has no email on file; follow-up must be sent manually")
        return Finish("needs_info_manual")
    bullet = "\n".join(f"• {i}" for i in items)
    biz = await ctx.business()
    greeting = await ctx.llm_text(
        tier="private", sensitive=True, max_tokens=200,
        system=(f"Write a 2-sentence warm, professional opening for an email from {biz.name} asking a loan "
                "applicant for a few more documents. No list, no sign-off, no document names."),
        prompt=f"Applicant first name: {applicant.get('name', '').split(' ')[0] or 'there'}")
    body = (f"{greeting.strip()}\n\nTo continue with your application ({state['reference']}), we need:\n\n{bullet}\n\n"
            "You can reply to this email with the documents attached, or use the secure upload link your loan "
            f"officer shares.\n\nRegards,\n{biz.sign_off}")
    return Interrupt(
        ApprovalRequest(
            agent="loan_followup", action="gmail.send", key="followup_decision", sensitive=True,
            required_roles=("loan_officer",), expires_in_hours=120,
            title=f"Request missing documents — {state['reference']}",
            summary=f"{len(items)} item(s): " + "; ".join(i[:60] for i in items[:4]),
            payload={"to": applicant["email"], "subject": f"Documents needed for your application {state['reference']}",
                     "body": body}),
        resume="send_followup")


@wf.step("send_followup", agent="loan_followup")
async def send_followup(ctx: RunContext, state: dict) -> Finish:
    res = await ctx.invoke("gmail.send", approval_id=state["followup_decision"]["approval_id"])
    return Finish("followup_sent", note=f"follow-up {res.get('status')} via {res.get('transport')}")
