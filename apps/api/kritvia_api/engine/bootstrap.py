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


def build_services(*, dispatch_mode: str | None = None, router: ModelRouter | None = None,
                   sandbox=None, google: GoogleClient | None = None) -> Services:
    s = get_settings()
    from kritvia_api.tools import build_tools
    import kritvia_api.workflows  # noqa: F401  (registers workflows)
    from kritvia_api.engine.core import registry
    registry.validate_all()

    router = router or ModelRouter(TierConfig.load(s.tiers_config_path), s.litellm_base_url, s.litellm_api_key)
    if sandbox is None:
        sandbox = HttpSandbox(s.sandbox_url, s.sandbox_token) if s.sandbox_url else LocalSandbox(s.environment)
    google = google or GoogleClient(s.google_client_id, s.google_client_secret, s.google_redirect_uri)
    mode = dispatch_mode or s.dispatch_mode
    dispatcher = ArqDispatcher(s.redis_url) if mode == "arq" else InlineDispatcher(wait=(mode == "inline"))
    services = Services(
        router=router,
        keys=LocalKeyProvider(s.master_kek_b64, s.master_kek_id),
        tools=build_tools(),
        dispatcher=dispatcher,
        sandbox=sandbox,
        messaging=Messaging(google, s.messaging_fallback),
        google=google,
    )
    if isinstance(dispatcher, InlineDispatcher):
        dispatcher.services = services
    return services
