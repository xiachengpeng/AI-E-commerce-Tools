"""Downloads are selected from saved evidence, not arbitrary browser URLs."""
import httpx
import pytest

from rabbit_hole.integrations.media_download import (
    MediaDownloadError,
    read_media_download,
    select_media,
)
from rabbit_hole.security import SafeUrlClient


def test_selection_requires_matching_keyword_and_ad_binding():
    project={"keywords":[{"id":"w","ads":[{"id":"ad","media":[{"kind":"video","url":"https://cdn.example/clip.mp4"}]}]}],
             "products":[{"id":"p","source_keyword_ids":["w"],"candidate_sources":[],
                          "landing_snapshot":{"images":["https://cdn.example/product.jpg"]}}]}
    assert select_media(project,"w","p","","product",0)["url"].endswith("product.jpg")
    with pytest.raises(MediaDownloadError):
        select_media(project,"w","p","ad","ad",0)
    project["products"][0]["candidate_sources"]=[{"keyword_id":"w","ad_id":"ad"}]
    assert select_media(project,"w","p","ad","ad",0)["kind"]=="video"
    with pytest.raises(MediaDownloadError):
        select_media(project,"w","p","ad","product",9)


async def test_downloader_returns_real_bytes_rejects_html_and_private_redirect():
    responses=[httpx.Response(200,headers={"content-type":"image/png"},content=b"image-bytes"),
               httpx.Response(200,headers={"content-type":"text/html"},content=b"blocked"),
               httpx.Response(302,headers={"location":"http://127.0.0.1/private"})]
    client=SafeUrlClient(resolver=lambda h,p:["8.8.8.8"],transport=httpx.MockTransport(lambda r:responses.pop(0)))
    item={"kind":"image","url":"https://cdn.example/product.png"}
    assert await read_media_download(item,client)==(b"image-bytes","image/png","png")
    with pytest.raises(MediaDownloadError,match="图片或视频"):
        await read_media_download(item,client)
    with pytest.raises(MediaDownloadError,match="下载失败"):
        await read_media_download(item,client)

async def test_download_route_is_bound_and_delivers_attachment(db_engine, monkeypatch):
    from uuid import uuid4

    from rabbit_hole.persistence.projects import WorkbenchStore
    from rabbit_hole.runtime.server import create_app

    store=WorkbenchStore(db_engine)
    project=await store.create("Download", "isolated", "US", str(uuid4()))
    project=await store.command(project["id"],project["version"],str(uuid4()),"add_keyword",{"text":"organizer","type":"category"})
    wid=project["keywords"][0]["id"]
    project=await store.command(project["id"],project["version"],str(uuid4()),"approve_keyword",{"keyword_id":wid,"approved":True})
    project=await store.command(project["id"],project["version"],str(uuid4()),"collection_result",{
        "keyword_id":wid,"status":"complete","ads":[{"id":"a","advertiser":"Travel","active":True,
        "primary_text":"Organize your essentials.","media":[{"kind":"image","url":"https://cdn.example/a.png"}]}]},actor="automation")
    app=create_app(checks={})
    app.state.workbench_store=store
    async def read(item):
        assert item["url"]=="https://cdn.example/a.png"
        return b"real-image-bytes","image/png","png"
    monkeypatch.setattr("rabbit_hole.integrations.media_download.read_media_download",read)
    url=f"/workbench/api/projects/{project['id']}/media-download"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app),base_url="http://localhost:8000") as c:
        r=await c.get(url,params={"keyword_id":wid,"source":"ad","ad_id":"a","index":0})
        assert r.status_code==200 and r.content==b"real-image-bytes"
        assert "attachment" in r.headers["content-disposition"]
        assert (await c.get(url,params={"keyword_id":wid,"source":"ad","ad_id":"other","index":0})).status_code==422
        assert (await c.get(url,params={"keyword_id":wid,"source":"ad","ad_id":"a","index":0},headers={"Host":"evil.example"})).status_code==403
    assert (await store.get(project["id"]))["version"]==project["version"]
