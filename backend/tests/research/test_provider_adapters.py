import pytest


def test_meta_maps_dco_and_error_rows():
    from rabbit_hole.integrations.collectors.provider_api import (
        ProviderError,
        parse_meta_items,
    )

    assert parse_meta_items([{'errorCode': 'ADS_NOT_FOUND'}]) == []
    row = {'ad_archive_id': '12345678901234567890', 'is_active': True, 'page_name': 'Shop', 'start_date': 1750000000, 'snapshot': {'cards': [{'video_hd_url': 'https://example.com/video.mp4'}], 'link_url': 'https://example.com/item', 'body': {'text': 'organizer'}}}
    ads = parse_meta_items([row, row])
    assert len(ads) == 1
    assert ads[0]['id'] == row['ad_archive_id']
    assert ads[0]['continuity_status'] == 'unknown'
    assert ads[0]['currently_active'] is True
    assert ads[0]['ad_age_days'] > 30
    assert ads[0]['observed_at'] is None
    with pytest.raises(ProviderError):
        parse_meta_items([{'errorCode': 'BLOCKED'}])


def test_trends_partial_and_monthly_data():
    from rabbit_hole.integrations.collectors.provider_api import (
        ProviderError,
        parse_serpapi_series,
    )

    rows = [{'timestamp': str(1700000000 + i * 604800), 'values': [{'query': 'organizer', 'extracted_value': 30}]} for i in range(262)]
    rows[-1]['partial_data'] = True
    response = {'search_metadata': {'status': 'Success'}, 'search_parameters': {'q': 'organizer', 'geo': 'US', 'date': 'today 5-y'}, 'interest_over_time': {'timeline_data': rows}}
    series = parse_serpapi_series(response, 'organizer', '5y')
    assert len(series.points) == 261
    rows[3]['timestamp'] = str(1700000000 + 3 * 2592000)
    with pytest.raises(ProviderError):
        parse_serpapi_series(response, 'organizer', '5y')


def test_ui_failure_diagnostics_name_observed_reason():
    from rabbit_hole.integrations.collectors.meta import MetaPageHealthError
    from rabbit_hole.integrations.provider_jobs import diagnostic

    assert '验证码' in diagnostic(MetaPageHealthError('captcha'))
    assert '筛选' in diagnostic(MetaPageHealthError('displayed_filters_mismatch'))
    assert '广告卡片' in diagnostic(MetaPageHealthError('unrecognized_ad_cards'))
    assert '原因未确定' in diagnostic(RuntimeError('opaque upstream change'))
