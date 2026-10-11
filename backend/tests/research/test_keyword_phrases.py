import pytest

from rabbit_hole.keyword_phrases import canonical_phrase


@pytest.mark.parametrize(
    ("raw", "content", "quoted", "changed"),
    [
        ("portable organizer", "portable organizer", '"portable organizer"', True),
        ('"portable organizer"', "portable organizer", '"portable organizer"', False),
        ("“portable organizer”", "portable organizer", '"portable organizer"', True),
        (
            '"portable organizer" travel',
            "portable organizer travel",
            '"portable organizer travel"',
            True,
        ),
        (
            '""portable organizer" travel"',
            "portable organizer travel",
            '"portable organizer travel"',
            True,
        ),
        (
            "  portable   organizer  ",
            "portable organizer",
            '"portable organizer"',
            True,
        ),
    ],
)
def test_canonical_phrase_has_one_outer_ascii_quote_pair(raw, content, quoted, changed):
    result = canonical_phrase(raw)
    assert (result.content, result.quoted, result.changed) == (
        content,
        quoted,
        changed,
    )
    assert result.quoted.count('"') == 2


@pytest.mark.parametrize("raw", ["", "  ", '""', "“”", None, [], {}])
def test_canonical_phrase_rejects_empty_or_non_text(raw):
    with pytest.raises((TypeError, ValueError)):
        canonical_phrase(raw)
