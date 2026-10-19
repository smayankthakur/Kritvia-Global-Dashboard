"""The cash position ahead (services/cash.py) and its settings.

  GET /ventures/{v}/cash/forecast     thirteen weeks ahead, and the next 30/60/90 days
  GET /ventures/{v}/cash/settings     the typed balance, fixed costs, warning level, statements by email
  PUT /ventures/{v}/cash/settings     change them (the statement password only by admins; it is never shown back)
"""
from __future__ import annotations

import uuid
from datetime import date

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.routers.bank import can_write
from kritvia_api.services import cash

router = APIRouter(tags=["cash"])

PAISE = Field(default=None, ge=0, le=100_000_000_000)


class CashWeekOut(BaseModel):
    start: date
    end: date
    in_paise: int
    out_paise: int
    closing_paise: int


class CashHorizonOut(BaseModel):
    days: int
    in_paise: int
    out_paise: int
    closing_paise: int


class CashForecastOut(BaseModel):
    today: date
    opening_paise: int | None
    opening_on: date | None
    opening_from: str | None = Field(description="'statement' or 'typed'")
    weeks: list[CashWeekOut]
    horizons: list[CashHorizonOut]
    lowest_paise: int
    lowest_week: date
    below_alert: bool
    alert_below_paise: int | None
    usual_late_days: int
    doubtful_paise: int
    doubtful_invoices: int
    salaries_paise: int
    fixed_paise: int
    notes: list[str]


class CashSettingsOut(BaseModel):
    balance_paise: int | None
    balance_on: date | None
    monthly_fixed_paise: int
    alert_below_paise: int | None
    statements_by_email: bool
    has_statement_password: bool


class CashSettingsIn(BaseModel):
    balance_paise: int | None = Field(default=None, ge=-100_000_000_000, le=100_000_000_000)
    balance_on: date | None = None
    clear_balance: bool = False
    monthly_fixed_paise: int | None = PAISE
    alert_below_paise: int | None = PAISE
    clear_alert: bool = False
    statements_by_email: bool | None = None
    statement_password: str | None = Field(default=None, max_length=64,
                                           description="the bank's statement PDF password; '' removes it")


@router.get("/ventures/{venture_id}/cash/forecast", response_model=CashForecastOut)
async def get_forecast(venture_id: uuid.UUID, db: TenantDB) -> CashForecastOut:
    await venture_org(db, venture_id)
    return CashForecastOut(**(await cash.forecast(db, venture_id)).as_dict())


async def _settings(db, venture_id: uuid.UUID) -> CashSettingsOut:
    s = (await db.execute(text("SELECT * FROM cash_settings WHERE venture_id = :v"), {"v": venture_id})).first()
    if s is None:
        return CashSettingsOut(balance_paise=None, balance_on=None, monthly_fixed_paise=0, alert_below_paise=None,
                               statements_by_email=True, has_statement_password=False)
    return CashSettingsOut(balance_paise=s.balance_paise, balance_on=s.balance_on,
                           monthly_fixed_paise=s.monthly_fixed_paise, alert_below_paise=s.alert_below_paise,
                           statements_by_email=s.statements_by_email,
                           has_statement_password=s.statement_password_enc is not None)


@router.get("/ventures/{venture_id}/cash/settings", response_model=CashSettingsOut)
async def get_settings_(venture_id: uuid.UUID, db: TenantDB) -> CashSettingsOut:
    await venture_org(db, venture_id)
    return await _settings(db, venture_id)


@router.put("/ventures/{venture_id}/cash/settings", response_model=CashSettingsOut)
async def put_settings(venture_id: uuid.UUID, body: CashSettingsIn, user_id: UserId, db: TenantDB,
                       svc: Svc) -> CashSettingsOut:
    from kritvia_api.services.crypto import EnvelopeCrypto
    from kritvia_api.workflows.common import IST
    org = await venture_org(db, venture_id)
    await can_write(db, venture_id)
    await db.execute(text("INSERT INTO cash_settings (venture_id, org_id) VALUES (:v, :o) ON CONFLICT DO NOTHING"),
                     {"v": venture_id, "o": org})
    sets: dict[str, object] = {}
    if body.clear_balance:
        sets |= {"balance_paise": None, "balance_on": None}
    elif body.balance_paise is not None:
        from datetime import datetime
        on = body.balance_on or datetime.now(IST).date()
        if on > datetime.now(IST).date():
            raise HTTPException(422, "the balance date can't be in the future")
        sets |= {"balance_paise": body.balance_paise, "balance_on": on}
    if body.monthly_fixed_paise is not None:
        sets["monthly_fixed_paise"] = body.monthly_fixed_paise
    if body.clear_alert:
        sets["alert_below_paise"] = None
    elif body.alert_below_paise is not None:
        sets["alert_below_paise"] = body.alert_below_paise
    if body.statements_by_email is not None:
        sets["statements_by_email"] = body.statements_by_email
    if body.statement_password is not None:
        if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
            raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can save the statement password")
        pw = body.statement_password.strip()
        sets["statement_password_enc"] = (await EnvelopeCrypto(db, svc.keys).encrypt(
            venture_id, "cash.statement_password", pw)) if pw else None
    if sets:
        cols = ", ".join(f"{k} = :{k}" for k in sets)
        await db.execute(text(f"UPDATE cash_settings SET {cols}, updated_by = :u, updated_at = now()"  # noqa: S608
                              " WHERE venture_id = :v"), {**sets, "u": user_id, "v": venture_id})
    return await _settings(db, venture_id)
