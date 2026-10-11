from __future__ import annotations

from hashlib import sha256


def project_with_sources() -> tuple[dict, dict, dict, dict]:
    own_ad = {
        "id": "ad-own",
        "landing_url": "https://shop.example/products/cubes",
        "primary_text": "Fits inside carry-on luggage.",
    }
    other_ad = {
        "id": "ad-other",
        "landing_url": "https://other.example/products/bag",
        "primary_text": "Belongs to another product.",
    }
    product = {
        "id": "product-cubes",
        "url": "https://shop.example/products/cubes?utm_source=meta",
        "identity_key": "https://shop.example/products/cubes",
        "identity_revision": 2,
        "source_keyword_ids": ["keyword-own", "keyword-other"],
        "candidate_sources": [
            {
                "keyword_id": "keyword-own",
                "ad_id": own_ad["id"],
                "landing_url": own_ad["landing_url"],
                "recorded_at": "2026-09-18T01:00:00Z",
            },
            {
                "keyword_id": "keyword-other",
                "ad_id": other_ad["id"],
                "landing_url": other_ad["landing_url"],
                "recorded_at": "2026-09-18T02:00:00Z",
            },
        ],
        "landing_snapshot": {
            "body_text": "The product page says it fits inside carry-on luggage.",
            "content_hash": sha256(b"current landing").hexdigest(),
            "identity_revision": 2,
        },
    }
    project = {
        "products": [product],
        "keywords": [
            {"id": "keyword-own", "ads": [own_ad]},
            {"id": "keyword-other", "ads": [other_ad]},
        ],
    }
    return project, product, own_ad, other_ad


def test_source_passages_only_include_current_product_candidates() -> None:
    from rabbit_hole.domain.provenance import source_passages

    project, product, own_ad, other_ad = project_with_sources()

    passages = source_passages(project, product["id"])

    assert {item.ad_id for item in passages if item.source_kind == "ad"} == {
        own_ad["id"]
    }
    assert other_ad["id"] not in {item.ad_id for item in passages}


def test_stale_landing_snapshot_is_not_an_expansion_source() -> None:
    from rabbit_hole.domain.provenance import source_passages

    project, product, _, _ = project_with_sources()
    product["landing_snapshot"]["identity_revision"] = 1

    passages = source_passages(project, product["id"])

    assert all(item.source_kind != "landing" for item in passages)


def test_source_passage_ids_and_order_are_stable() -> None:
    from rabbit_hole.domain.provenance import source_passages

    project, product, own_ad, _ = project_with_sources()

    first = source_passages(project, product["id"])
    second = source_passages(project, product["id"])

    assert first == second
    assert [item.source_kind for item in first] == ["landing", "ad"]
    assert first[0].source_id == (
        f"landing:{product['id']}:2:{product['landing_snapshot']['content_hash']}"
    )
    assert first[1].source_id == (f"ad:{product['id']}:2:keyword-own:{own_ad['id']}")
