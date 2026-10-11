from rabbit_hole.domain.supporting_research import evergreen_signal


def product(age, *, active=True, relevant=True, linked=True, revision=1):
    return {
        "identity_revision": revision,
        "identification": {
            "identity_revision": 1,
            "ad_age_days": age,
            "currently_active": active,
            "relevance_confirmed": relevant,
            "creatives": [{"id": "ad-1", "active": True, "distinct": True,
                           "source_url": "https://facebook.com/ad/1"}] if linked else [],
        },
    }


def test_evergreen_requires_365_days_and_current_link_backed_active_ad():
    younger = evergreen_signal(product(364))
    assert younger["status"] == "not_observed"
    assert evergreen_signal(product(365))["status"] == "observed"
    assert evergreen_signal(product(365))["source_ad_ids"] == ["ad-1"]
    assert evergreen_signal(product(None))["status"] == "unknown"
    assert evergreen_signal(product(400, linked=False))["status"] == "unknown"
    assert evergreen_signal(product(400, active=False))["status"] == "not_observed"
    assert evergreen_signal(product(400, revision=2))["status"] == "unknown"
    assert "盈利" in evergreen_signal(product(365))["reason"]


def test_legacy_first_identity_without_explicit_revision_remains_current():
    legacy = product(400)
    del legacy["identification"]["identity_revision"]
    assert evergreen_signal(legacy)["status"] == "observed"
    legacy["identity_revision"] = 2
    assert evergreen_signal(legacy)["status"] == "unknown"
