"""Private non-AI configuration; separate from startup's main Base metadata."""

from sqlalchemy import CheckConstraint, Column, Float, Integer, MetaData, Table, Text

metadata = MetaData()
integration_settings = Table(
    "integration_settings",
    metadata,
    Column("provider", Text, primary_key=True),
    Column("purpose", Text, primary_key=True),
    Column("value", Text, nullable=False),
    Column("version", Integer, nullable=False),
    CheckConstraint(
        "provider IN ('apify', 'serpapi', 'firecrawl', 'aliyun', 'feishu')",
        name="integration_provider",
    ),
    CheckConstraint("version >= 1", name="integration_version"),
)
research_translation_cache = Table(
    "research_translation_cache",
    metadata,
    Column("key", Text, primary_key=True),
    Column("value", Text, nullable=False),
    Column("created", Float, nullable=False),
)
