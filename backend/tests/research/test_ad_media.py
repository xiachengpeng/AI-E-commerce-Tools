"""Preview media must survive collection and remain bound to its original ad."""
from uuid import uuid4


def test_provider_keeps_video_and_preview():
    from rabbit_hole.integrations.collectors.provider_api import parse_meta_items
    row = {"ad_archive_id": "ad-media", "is_active": True, "start_date": 1700000000,
           "page_name": "Travel", "snapshot": {"body": {"text": "Pack for travel."},
           "link_url": "https://example.com/products/bag",
           "videos": [{"video_hd_url": "https://cdn.example/clip.mp4",
                       "video_preview_image_url": "https://cdn.example/poster.jpg"}]}}
    ad = parse_meta_items([row])[0]
    assert ad["media"][0] == {"kind": "video", "url": "https://cdn.example/clip.mp4",
                              "preview_url": "https://cdn.example/poster.jpg"}

    row["snapshot"]["images"] = None
    assert parse_meta_items([row])[0]["media"] == ad["media"]


def test_media_rejects_private_or_credential_urls():
    from rabbit_hole.domain.ad_media import normalize_ad_media
    items = [{"kind": "image", "url": url} for url in [
        "http://127.0.0.1/private", "http://192.168.31.112/private",
        "javascript:alert(1)", "https://user:pass@cdn.example/private",
        "http://host.local/private", "https://cdn.example/image.jpg",
    ]]
    assert normalize_ad_media(items) == [{"kind": "image", "url": "https://cdn.example/image.jpg"}]


async def test_saved_media_remains_unconfirmed(db_engine):
    from rabbit_hole.persistence.projects import WorkbenchStore
    store = WorkbenchStore(db_engine)
    project = await store.create("Preview", "test", "US", str(uuid4()))
    project = await store.command(project["id"], project["version"], str(uuid4()), "add_keyword",
                                 {"text": "travel bag", "type": "category"})
    word = project["keywords"][0]["id"]
    project = await store.command(project["id"], project["version"], str(uuid4()), "approve_keyword",
                                 {"keyword_id": word, "approved": True})
    project = await store.command(project["id"], project["version"], str(uuid4()), "collection_result",
                                 {"keyword_id": word, "status": "complete", "ads": [{
                                     "id": "ad", "advertiser": "Travel", "active": True,
                                     "landing_url": "https://example.com/products/bag",
                                     "primary_text": "Pack for travel.", "media": [{
                                         "kind": "image", "url": "https://cdn.example/bag.jpg"}]}]},
                                 actor="automation")
    assert project["keywords"][0]["ads"][0]["media"][0]["url"] == "https://cdn.example/bag.jpg"
    assert not project["products"][0]["identification"].get("relevance_confirmed")
