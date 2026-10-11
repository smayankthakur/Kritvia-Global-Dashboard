"""Settings read from .env: an empty value for a typed setting means "not set" (Incident 7 Oct 2026)."""
from datetime import datetime

from kritvia_api.config import Settings


def test_empty_typed_values_fall_back_to_defaults(monkeypatch):
    monkeypatch.setenv("PAYMENTS_LIVE_AT", "")
    monkeypatch.setenv("PROSPECTOR_DAILY_CAP", "  ")
    monkeypatch.setenv("SIGNUP_OPEN", "")
    s = Settings(_env_file=None)
    assert s.payments_live_at is None
    assert s.prospector_daily_cap == 25
    assert s.signup_open is True


def test_empty_text_values_stay_empty(monkeypatch):
    monkeypatch.setenv("COMPANY_CIN", "")
    assert Settings(_env_file=None).company_cin == ""


def test_real_values_still_parse(monkeypatch):
    monkeypatch.setenv("PAYMENTS_LIVE_AT", "2026-11-01T00:00:00+05:30")
    monkeypatch.setenv("PROSPECTOR_DAILY_CAP", "10")
    s = Settings(_env_file=None)
    assert isinstance(s.payments_live_at, datetime) and s.payments_live_at.year == 2026
    assert s.prospector_daily_cap == 10


def test_empty_value_in_env_file(tmp_path):
    f = tmp_path / ".env"
    f.write_text("PAYMENTS_LIVE_AT=\nAI_USER_DAILY_TOKENS=\n")
    s = Settings(_env_file=str(f))
    assert s.payments_live_at is None and s.ai_user_daily_tokens == 250_000
