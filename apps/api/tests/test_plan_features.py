"""What a plan card lists is what the plan gives: each feature named in a plan's highlights is
switched on for that plan, and no plan lists a feature as coming soon any more."""
from __future__ import annotations

import re

from kritvia_api.plans import PLANS

FEATURES = {
    r"custom workflows": lambda p: "custom_workflows" in p.extras,
    r"api access": lambda p: "api_access" in p.extras,
    r"priority processing": lambda p: "priority_processing" in p.extras,
    r"single sign-on|\bsso\b": lambda p: "sso" in p.extras,
    r"advanced analytics": lambda p: p.analytics == "advanced",
    r"analytics": lambda p: p.analytics in ("basic", "advanced"),
}


def test_highlights_match_capabilities():
    for code, p in PLANS.items():
        text = " | ".join(p.highlights).lower()
        assert not p.coming_soon, code
        for pattern, has in FEATURES.items():
            if re.search(pattern, text):
                assert has(p), f"{code} lists '{pattern}' but doesn't include it"
    for code in ("scale", "enterprise"):
        p = PLANS[code]
        assert {"custom_workflows", "api_access", "priority_processing"} <= set(p.extras) and p.analytics == "advanced"
    assert "sso" in PLANS["enterprise"].extras and "sso" not in PLANS["scale"].extras
    assert PLANS["growth"].analytics == "advanced" and PLANS["starter"].analytics == "basic"
