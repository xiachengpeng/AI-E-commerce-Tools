from pydantic import ValidationError

from rabbit_hole.config import MarketSettings


def test_market_requires_real_cost_rates():
    market = MarketSettings(
        code="US",
        currency="USD",
        min_aov=50,
        max_aov=100,
        payment_percent=2.9,
        payment_fixed=0.30,
        loss_reserve_percent=3.0,
    )
    assert market.payment_fixed == 0.30


def test_missing_payment_rate_blocks_startup():
    try:
        MarketSettings(
            code="US",
            currency="USD",
            min_aov=50,
            max_aov=100,
            payment_fixed=0.30,
            loss_reserve_percent=3.0,
        )
    except ValidationError:
        return
    raise AssertionError("payment_percent must be required")
