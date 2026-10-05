"""Plans and their limits (pricing 2026–27). Prices are in rupees, before 18% GST.

AI usage is counted in tokens sent to hosted models this calendar month (IST). Local models
(on your own server) are never counted. When a workspace runs out, Kritvia keeps working on
the local model where the tier has one, and stops only steps that need a hosted model.

What a plan unlocks:
  agents        "core"  = inbox assistant, lead triage & proposals, meeting digests;
                "kind"  = core + the agent for the business's own kind (loans for a finance
                          business, the nightly plan for a kitchen);
                "all"   = every agent on every business.
  integrations  which connectors may be used (Gmail and the website form are always on).
  autonomy      None = agents always ask; 1 = each agent may act alone on one kind of action;
                0 = no cap (the field holds the per-agent cap, 0 meaning unlimited).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

GB = 1024 ** 3
MB = 1024 ** 2

CORE_AGENTS = frozenset({"inbox_assistant", "lead_triage", "meeting_digest"})
KIND_AGENT = {"finance": "loan_verification", "kitchen": "kitchen_daily"}
AGENT_NAMES = {"inbox_assistant": "Inbox assistant", "lead_triage": "Lead triage & proposals",
               "meeting_digest": "Meeting digests", "loan_verification": "Loan document checks",
               "kitchen_daily": "Nightly kitchen plan"}
INTEGRATION_NAMES = {"gmail": "Gmail", "lead_form": "Website lead form", "calendar": "Google Calendar",
                     "drive": "Google Drive", "whatsapp": "WhatsApp Business", "tally": "Tally"}
BASIC = frozenset({"gmail", "lead_form"})
STANDARD = BASIC | {"calendar", "drive", "whatsapp"}
ALL = STANDARD | {"tally"}


@dataclass(frozen=True)
class Plan:
    code: str
    name: str
    price_inr: int                          # per month, billed monthly
    price_annual_inr: int | None            # per year, billed yearly (two months free)
    monthly_tokens: int | None              # None = unlimited
    max_ventures: int | None
    max_members: int | None
    storage_bytes: int | None               # business memory (documents, recordings)
    proposals_per_month: int | None         # None = unlimited
    agents: Literal["core", "kind", "all"]
    integrations: frozenset[str]
    autonomy_per_agent: int | None          # None = never; 0 = unlimited; n = n actions per agent
    analytics: Literal["basic", "advanced"]
    tagline: str = ""
    audience: str = ""
    highlights: tuple[str, ...] = ()
    featured: bool = False
    support: Literal["email", "priority", "dedicated"] = "email"
    extras: tuple[str, ...] = field(default=())
    # Announced but not yet available: shown on the pricing page as "Coming soon" and not part
    # of what a paid plan includes until released (Terms 10.2).
    coming_soon: tuple[str, ...] = ()

    @property
    def autonomy(self) -> bool:
        return self.autonomy_per_agent is not None

    def allows_agent(self, workflow: str, kind: str | None) -> bool:
        if self.agents == "all" or workflow in CORE_AGENTS:
            return True
        return self.agents == "kind" and KIND_AGENT.get(kind or "general") == workflow

    def allows_integration(self, name: str) -> bool:
        return name in self.integrations

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code, "name": self.name, "price_inr": self.price_inr,
                "price_annual_inr": self.price_annual_inr, "monthly_tokens": self.monthly_tokens,
                "max_ventures": self.max_ventures, "max_members": self.max_members,
                "storage_bytes": self.storage_bytes, "proposals_per_month": self.proposals_per_month,
                "agents": self.agents, "integrations": sorted(self.integrations),
                "autonomy": self.autonomy, "autonomy_per_agent": self.autonomy_per_agent,
                "analytics": self.analytics, "tagline": self.tagline, "audience": self.audience,
                "highlights": list(self.highlights), "featured": self.featured, "support": self.support,
                "extras": list(self.extras), "coming_soon": list(self.coming_soon)}


PLANS: dict[str, Plan] = {
    "free": Plan(
        "free", "Free", 0, None, 300_000, 1, 2, 500 * MB, 10, "core", BASIC, None, "basic",
        tagline="For exploring Kritvia.", audience="See what agents can do for your business",
        highlights=("1 business, 2 people", "Inbox assistant and lead triage", "10 proposals a month",
                    "Agents always ask before acting", "Business memory up to 500 MB", "Gmail and website lead form")),
    "starter": Plan(
        "starter", "Starter", 2499, 24_990, 3_000_000, 1, 5, 10 * GB, None, "kind", STANDARD, 1, "basic",
        tagline="For individuals and small businesses.", audience="Solo founders and micro-businesses",
        highlights=("1 business, 5 people", "Inbox, lead and proposal agents", "The agent for your kind of business",
                    "Calendar, Google Drive and WhatsApp", "Each agent can earn one action it does alone",
                    "10 GB business memory"),
        coming_soon=("Basic analytics",)),
    "growth": Plan(
        "growth", "Growth", 6999, 69_990, 15_000_000, 3, 15, 50 * GB, None, "all", ALL, 0, "advanced",
        tagline="For businesses automating daily operations.", audience="Agencies, consultants and growing SMBs",
        highlights=("3 businesses, 15 people", "Every agent: inbox, lead, proposal, document and kitchen",
                    "Autonomous actions and approval policies", "All integrations, including Tally",
                    "50 GB business memory", "Priority support"),
        featured=True, support="priority", coming_soon=("Advanced analytics",)),
    "scale": Plan(
        "scale", "Scale", 14_999, 1_49_990, 50_000_000, 10, 50, 250 * GB, None, "all", ALL, 0, "advanced",
        tagline="For growing teams and multiple businesses.", audience="Serious SMBs and multi-team companies",
        highlights=("10 businesses, 50 people", "All agents and all integrations",
                    "Autonomous actions and approval policies", "Advanced permissions and audit logs",
                    "250 GB business memory", "Priority support"),
        support="priority", extras=("custom_workflows", "api_access", "priority_processing"),
        coming_soon=("Custom workflows", "Advanced analytics", "API access", "Priority processing")),
    "enterprise": Plan(
        "enterprise", "Enterprise", 29_999, None, None, None, None, None, None, "all", ALL, 0, "advanced",
        tagline="Talk to us.", audience="Custom businesses, users and AI usage",
        highlights=("Unlimited or custom businesses", "100+ people", "Custom agents built for you",
                    "Role-based access control", "Dedicated environment and SLA", "Onboarding and data migration",
                    "Dedicated success manager"),
        support="dedicated", extras=("custom_workflows", "api_access", "priority_processing", "sso", "sla"),
        coming_soon=("API access", "Single sign-on (SSO)")),
    "internal": Plan(
        "internal", "Internal", 0, None, None, None, None, None, None, "all", ALL, 0, "advanced", support="dedicated"),
}
# The four plans on the pricing page, plus Enterprise ("Talk to us").
PUBLIC_PLANS = ("free", "starter", "growth", "scale", "enterprise")
SELF_SERVE = ("starter", "growth", "scale")
LEGACY = {"pro": "growth"}   # plan codes from before 2026–27

# Extra hosted-AI usage, bought as packs (valid for the month they are bought in).
TOKEN_PACKS = (
    {"code": "pack_5m", "tokens": 5_000_000, "price_inr": 1499},
    {"code": "pack_20m", "tokens": 20_000_000, "price_inr": 4999},
    {"code": "pack_50m", "tokens": 50_000_000, "price_inr": 9999},
)


def plan(code: str | None) -> Plan:
    code = LEGACY.get(code or "", code)
    return PLANS.get(code or "free", PLANS["free"])
