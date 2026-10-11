"""Canonical Meta exact-phrase search strings."""

from __future__ import annotations

import re
from dataclasses import dataclass

_QUOTE_DELIMITERS = re.compile(r'["“”„‟«»]')


@dataclass(frozen=True, slots=True)
class CanonicalPhrase:
    content: str
    quoted: str
    changed: bool


def canonical_phrase(value: object, *, limit: int = 500) -> CanonicalPhrase:
    if not isinstance(value, str):
        raise TypeError("keyword must be text")
    original = value.strip()
    content = " ".join(_QUOTE_DELIMITERS.sub(" ", original).split())
    if not content:
        raise ValueError("keyword must not be empty")
    if len(content) > limit:
        raise ValueError(f"keyword exceeds {limit} characters")
    quoted = f'"{content}"'
    return CanonicalPhrase(
        content=content,
        quoted=quoted,
        changed=original != quoted,
    )
