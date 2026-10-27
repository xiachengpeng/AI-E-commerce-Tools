"""Deterministic prices from the current page; never infer currency from market."""
from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from urllib.parse import urljoin, urlsplit, parse_qs

# Consume the entire numeric token before validating separators: no prefix matches.
MONEY = re.compile(r'(?P<symbol>US\$|CA\$|AU\$|\$|€|£|¥)\s*(?P<amount>[0-9][0-9.,\u00a0\u202f ]*[0-9]|[0-9])')


def amount(value):
    if isinstance(value, bool) or value is None:
        return None
    raw = str(value).strip().replace('\u00a0', '').replace('\u202f', '').replace(' ', '')
    if not re.fullmatch(r'[0-9]+(?:[.,][0-9]+)*', raw):
        return None
    if '.' in raw and ',' in raw:
        decimal = '.' if raw.rfind('.') > raw.rfind(',') else ','
        groups = raw.rsplit(decimal, 1)
        thousands = ',' if decimal == '.' else '.'
        if len(groups[1]) != 2 or not re.fullmatch(r'\d{1,3}(?:'+re.escape(thousands)+r'\d{3})+', groups[0]):
            return None
        raw = groups[0].replace(thousands, '') + '.' + groups[1]
    elif ',' in raw or raw.count('.') > 1:
        sep = ',' if ',' in raw else '.'
        if re.fullmatch(r'\d{1,3}(?:'+re.escape(sep)+r'\d{3})+', raw):
            raw = raw.replace(sep, '')
        elif sep == ',' and re.fullmatch(r'\d+,\d{2}', raw):
            raw = raw.replace(',', '.')
        else:
            return None
    try:
        number = Decimal(raw)
        return format(number, '.2f') if number.is_finite() and number >= 0 else None
    except InvalidOperation:
        return None


def currency(value):
    return value.upper() if isinstance(value, str) and re.fullmatch('[A-Za-z]{3}', value) else None


def current_products(items, url):
    def types(item):
        t = item.get('@type', [])
        return {str(v).lower() for v in (t if isinstance(t, list) else [t])}
    products = [i for i in items if isinstance(i, dict) and types(i) & {'product', 'productgroup'}]
    def same(item):
        urls = [urljoin(url, item[k]).split('#')[0].rstrip('/') for k in ('url', '@id') if isinstance(item.get(k), str)]
        target = urlsplit(url)
        return not urls or any(urlsplit(u)._replace(query='', fragment='') == target._replace(query='', fragment='') and (not parse_qs(urlsplit(u).query).get('variant') or parse_qs(urlsplit(u).query).get('variant') == parse_qs(target.query).get('variant')) for u in urls)
    return [i for i in products if same(i)] if len(products) != 1 or products else [products[0]] if same(products[0]) else []


def observe_price(items, body, url, meta=None):
    """Return provenance-bearing current price, or no price if ambiguous."""
    products = current_products(items, url)
    offers = []
    for product in products:
        variants = product.get('hasVariant', [])
        chosen = parse_qs(urlsplit(url).query).get('variant')
        if chosen and isinstance(variants, list):
            variants = [v for v in variants if isinstance(v, dict) and any(parse_qs(urlsplit(urljoin(url, str(v.get(k, '')))).query).get('variant') == chosen for k in ('url', '@id') if v.get(k))]
        nodes = [product] + ([v for v in variants if isinstance(v, dict)] if isinstance(variants, list) else [])
        for node in nodes:
            value = node.get('offers', [])
            for offer in value if isinstance(value, list) else [value]:
                if isinstance(offer, dict) and amount(offer.get('price')) is not None:
                    offers.append((amount(offer['price']), currency(offer.get('priceCurrency'))))
    # Distinct variants must not silently become the first variant's price.
    choices = set(offers)
    if len(choices) == 1:
        value, code = next(iter(choices))
        return {'amount': value, 'currency': code, 'source': 'product_offer'}
    meta = meta or {}
    value = amount(meta.get('amount'))
    code = currency(meta.get('currency'))
    if value is not None and (not choices or any(v == value and (not c or not code or c == code) for v, c in choices)):
        return {'amount': value, 'currency': code, 'source': 'page_metadata'}
    # Exact sale/current-price label outranks regular/compare-at/installment text.
    sale = re.findall(r'(?:sale price|current price|现价|促销价|售价)\s*[:：]?\s*((?:US\$|CA\$|AU\$|\$|€|£|¥)\s*[0-9][0-9.,\u00a0\u202f ]*)', body, re.I)
    matches = [m for text in sale for m in MONEY.finditer(text)] if sale else list(MONEY.finditer(body))
    observed = {(amount(m['amount']), {'US$':'USD','CA$':'CAD','AU$':'AUD','€':'EUR','£':'GBP'}.get(m['symbol'])) for m in matches}
    observed.discard((None, None))
    observed = {(v, c) for v, c in observed if v is not None}
    if len(observed) == 1:
        value, code = next(iter(observed))
        compatible = {c for v, c in choices if v == value and c}
        if choices and not any(v == value for v, _ in choices):
            return None
        code = code or (next(iter(compatible)) if len(compatible) == 1 else None)
        return {'amount': value, 'currency': code, 'source': 'sale_text' if sale else 'unique_page_text'}
    return None


def _package_quantity(label):
    if re.search(r'\b(?:packs?|sets?|bags?|boxes)\b|套|包|袋|盒|\d+\s*[x×*]\s*\d+', label, re.I):
        return None
    explicit = [int(n) for n in re.findall(r'(?<![\d.])(\d+)\s*(?:pcs?\b|pieces?\b|件|个|支)', label, re.I)]
    gift = re.search(r'\bbuy\s+(\d+)\s+get\s+(\d+)\s+free\b', label, re.I)
    if explicit:
        count = explicit[0]
        if len(explicit) != 1 or not 0 < count <= 10000:
            return None
        return count if not gift or count == int(gift[1]) + int(gift[2]) else None
    if gift:
        count = int(gift[1]) + int(gift[2])
        return count if 0 < count <= 10000 else None
    one = re.fullmatch(r'\s*buy\s+(\d+)\s*', label, re.I)
    return int(one[1]) if one and 0 < int(one[1]) <= 10000 else None


def variant_prices(items, url):
    """Bounded saved variant offers; never promote a range into a scalar price."""
    target = urlsplit(url)
    options, seen = [], set()
    for product in current_products(items, url):
        variants = product.get('hasVariant')
        if not isinstance(variants, list):
            continue
        parent_name = product.get('name') if isinstance(product.get('name'), str) else ''
        for variant in variants[:200]:
            if not isinstance(variant, dict):
                continue
            raw_url = variant.get('url') or variant.get('@id') or url
            if not isinstance(raw_url, str):
                continue
            try:
                source = urlsplit(urljoin(url, raw_url))
                if source.scheme not in {'http', 'https'} or source.username or source.password or source._replace(query='', fragment='') != target._replace(query='', fragment=''):
                    continue
            except ValueError:
                continue
            name = variant.get('name') if isinstance(variant.get('name'), str) else ''
            label = name[len(parent_name):].strip(' -–—:：') if parent_name and name.startswith(parent_name) else name
            label = label[:500] or '未命名规格'
            quantity = _package_quantity(label)
            offers = variant.get('offers') or []
            for offer in (offers if isinstance(offers, list) else [offers])[:40]:
                if not isinstance(offer, dict):
                    continue
                try:
                    offer_url = urlsplit(urljoin(url, offer['url'])) if isinstance(offer.get('url'), str) else source
                    if offer_url.scheme not in {'http', 'https'} or offer_url.username or offer_url.password or offer_url._replace(query='', fragment='') != target._replace(query='', fragment=''):
                        continue
                except ValueError:
                    continue
                value, code = amount(offer.get('price')), currency(offer.get('priceCurrency'))
                if value is None:
                    continue
                key = (label, value, code, offer_url.geturl())
                if key in seen:
                    continue
                seen.add(key)
                try:
                    unit = format((Decimal(value) / quantity).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP), '.2f') if quantity else None
                except InvalidOperation:
                    unit = None
                options.append({'id': 'variant-' + str(len(options) + 1), 'label': label, 'amount': value, 'currency': code, 'quantity': quantity, 'unit_amount': unit, 'source_url': offer_url.geturl()})
                if len(options) >= 200:
                    break
            if len(options) >= 200:
                break
        if len(options) >= 200:
            break
    ranges = []
    for code in dict.fromkeys(item['currency'] for item in options):
        prices = [Decimal(item['amount']) for item in options if item['currency'] == code]
        ranges.append({'currency': code, 'min': format(min(prices), '.2f'), 'max': format(max(prices), '.2f')})
    return options, ranges


def saved_price_observation(snapshot):
    """Read projection only: retain old evidence and never repeat a network read."""
    if snapshot.get('price_parser_version') == 2:
        observed = {'amount': snapshot.get('price'), 'currency': snapshot.get('price_currency'), 'source': snapshot.get('price_source')}
    else:
        result = observe_price(snapshot.get('json_ld') or [], snapshot.get('body_text') or '', snapshot.get('final_url') or snapshot.get('source_url') or '')
        observed = {**(result or {'amount': None, 'currency': None, 'source': 'unresolved'}), 'reparsed_saved_evidence': True}
    options, ranges = variant_prices(snapshot.get('json_ld') or [], snapshot.get('final_url') or snapshot.get('source_url') or '')
    if options:
        observed.update(options=options, ranges=ranges)
    return observed
