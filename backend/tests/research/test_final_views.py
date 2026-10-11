from rabbit_hole.integrations.feishu import BaseSchema, bootstrap_base


class SchemaBase:
    def __init__(self):
        self.tables = {table.name: table for table in BaseSchema.default().tables}
        self.fields = {
            name: [
                {
                    "id": field.key,
                    **field.create_payload({key: key for key in self.tables}),
                }
                for field in table.fields
            ]
            for name, table in self.tables.items()
        }
        self.views = {}

    async def list_tables(self):
        return [{"id": name, "name": name} for name in self.tables]

    async def list_fields(self, table):
        return self.fields[table]

    async def get_field(self, table, field):
        return next(item for item in self.fields[table] if item["id"] == field)

    async def list_views(self, table):
        return []

    async def create_view(self, table, name, predicate):
        self.views[table, name] = {"logic": "and", "conditions": []}
        return name

    async def get_view_filter(self, table, name):
        return self.views[table, name]

    async def update_view(self, table, name, predicate):
        self.views[table, name] = predicate


async def test_operational_views_use_correct_native_predicates_and_isolate_alerts():
    base = SchemaBase()
    await bootstrap_base(base)
    expected = {
        ("搜索批次", "运营｜运行告警"): ["row_type", "==", "运行告警"],
        ("市场评估表", "运营｜观察池"): ["status", "intersects", ["观察池"]],
        ("市场评估表", "运营｜测试池"): ["status", "intersects", ["测试池"]],
        ("市场评估表", "运营｜待确认创意"): ["status", "intersects", ["待确认创意"]],
        ("市场评估表", "运营｜粗筛通过"): ["current_recommendation", "==", "值得深入"],
    }
    for key, condition in expected.items():
        assert key in base.views
        assert condition in base.views[key]["conditions"]
    for (table, name), predicate in base.views.items():
        if table == "搜索批次" and name != "运营｜运行告警":
            assert ["row_type", "!=", "运行告警"] in predicate["conditions"]
