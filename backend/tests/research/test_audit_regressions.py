"""Regressions found during the real-user research audit (no external calls)."""
import json
from uuid import uuid4

from rabbit_hole.domain.ad_media import normalize_ad_media
from rabbit_hole.integrations.collectors.landing import LandingCollector
from rabbit_hole.integrations.collectors.meta import MetaAd

SIGNED = 'https://video.xx.fbcdn.net/v/clip.mp4?_nc_cat=1&_nc_ss=8&oh=abc%2Fdef&oe=123'


def test_meta_model_and_preview_keep_cdn_delivery_signature_only():
    ad = MetaAd(ad_id='1', advertiser='Shop', query='tool', is_active=True,
                media_url=SIGNED + '&api_token=never-keep')
    assert ad.media_url == SIGNED
    assert normalize_ad_media([{'kind': 'video', 'url': ad.media_url}])[0]['url'] == SIGNED
    assert normalize_ad_media([{'kind': 'image', 'url': 'https://fbcdn.net.evil.example/x?oh=x&token=y'}])[0]['url'] == 'https://fbcdn.net.evil.example/x'


async def test_signed_media_survives_persistence_but_not_report_exports(db_engine):
    from rabbit_hole.persistence.projects import WorkbenchStore
    store = WorkbenchStore(db_engine)
    p = await store.create('Media', 'tools', 'US', str(uuid4()))
    async def command(action, payload, actor='user'):
        nonlocal p
        p = await store.command(p['id'], p['version'], str(uuid4()), action, payload, actor=actor)
    await command('add_keyword', {'text': 'gap tool', 'type': 'category'})
    wid = p['keywords'][0]['id']
    await command('approve_keyword', {'keyword_id': wid, 'approved': True})
    await command('collection_result', {'keyword_id': wid, 'status': 'complete', 'ads': [{
        'id': '1', 'advertiser': 'Shop', 'active': True, 'primary_text': 'Gap tool',
        'landing_url': 'https://shop.example/products/tool',
        'media': [{'kind': 'video', 'url': SIGNED}]}]}, 'automation')
    assert p['keywords'][0]['ads'][0]['media'][0]['url'] == SIGNED
    # Export boundary still discards signed delivery parameters.
    from rabbit_hole.input_urls import sanitize_research_url_fields
    assert 'oh=' not in json.dumps(sanitize_research_url_fields(p))


def test_product_gallery_excludes_recommendations_and_account_hook():
    html = b'''<title>Gap tool</title><header><p>Have an account?</p></header>
    <aside class="product-recommendations"><img src="/nozzle.jpg"></aside>
    <main><div class="product__media"><img src="/gap-tool.jpg"></div>
    <p>Adjust your spark plug gap accurately.</p></main>'''
    page = LandingCollector._snapshot(html, 'https://shop.example/products/tool')
    assert page.images == ('https://shop.example/gap-tool.jpg',)
    assert page.funnel.first_screen_hook == 'Adjust your spark plug gap accurately.'


def test_jsonld_graph_selects_current_product_not_related_product():
    data = {'@graph': [
        {'@type': 'Product', 'url': 'https://shop.example/products/nozzle', 'image': '/nozzle.jpg'},
        {'@type': 'Product', 'url': 'https://shop.example/products/tool', 'image': ['/tool.jpg'],
         'offers': {'price': '29.99'}}]}
    page = LandingCollector._snapshot(('<script type="application/ld+json">' + json.dumps(data) +
        '</script><img src="/nozzle.jpg">').encode(), 'https://shop.example/products/tool')
    assert page.images == ('https://shop.example/tool.jpg',)
    assert page.price == '29.99'


def test_authoritative_product_images_do_not_append_unscoped_main_images():
    page = LandingCollector._snapshot(b'''<script type="application/ld+json">
    {"@type":"Product","url":"https://shop.example/products/tool","image":["/tool.jpg"]}
    </script><main><div class="gallery"><img src="/tool.jpg"></div>
    <section class="you-may-also-like"><img src="/nozzle.jpg"></section>
    <img src="/visa.jpg"></main>''', 'https://shop.example/products/tool')
    assert page.images == ('https://shop.example/tool.jpg',)


def test_ai_identity_step_never_claims_human_review():
    from rabbit_hole.domain.project import apply_command
    from test_workbench_verification import NOW, assessment, fixture
    state, _, product = fixture()
    apply_command(state, 'verification_result', {'assessments': [assessment(state, product)]},
                  actor='automation', now=NOW)
    step = next(s for s in product['steps'] if s['key'] == 'identification')
    assert 'AI' in step['reason']
    assert '已人工' not in step['reason']
