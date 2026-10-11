"""Provision the rabbit-hole Base schema without destructive operations."""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

# Permit `python scripts/bootstrap_feishu.py` from a source checkout.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from rabbit_hole.config import get_settings
from rabbit_hole.integrations.feishu import BaseSchema, FeishuClient, bootstrap_base


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="print the nine-table plan; perform no API calls")
    args = parser.parse_args()
    schema = BaseSchema.default()
    if args.dry_run:
        plan = await bootstrap_base(None, schema=schema, dry_run=True)
    else:
        settings = get_settings()
        client = FeishuClient(settings.feishu_app_id, settings.feishu_app_secret, settings.feishu_base_app_token)
        try:
            plan = await bootstrap_base(client, schema=schema)
        finally:
            await client.aclose()
    print(f"tables={plan.tables} fields={plan.fields} views={', '.join(plan.views)} destructive_operations={plan.destructive_operations}")
    for table in schema.tables:
        print(f"- {table.name}: {len(table.fields)} fields; logical_key={table.logical_key}")
    for issue in plan.incompatible:
        print(f"INCOMPATIBLE (unchanged): {issue}")


if __name__ == "__main__":
    asyncio.run(main())
