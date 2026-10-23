from datetime import datetime
from functools import lru_cache
from pathlib import Path

from typing import Any

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict



def ancestor(path: str | Path, n: int) -> Path:
    """``parents[n]`` of *path*, or the filesystem root when the code is installed shallower than
    the repo layout (e.g. /app/kritvia_api in the Docker image), instead of raising IndexError."""
    parents = Path(path).resolve().parents
    return parents[min(n, len(parents) - 1)]


REPO_ROOT = ancestor(__file__, 3)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Kritvia API"
    environment: str = "development"

    # The API connects as kritvia_app (NOBYPASSRLS). Never point this at the owner role.
    database_url: str = "postgresql+asyncpg://kritvia_app:app@localhost:5432/kritvia"

    jwt_secret: str = Field(min_length=32, default="dev-only-secret-change-me-dev-only-secret")
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 60

    # base64-encoded 32-byte key-encryption key. Held on the VM for dogfooding;
    # replaced by the client's KMS in VPC deployments (see services/crypto.py).
    master_kek_b64: str = ""
    master_kek_id: str = "local-v1"

    # Deployments whose key no longer lets the provider train (billing on, opt-out set), comma-separated.
    ai_no_training_deployments: str = ""
    litellm_base_url: str = "http://localhost:4000"
    litellm_api_key: str = "sk-local-dev"
    tiers_config_path: Path = REPO_ROOT / "infra" / "litellm" / "tiers.yaml"
    # Sarvam speech-to-text (Indian languages); called directly by the API, not via LiteLLM.
    sarvam_api_key: str = ""
    sarvam_base_url: str = "https://api.sarvam.ai"
    # Speech server on this machine for phone calls (speaches: faster-whisper + Kokoro/Piper voices,
    # OpenAI-compatible), e.g. http://whisper:8000/v1 with the compose profile "speech". Empty = not offered.
    voice_local_url: str = ""

    allowed_origins: list[str] = ["http://localhost:3000"]
    public_api_url: str = "http://localhost:8000"
    public_web_url: str = "http://localhost:3000"

    refresh_token_days: int = 30
    auth_rate_limit_per_minute: int = 10
    client_ip_header: str = ""   # e.g. "cf-connecting-ip" when only reachable via Cloudflare Tunnel

    # Execution: 'arq' (Valkey queue, production), 'background' (in-process task,
    # single-process dev) or 'inline' (run to completion before returning; tests)
    dispatch_mode: str = "background"
    redis_url: str = "redis://localhost:6379/0"

    # Sandbox runner (services/sandbox). Empty -> LocalSandbox (dev only, not isolated).
    sandbox_url: str = ""
    sandbox_token: str = ""
    # Browser for the browser agent (services/browser). Empty URL or token -> the agent is off.
    browser_url: str = ""
    browser_token: str = ""
    # App store (patch 0095): the sandboxed MCP runner for reviewed apps from npm/PyPI/containers
    # (services/mcp-runner; empty URL -> hosted apps are off), and the official MCP Registry it lists.
    mcp_runner_url: str = ""
    mcp_runner_token: str = ""
    mcp_registry_url: str = "https://registry.modelcontextprotocol.io"

    # Outbound messages when a venture has no Google connector: 'log' records to the
    # outbox without sending (dogfooding); 'none' fails the step.
    messaging_fallback: str = "log"

    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = "http://localhost:3000/api/oauth/google/callback"  # the WEB app route
    # Kritvia's Slack app (api.slack.com/apps): lets a business add Kritvia to its Slack so team members
    # approve drafts from Slack. Empty: only the pasted incoming-webhook notices are offered.
    slack_client_id: str = ""
    slack_client_secret: str = ""
    slack_signing_secret: str = ""
    slack_redirect_uri: str = ""  # the WEB app route; empty = PUBLIC_WEB_URL + /api/oauth/slack/callback
    # Google Places API (New), used by the Prospector agent to find businesses on Maps. A server key
    # from Google Cloud (Places API (New) enabled, restricted to this server's IP). Empty: the
    # Prospector says it is not set up instead of searching.
    google_places_api_key: str = ""
    # Most new prospects any one venture may take from Maps in a day (cost and reputation guard).
    prospector_daily_cap: int = 25

    # WhatsApp Business (Meta Cloud API). The app secret verifies webhook signatures; the
    # verify token is what you type into Meta's webhook setup. Per-number tokens live in connectors.
    whatsapp_app_secret: str = ""
    whatsapp_verify_token: str = ""
    # Embedded Signup ("Connect WhatsApp" with a Facebook login): the Meta app's id (public) and the
    # Facebook Login for Business configuration id (WhatsApp Embedded Signup). Empty = only the manual form.
    meta_app_id: str = ""
    whatsapp_signup_config_id: str = ""

    # Plan for organisations without one (see plans.py). Tests use "internal".
    default_plan: str = "free"
    # When online payment went live. Until it is set, free trials don't end (nobody can pay yet);
    # after, a trial ends 15 days after sign-up or 3 days after this moment, whichever is later.
    payments_live_at: datetime | None = None
    # AI guardrails (services/model_router.py): one person's share of hosted AI per day (0 = no cap),
    # how often one person may call the AI, and the largest prompt and answer per call.
    ai_user_daily_tokens: int = 250_000
    # Fair share of the free AI pool (free tiers shared by every customer): the pool's daily size and the
    # least any organisation gets. Each organisation's share = pool / organisations using it today.
    # 0 = no fair-share limit.
    ai_free_pool_daily_tokens: int = 1_600_000
    ai_free_share_floor: int = 60_000
    ai_user_calls_per_minute: int = 30
    ai_max_prompt_chars: int = 600_000
    ai_max_output_tokens: int = 4096
    # Kill switch: AI_PAUSED=true in .env stops every AI call at once (runs try again by themselves after
    # 2, 10 and 60 minutes). Spend alert: the watchdog tells Kritvia's team when the last 24 hours of AI cost
    # pass this many US dollars (0 = no alert).
    ai_paused: bool = False
    ai_daily_spend_alert_usd: float = 10.0

    # Billing (Razorpay subscriptions). Plans are created once in the Razorpay dashboard;
    # their ids go here. Test-mode keys (rzp_test_...) work end to end without real money.
    razorpay_key_id: str = ""
    razorpay_key_secret: str = ""
    razorpay_webhook_secret: str = ""
    # Web push for "a draft needs your yes" (VAPID keys; generate with scripts/vapid-keys.py). Empty = off.
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = "mailto:support@sitelytc.com"
    # Razorpay plan ids, one per plan and billing period (create them in the Razorpay dashboard).
    razorpay_plan_starter: str = ""
    razorpay_plan_starter_annual: str = ""
    razorpay_plan_growth: str = ""
    razorpay_plan_growth_annual: str = ""
    razorpay_plan_scale: str = ""
    razorpay_plan_scale_annual: str = ""
    razorpay_plan_pro: str = ""          # before 2026–27; used for Growth monthly when RAZORPAY_PLAN_GROWTH is unset

    # Self-signup. Google sign-in reuses the Google client above (same redirect URI).
    signup_open: bool = True            # false: only existing accounts and invitees can sign in
    # Razorpay offer (Dashboard → Subscriptions → Offers: 10% off, first 3 billing cycles) applied when a
    # business signed up with a partner's code. Empty: no discount is applied at checkout.
    razorpay_partner_offer_id: str = ""
    # Kritvia's own team (comma-separated sign-in emails): they see Pilot health across organisations.
    # Empty (or unset) = the founder, FOUNDER_EMAIL below. STAFF_EMAILS in .env replaces that list.
    staff_emails: str = ""
    terms_version: str = "2026-10-23"   # Terms of Service + Privacy Policy in force; bump when they change
    email_code_minutes: int = Field(default=10, ge=5, le=15)   # sign-in and password-reset codes
    # System email for sign-in codes: smtp | log | memory (see services/mailer.py)
    mail_transport: str = "log"
    mail_from: str = "Kritvia <no-reply@sitelytc.com>"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    # Amazon SES bounce and complaint notifications (SNS topic -> https://api.<domain>/hooks/ses/feedback): the topic's ARN.
    # Empty: the endpoint is off. Addresses that hard-bounce or complain stop getting Kritvia's system email.
    ses_feedback_topic_arn: str = ""
    # Where Help-page messages are emailed (they are always stored too). Empty: stored only.
    support_inbox: str = ""
    # Sender identification in system emails (and shown on the website footer).
    company_legal_name: str = "Sitelytc Digital Media Private Limited"
    company_cin: str = "U63121DL2025PTC453508"
    company_address: str = ""          # registered office; set COMPANY_ADDRESS once confirmed
    support_email: str = "support@sitelytc.com"

    # Uploads
    max_upload_mb: int = 25

    # Email forwarding (migration 0031): businesses forward mail to <name>@INBOUND_EMAIL_DOMAIN; Cloudflare
    # Email Routing posts it to /public/email-in signed with INBOUND_EMAIL_SECRET. Both empty = off.
    # Plans whose Google connection asks for the restricted read scopes (Gmail read, all of Drive).
    google_read_plans: str = "internal"
    # Google Picker (choose Drive files with drive.file): a browser API key restricted to the web app's
    # address with the Picker API enabled, and the Google Cloud project number. Empty = picker hidden.
    google_picker_api_key: str = ""
    google_app_id: str = ""
    inbound_email_domain: str = ""
    inbound_email_secret: str = ""

    @property
    def slack_redirect(self) -> str:
        """Where Slack sends people back after "Add to Slack" (the web app's callback route)."""
        return self.slack_redirect_uri or f"{self.public_web_url.rstrip('/')}/api/oauth/slack/callback"

    @model_validator(mode="before")
    @classmethod
    def _empty_means_unset(cls, data: Any) -> Any:
        """A line like `PAYMENTS_LIVE_AT=` in .env means "not set", not "an empty date".

        Without this, an empty value for a date, number or true/false setting stops the API and
        worker from starting (7 Oct 2026). Plain text settings keep an empty value as written."""
        if not isinstance(data, dict):
            return data
        out = {}
        for key, value in data.items():
            field = cls.model_fields.get(str(key).lower())
            if (isinstance(value, str) and not value.strip() and field is not None
                    and field.annotation is not str):
                continue
            out[key] = value
        return out


# Kritvia's founder: on Kritvia's team (Pilot health, Partners) unless STAFF_EMAILS says otherwise.
FOUNDER_EMAIL = "smayankthakur25@gmail.com"


@lru_cache
def get_settings() -> Settings:
    return Settings()
