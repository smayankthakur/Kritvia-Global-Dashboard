from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

Slug = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,62}$")


class RegisterIn(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=12, max_length=256)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int = 3600
    refresh_token: str | None = None


class RefreshIn(BaseModel):
    refresh_token: str = Field(min_length=20, max_length=200)


class PasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=12, max_length=256)


class MeOut(BaseModel):
    id: uuid.UUID
    email: str
    full_name: str


class OrgIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    slug: str = Slug


class VentureIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    slug: str = Slug


class IdOut(BaseModel):
    id: uuid.UUID


class VentureOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    org_id: uuid.UUID
    name: str
    slug: str


class MemberIn(BaseModel):
    user_email: EmailStr
    role: str
    venture_id: uuid.UUID | None = None


class GrantIn(BaseModel):
    user_email: EmailStr
    venture_id: uuid.UUID
    access: Literal["read", "write"]
    reason: str = Field(min_length=3, max_length=300)
    expires_at: datetime | None = None


class LeadIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: EmailStr | None = None
    company: str | None = Field(default=None, max_length=200)
    source: str = Field(default="manual", max_length=50)
    notes: str | None = Field(default=None, max_length=20_000)


class LeadPatch(BaseModel):
    status: Literal["new", "qualified", "proposal", "won", "lost", "archived"] | None = None
    score: int | None = Field(default=None, ge=0, le=100)
    notes: str | None = Field(default=None, max_length=20_000)


class LeadOut(BaseModel):
    id: uuid.UUID
    venture_id: uuid.UUID
    name: str
    email: str | None
    company: str | None
    source: str
    status: str
    score: int | None
    notes: str | None
    created_at: datetime
    phone: str | None = None
    priority: str | None = None
    budget_inr: Decimal | None = None
    timeline: str | None = None
    score_reasons: list[dict] = []
    inquiry_count: int = 1
    last_inquiry_at: datetime | None = None
    last_run_id: uuid.UUID | None = None
    details: dict | None = None


class AuditOut(BaseModel):
    seq: int
    occurred_at: datetime
    venture_id: uuid.UUID | None
    actor_type: str
    actor_user_id: uuid.UUID | None
    action: str
    entity_table: str | None
    entity_id: str | None
    details: dict


class AuditVerifyOut(BaseModel):
    org_id: uuid.UUID
    intact: bool
    first_broken_seq: int | None
