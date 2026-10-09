"""Supported workbench research regions; country-specific evidence stays separate."""

from typing import NamedTuple


class Market(NamedTuple):
    name: str
    english: str
    language: str
    aliases: tuple[str, ...] = ()


MARKETS = {
    "US": Market("美国", "United States", "English", ("美國",)),
    "GB": Market("英国", "United Kingdom", "English", ("英國",)),
    "CA": Market("加拿大", "Canada", "English"),
    "AU": Market("澳大利亚", "Australia", "English", ("澳洲", "澳大利亞")),
    "DE": Market("德国", "Germany", "German", ("德國", "Deutschland")),
    "FR": Market("法国", "France", "French", ("法國",)),
    "JP": Market("日本", "Japan", "Japanese"),
}


def region_labels(market: str) -> set[str]:
    item = MARKETS[market]
    return {
        text.casefold().replace(" ", "")
        for text in (market, item.name, item.english, *item.aliases)
    }
