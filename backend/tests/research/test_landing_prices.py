import json
import pytest
from rabbit_hole.integrations.collectors.landing import LandingCollector

URL='https://shop.example/products/headlight'

def snapshot(body, data=None, meta=''):
    script='<script type="application/ld+json">'+json.dumps(data)+'</script>' if data else ''
    return LandingCollector._snapshot(('<html><head>'+meta+script+'</head><body>'+body+'</body></html>').encode(),URL)

@pytest.mark.parametrize('text,expected',[('$1,249.00','1249.00'),('$12,499.95','12499.95'),('$1.249,00','1249.00'),('$0.00','0.00')])
def test_money_token_is_never_partially_matched(text,expected):
    assert snapshot('<p>'+text+'</p>').price==expected

def test_sale_price_is_used_instead_of_struck_original_or_installment():
    page=snapshot('<s>$1,899.00</s><p>Sale price $1,249.00</p><p>From $104.08 per month</p>')
    assert page.price=='1249.00'

def test_product_group_page_price_and_currency_are_retained():
    group={'@type':'ProductGroup','url':URL,'hasVariant':[{'@type':'Product','offers':{'price':'1249.00','priceCurrency':'USD'}},{'@type':'Product','offers':{'price':'1349.00','priceCurrency':'USD'}}]}
    page=snapshot('<p>Sale price $1,249.00</p>',group,'<meta property="og:price:amount" content="1,249.00"><meta property="og:price:currency" content="USD">')
    assert page.price=='1249.00'
    assert page.price_currency=='USD'

def test_ambiguous_body_prices_are_not_silently_chosen():
    assert snapshot('<p>Product $19.00 or $29.00</p>').price is None

def test_unrelated_product_schema_cannot_supply_current_price():
    assert snapshot('<p>No current price</p>',[{'@type':'Product','url':'https://shop.example/products/other','offers':{'price':'9.00'}}]).price is None

def test_legacy_price_is_reparsed_from_saved_sale_text_without_mutation():
    from copy import deepcopy
    from rabbit_hole.integrations.collectors.landing_price import saved_price_observation
    old={'price':'124','body_text':'Regular price $1,249.00 Regular price $1,899.00 Sale Sale price $1,249.00', 'final_url':URL, 'json_ld':[{'@type':'ProductGroup','hasVariant':[{'offers':{'price':'1249.00','priceCurrency':'USD'}},{'offers':{'price':'1349.00','priceCurrency':'USD'}}]}]}
    before=deepcopy(old)
    value=saved_price_observation(old)
    assert value['amount']=='1249.00' and value['currency']=='USD'
    assert value['reparsed_saved_evidence'] is True
    assert old==before


def test_explicit_variant_selects_only_its_offer():
    group={'@type':'ProductGroup','hasVariant':[{'@id':URL+'?variant=one','offers':{'price':'19.00','priceCurrency':'USD'}},{'@id':URL+'?variant=two','offers':{'price':'29.00','priceCurrency':'USD'}}]}
    from rabbit_hole.integrations.collectors.landing_price import observe_price
    assert observe_price([group],'',URL+'?variant=two')['amount']=='29.00'
    assert observe_price([group],'',URL) is None


def variant_snapshot(variants, url=URL):
    return {'price':None,'price_parser_version':2,'body_text':'','final_url':url,'json_ld':[{'@type':'ProductGroup','name':'Repair kit','url':URL,'hasVariant':variants}]}

def variant(label, price, code='USD', ident='one'):
    return {'@type':'Product','name':'Repair kit - '+label,'url':URL+'?variant='+ident,'offers':{'price':price,'priceCurrency':code}}

def test_saved_variant_prices_preserve_range_package_quantity_and_total_without_mutation():
    from copy import deepcopy
    from rabbit_hole.integrations.collectors.landing_price import saved_price_observation
    source=variant_snapshot([variant('Buy 1','29.99'),variant('Buy 2 Get 1 Free (3 Pcs)','59.99',ident='three'),variant('Buy 4 Get 2 Free (6 Pcs)','109.99',ident='six')]);before=deepcopy(source)
    result=saved_price_observation(source)
    assert result['amount'] is None
    assert result['ranges']==[{'currency':'USD','min':'29.99','max':'109.99'}]
    assert [(p['quantity'],p['unit_amount']) for p in result['options']]==[(1,'29.99'),(3,'20.00'),(6,'18.33')]
    assert [p['amount'] for p in result['options']]==['29.99','59.99','109.99']
    assert source==before


def test_unknown_variant_quantity_is_not_invented_and_mixed_currencies_have_separate_ranges():
    from rabbit_hole.integrations.collectors.landing_price import saved_price_observation
    result=saved_price_observation(variant_snapshot([variant('Small 250g','10'),variant('Large','20','CAD',ident='large')]))
    assert all(p['quantity'] is None and p['unit_amount'] is None for p in result['options'])
    assert len(result['ranges'])==2


def test_variant_projection_excludes_other_products_and_deduplicates_exact_variant_offers():
    from rabbit_hole.integrations.collectors.landing_price import saved_price_observation
    source=variant_snapshot([variant('Buy 1','29.99'),variant('Buy 1','29.99')]);source['json_ld'][0]['hasVariant'].append({'name':'Other - 4 Pcs','url':'https://evil.example/products/other','offers':{'price':'1.00','priceCurrency':'USD'}})
    result=saved_price_observation(source)
    assert len(result['options'])==1 and result['options'][0]['amount']=='29.99'


def test_variant_price_zero_is_valid_but_no_currency_or_conflicting_quantity_stays_unknown():
    from rabbit_hole.integrations.collectors.landing_price import saved_price_observation
    result=saved_price_observation(variant_snapshot([variant('Buy 1','0',code=None),variant('1 pack of 3 Pcs','12',ident='ambiguous')]))
    assert result['options'][0]['amount']=='0.00' and result['options'][0]['currency'] is None
    assert result['options'][1]['quantity'] is None

def test_offer_only_variant_url_is_kept_and_other_product_offer_is_not_imported():
    from rabbit_hole.integrations.collectors.landing_price import saved_price_observation
    source=variant_snapshot([{'name':'Repair kit - Buy 1','offers':{'url':URL+'?variant=one','price':'29.99','priceCurrency':'USD'}},{'name':'Other - Buy 9','offers':{'url':'https://other.example/products/other','price':'1','priceCurrency':'USD'}}])
    options=saved_price_observation(source)['options']
    assert len(options)==1
    assert options[0]['source_url']==URL+'?variant=one'


def test_conflicting_piece_count_and_buy_get_claim_remain_unresolved():
    from rabbit_hole.integrations.collectors.landing_price import saved_price_observation
    option=saved_price_observation(variant_snapshot([variant('Buy 2 Get 1 Free (6 Pcs)','50')]))['options'][0]
    assert option['quantity'] is None and option['unit_amount'] is None

@pytest.mark.parametrize('label',['3 Pcs + 3 Pcs','2 packs','2套','2 x 3 pcs'])
def test_composite_or_pack_count_never_becomes_an_asserted_piece_quantity(label):
    from rabbit_hole.integrations.collectors.landing_price import saved_price_observation
    option=saved_price_observation(variant_snapshot([variant(label,'60')]))['options'][0]
    assert option['quantity'] is None and option['unit_amount'] is None
