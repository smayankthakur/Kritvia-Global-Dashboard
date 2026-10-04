"""Build the process-wide Services from settings (API and worker share this)."""
from __future__ import annotations

from kritvia_api.config import get_settings
from kritvia_api.engine.context import Services
from kritvia_api.engine.dispatch import ArqDispatcher, InlineDispatcher
from kritvia_api.services.crypto import LocalKeyProvider
from kritvia_api.services.google import GoogleClient
from kritvia_api.services.messaging import Messaging
from kritvia_api.services.model_router import ModelRouter, TierConfig
from kritvia_api.services.sandbox import HttpSandbox, LocalSandbox
from kritvia_api.services.whatsapp import WhatsAppClient


def build_services(*, dispatch_mode: str | None = None, router: ModelRouter | None = None,
                   sandbox=None, google: GoogleClient | None = None,
                   whatsapp: WhatsAppClient | None = None) -> Services:
    s = get_settings()
    from kritvia_api.tools import build_tools
    import kritvia_api.workflows  # noqa: F401  (registers workflows)
    from kritvia_api.engine.core import registry
    registry.validate_all()

    if router is None:
        # A free-tier key may let the provider train on inputs; once the owner turns on billing or the
        # provider's opt-out, AI_NO_TRAINING_DEPLOYMENTS lists those deployments (e.g. gemini-flash).
        no_train = [d.strip() for d in s.ai_no_training_deployments.split(",") if d.strip()]
        config = TierConfig.load(s.tiers_config_path).with_policies(no_train, "no_training")
        router = ModelRouter(config, s.litellm_base_url, s.litellm_api_key,
                             sarvam_api_key=s.sarvam_api_key, sarvam_base_url=s.sarvam_base_url)
    if sandbox is None:
        sandbox = HttpSandbox(s.sandbox_url, s.sandbox_token) if s.sandbox_url else LocalSandbox(s.environment)
    google = google or GoogleClient(s.google_client_id, s.google_client_secret, s.google_redirect_uri)
    whatsapp = whatsapp or WhatsAppClient(s.whatsapp_app_secret, s.whatsapp_verify_token)
    mode = dispatch_mode or s.dispatch_mode
    dispatcher = ArqDispatcher(s.redis_url) if mode == "arq" else InlineDispatcher(wait=(mode == "inline"))
    keys = LocalKeyProvider(s.master_kek_b64, s.master_kek_id)
    if getattr(router, "keys", None) is None:
        router.keys = keys          # the router unwraps organisations' own model keys
    services = Services(
        router=router,
        keys=keys,
        tools=build_tools(),
        dispatcher=dispatcher,
        sandbox=sandbox,
        messaging=Messaging(google, s.messaging_fallback, whatsapp),
        google=google,
        whatsapp=whatsapp,
    )
    if isinstance(dispatcher, InlineDispatcher):
        dispatcher.services = services
    return services
