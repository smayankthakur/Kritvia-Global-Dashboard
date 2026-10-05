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


class EmailStartIn(BaseModel):
    email: EmailStr


class EmailStartOut(BaseModel):
    sent: bool = True
    expires_in: int = Field(description="seconds the code stays valid")


class PasswordResetIn(BaseModel):
    email: EmailStr
    code: str = Field(pattern=r"^\d{6}$")
    new_password: str = Field(min_length=12, max_length=256)


class EmailVerifyIn(BaseModel):
    email: EmailStr
    code: str = Field(pattern=r"^\d{6}$")
    full_name: str = Field(default="", max_length=120, description="used only when this creates the account")


class GoogleSigninStartIn(BaseModel):
    nonce: str = Field(min_length=32, max_length=128,
                       description="random value the web app also keeps in an httpOnly cookie")


class GoogleSigninCompleteIn(BaseModel):
    code: str = Field(min_length=1, max_length=2000)
    state: str = Field(min_length=1, max_length=4000)
    nonce: str = Field(min_length=32, max_length=128)


class SigninUrlOut(BaseModel):
    url: str


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
    terms_version: str | None = Field(default=None, description="version of the Terms and Privacy Policy accepted")
    terms_current: str = Field(description="the version in force; ask the person to accept it when they differ")


class TermsIn(BaseModel):
    version: str = Field(min_length=1, max_length=32)
    adult: bool = Field(default=False, description="the person confirms they are 18 or older (required)")


class OrgIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    slug: str = Slug


class VentureIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    slug: str = Slug
    kind: Literal["general", "software", "finance", "kitchen"] | None = None


class IdOut(BaseModel):
    id: uuid.UUID


class VentureOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    org_id: uuid.UUID
    name: str
    slug: str
    kind: str = "general"


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


LeadStatus = Literal["new", "contacted", "replied", "qualified", "proposal", "won", "lost", "archived"]


class LeadPatch(BaseModel):
    status: LeadStatus | None = None
    email: EmailStr | None = Field(default=None, description="e.g. a prospect's email you found; "
                                                              "the Prospector emails them from then on")
    name: str | None = Field(default=None, min_length=1, max_length=200,
                             description="e.g. a prospect's name as they gave it to you when they replied")
    phone: str | None = Field(default=None, max_length=30)
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
    # Prospects (source 'prospector'). Only the Google place ID is stored; `place` is looked up live.
    place_id: str | None = None
    place_search: str | None = None
    website_kind: str | None = Field(default=None, description="none | social | listing | own")
    place: "PlaceOut | None" = Field(default=None, description="live from Google Maps (single lead, or list?live=true)")
    place_error: str | None = None
    outreach_step: int = 0
    next_touch_at: datetime | None = None
    last_touch_at: datetime | None = None
    last_touch_channel: str | None = None
    replied_at: datetime | None = None
    opted_out_at: datetime | None = None
    outreach_draft: str | None = Field(default=None, description="WhatsApp message waiting for your one-tap send")
    whatsapp_link: str | None = Field(default=None, description="wa.me link that opens WhatsApp with the message")


class PlaceOut(BaseModel):
    """A business as Google Maps shows it right now. Never stored (Google Maps Platform terms)."""
    name: str
    phone: str | None = None
    address: str | None = None
    website: str | None = None
    rating: float | None = None
    review_count: int | None = None
    category: str | None = None
    maps_url: str | None = None
    status: str | None = None


LeadOut.model_rebuild()


class LeadOutreachIn(BaseModel):
    action: Literal["whatsapp_sent", "called", "replied", "skip", "resume", "opt_out"]


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
