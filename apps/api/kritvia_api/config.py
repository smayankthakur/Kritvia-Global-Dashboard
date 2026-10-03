from functools import lru_cache
from pathlib import Path

from pydantic import Field
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

    litellm_base_url: str = "http://localhost:4000"
    litellm_api_key: str = "sk-local-dev"
    tiers_config_path: Path = REPO_ROOT / "infra" / "litellm" / "tiers.yaml"
    # Sarvam speech-to-text (Indian languages); called directly by the API, not via LiteLLM.
    sarvam_api_key: str = ""
    sarvam_base_url: str = "https://api.sarvam.ai"

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

    # Outbound messages when a venture has no Google connector: 'log' records to the
    # outbox without sending (dogfooding); 'none' fails the step.
    messaging_fallback: str = "log"

    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = "http://localhost:3000/api/oauth/google/callback"  # the WEB app route

    # Plan for organisations without one (see plans.py). Tests use "internal".
    default_plan: str = "free"

    # Billing (Razorpay subscriptions). Plans are created once in the Razorpay dashboard;
    # their ids go here. Test-mode keys (rzp_test_...) work end to end without real money.
    razorpay_key_id: str = ""
    razorpay_key_secret: str = ""
    razorpay_webhook_secret: str = ""
    razorpay_plan_starter: str = ""
    razorpay_plan_pro: str = ""

    # Self-signup. Google sign-in reuses the Google client above (same redirect URI).
    signup_open: bool = True            # false: only existing accounts and invitees can sign in
    email_code_minutes: int = 10
    # System email for sign-in codes: smtp | log | memory (see services/mailer.py)
    mail_transport: str = "log"
    mail_from: str = "Kritvia <no-reply@sitelytc.com>"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""

    # Uploads
    max_upload_mb: int = 25


@lru_cache
def get_settings() -> Settings:
    return Settings()
