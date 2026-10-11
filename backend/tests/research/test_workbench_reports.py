from datetime import UTC, datetime

from rabbit_hole.application.reports import research_report
from rabbit_hole.domain.project import apply_command, new_project, project_view


def test_report_keeps_optional_research_separate_from_profit_or_continuity():
    now = datetime(2026, 9, 30, tzinfo=UTC)
    project = new_project("辅助研究", "travel cubes", now=now)
    apply_command(project, "add_product", {
        "name": "Travel cubes", "url": "https://shop.example/p/cubes",
    }, now=now)
    item = project["products"][0]
    apply_command(project, "add_creative_reference", {
        "product_id": item["id"], "source_ad_id": "ad-1",
        "source_url": "https://facebook.com/ad/1",
        "observed_at": now.isoformat(), "format": "video",
        "hook": "Packing mess", "pattern_note": "Before and after",
    }, now=now)
    apply_command(project, "record_funnel_investigation", {
        "product_id": item["id"], "area": "abandoned_cart",
        "status": "observed", "method": "script_detected",
        "source_url": "https://shop.example/p/cubes",
        "observed_at": now.isoformat(),
    }, now=now)
    report = research_report(project_view(project, now=now))
    assert "创意参考" in report
    assert "弃购" in report
    assert "脚本" in report
    assert "不证明持续投放或盈利" in report


def test_report_lists_cross_store_offers_without_aggregating_evidence() -> None:
    project = new_project("同款多卖家", "travel cubes")
    for name, url in (
        ("Seller A", "https://a.example/p/1"),
        ("Seller B", "https://b.example/p/2"),
    ):
        apply_command(project, "add_product", {"name": name, "url": url})
    first, second = project["products"]
    apply_command(project, "link_product_offers", {
        "first_product_id": first["id"], "second_product_id": second["id"],
        "name": "Same travel cubes", "reason": "Compared package and dimensions",
    })
    report = research_report(project_view(project))
    assert "同款商品与卖家档案" in report
    assert "Same travel cubes" in report
    assert "Seller A" in report and "Seller B" in report
    assert "评分、物流、价格和测试结果不合并" in report


def guided_funnel_project():
    project = new_project("漏斗口径", "旅行收纳")
    names = [
        "pending",
        "retained",
        "observing",
        "rejected",
        "merged",
        "coarse",
        "test",
        "confirmed",
    ]
    for name in names:
        apply_command(
            project,
            "add_product",
            {"name": name, "url": f"https://shop.example/p/{name}"},
        )
    products = {item["name"]: item for item in project["products"]}
    for name in ("retained", "coarse", "test", "confirmed"):
        products[name]["triage"] = {
            "state": "retained",
            "reason": "值得继续深挖",
            "decided_at": "2026-09-20T08:00:00Z",
            "operator": "local_user",
            "history": [],
        }
    products["observing"]["triage"] = {
        "state": "observing",
        "reason": "等待更多可核验证据",
        "decided_at": "2026-09-20T08:00:00Z",
        "operator": "local_user",
        "history": [],
    }
    products["rejected"]["triage"] = {
        "state": "rejected",
        "reason": "广告与商品不相关",
        "decided_at": "2026-09-20T08:00:00Z",
        "operator": "local_user",
        "history": [],
    }
    products["rejected"]["url"] += "?token=SYNTHETIC_FUNNEL_SECRET"
    products["merged"]["merged_into"] = products["retained"]["id"]
    products["merged"]["merge_reason"] = "重复商品档案"
    products["merged"]["merged_at"] = "2026-09-20T08:00:00Z"
    for name in ("coarse", "test", "confirmed"):
        products[name]["identification"] = {
            "relevance_confirmed": True,
            "active_days": 30,
            "currently_active": True,
            "distinct_active_creatives": 3,
            "passed": True,
        }
    for name in ("test", "confirmed"):
        products[name]["decision"] = {
            "pool": "test",
            "stale": False,
            "reason": "进入小额测试",
        }
    products["confirmed"]["test_runs"] = [{"id": "run-confirmed", "status": "active"}]
    products["confirmed"]["test_results"] = [
        {
            "id": "result-confirmed",
            "test_run_id": "run-confirmed",
            "state": "confirmed",
            "confirmed": True,
        }
    ]
    return project


def test_source_attribution_deduplicates_products_and_uses_confirmed_results_only():
    from rabbit_hole.application.reports import source_attribution

    project = {
        "keywords": [
            {"id": "a", "text": '"organizer"'},
            {"id": "b", "text": '"travel"'},
        ],
        "products": [
            {
                "id": "p",
                "source_keyword_ids": ["a", "b", "a"],
                "identification": {"passed": True},
                "revision": 2,
                "decision": {"pool": "test", "score_revision": 2},
                "test_runs": [{"id": "run-1", "status": "active"}],
                "test_results": [
                    {
                        "test_run_id": "run-1",
                        "confirmed": True,
                        "spend": 20,
                        "revenue": 80,
                        "orders": 2,
                    },
                    {
                        "test_run_id": "run-1",
                        "confirmed": False,
                        "spend": 999,
                        "revenue": 999,
                        "orders": 999,
                    },
                ],
            },
            {
                "id": "q",
                "source_keyword_ids": ["b"],
                "revision": 3,
                "identification": {"passed": False},
                "decision": {"pool": "test", "revision": 2, "stale": True},
                "test_results": [],
            },
        ],
    }
    rows = source_attribution(project)
    assert rows[0]["primary_products"] == 1
    assert rows[0]["qualified_products"] == 1
    assert rows[0]["test_pool_products"] == 1
    assert rows[0]["confirmed_orders"] == 2
    assert rows[0]["confirmed_revenue"] == 80
    assert rows[0]["confirmed_spend"] == 20
    assert rows[1]["primary_products"] == 1
    assert rows[1]["assisting_products"] == 1
    assert rows[1]["test_pool_products"] == 0
    assert rows[1]["confirmed_revenue"] is None
    assert rows[1]["qualified_rate"] == 0
    project["products"][0]["triage"] = {"state": "rejected"}
    rejected_rows = source_attribution(project)
    assert rejected_rows[0]["qualified_products"] == 0
    assert rejected_rows[0]["test_pool_products"] == 0
    assert rejected_rows[0]["confirmed_records"] == 0
    project["products"][0]["steps"] = [{"key": "decision", "state": "needs_input"}]
    assert source_attribution(project)[0]["test_pool_products"] == 0


def test_source_attribution_does_not_count_legacy_unbound_results():
    from rabbit_hole.application.reports import source_attribution

    project = {
        "keywords": [{"id": "a", "text": '"organizer"'}],
        "products": [
            {
                "id": "p",
                "source_keyword_ids": ["a"],
                "identification": {"passed": True},
                "revision": 1,
                "decision": None,
                "steps": [],
                "test_runs": [],
                "test_results": [
                    {
                        "id": "legacy",
                        "confirmed": True,
                        "spend": 20,
                        "revenue": 80,
                        "orders": 2,
                    }
                ],
            }
        ],
    }

    row = source_attribution(project)[0]

    assert row["confirmed_records"] == 0
    assert row["confirmed_revenue"] is None


def test_source_attribution_excludes_a_voided_result_chain():
    from rabbit_hole.application.reports import source_attribution

    project = {
        "keywords": [{"id": "a", "text": '"organizer"'}],
        "products": [
            {
                "id": "p",
                "source_keyword_ids": ["a"],
                "identification": {"passed": True},
                "revision": 1,
                "decision": None,
                "steps": [],
                "test_runs": [{"id": "run-1", "status": "active"}],
                "test_results": [
                    {
                        "id": "result-1",
                        "test_run_id": "run-1",
                        "state": "confirmed",
                        "confirmed": True,
                        "spend": 20,
                        "revenue": 80,
                        "orders": 2,
                    },
                    {
                        "id": "result-2",
                        "test_run_id": "run-1",
                        "state": "void",
                        "confirmed": False,
                        "supersedes_id": "result-1",
                        "spend": 20,
                        "revenue": 80,
                        "orders": 2,
                    },
                ],
            }
        ],
    }

    row = source_attribution(project)[0]

    assert row["confirmed_records"] == 0
    assert row["confirmed_revenue"] is None


def test_report_includes_rule_snapshot_and_source_attribution_without_profit_claim():
    p = new_project("规则报告", "收纳")
    p["rules"] = {"max_weight_kg": 1.5}
    p["rules_version"] = 2
    p["rule_history"] = [{"version": 1, "reason": "旧规则"}]
    report = research_report(p)
    assert "规则版本：2" in report
    assert '"max_weight_kg": 1.5' in report
    assert "首次发现 / 辅助来源归因" in report
    assert "不能据此计算已实现利润" in report


def test_report_research_intelligence_shows_exact_ratio_and_unknown_sources():
    from rabbit_hole.application.intelligence import intelligence_snapshot

    now = datetime(2026, 9, 29, 4, tzinfo=UTC)
    project = new_project("复盘比例", "旅行收纳", now=now)
    apply_command(project, "add_keyword", {"text": "packing cubes", "type": "category"}, now=now)
    word = project["keywords"][0]
    for index in range(5):
        apply_command(project, "add_product", {
            "name": f"线索 {index}", "url": f"https://shop.example/p/{index}",
            "source_keyword_ids": [word["id"]],
        }, now=now)
    for item in project["products"][:2]:
        item["triage"]["state"] = "retained"
    snapshot = intelligence_snapshot(project, {}, now)

    report = research_report(project, snapshot)
    assert "2/5（40.0%）" in report
    assert "2026-09-29" in report
    assert "来源未明确" in report
    assert "暂无可归因发现记录" in report
    assert "无可比的已确认测试轮次" in report
    assert "最佳关键词" not in report


def test_report_has_readable_period_summary_and_waiver_reason():
    p = new_project("报告验收", "旅行收纳")
    apply_command(p, "add_product", {"name": "商品", "url": "https://shop.example/p/a"})
    pid = p["products"][0]["id"]
    apply_command(
        p,
        "evidence",
        {
            "product_id": pid,
            "channel": "amazon",
            "observed_at": datetime.now(UTC).isoformat(),
            "confirmed": False,
            "not_applicable": True,
            "reason": "该渠道资料暂缺，结论范围受限",
        },
    )
    text = research_report(project_view(p))
    assert "有限证据" in text
    assert "该渠道资料暂缺" in text
    assert "本周" in text and "本月" in text
    assert "无已确认测试数据" in text
    assert "粗筛通过：0" in text


def test_report_renders_current_score_dimensions_and_final_gates():
    from tests.test_workbench_domain import NOW, complete_research, identified_product

    project = new_project("评分解释", "旅行收纳")
    product = identified_product(project)
    complete_research(project, product)
    apply_command(project, "evaluate", {"product_id": product["id"]}, now=NOW)

    text = research_report(project_view(project, now=NOW))

    assert "当前评分解释" in text
    assert "五维评分" in text
    assert "最终硬门槛" in text
    assert "规则：" in text
    assert "证据：" in text
    assert "评分历史（审计明细）" in text


def test_report_labels_domain_scenario_as_estimate_not_product_sales():
    from tests.test_workbench_domain import NOW, command, evidence, identified_product

    project = new_project("流量估算", "旅行收纳")
    product = identified_product(project)
    command(project, "economics", {"product_id": product["id"], "aov": 75})
    evidence(
        project,
        product["id"],
        "similarweb",
        monthly_visits=100_000,
        traffic_scope="domain",
        traffic_url="https://shop.example/",
        traffic_period="2026-09",
    )
    command(
        project,
        "add_sales_estimate",
        {
            "product_id": product["id"],
            "traffic_evidence_id": product["evidence"][-1]["id"],
            "cvr_low": 1,
            "cvr_base": 2,
            "cvr_high": 3,
            "cvr_source": "用户手工情景",
        },
    )

    text = research_report(project_view(project, now=NOW))
    assert "情景估算，不是真实测试" in text
    assert "domain" in text
    assert "商品级订单/营收：未知" in text
    assert "已确认测试记录：0" in text or "无已确认测试数据" in text


def test_report_shows_explicit_freshness_without_invented_meta_ttl():
    from tests.test_workbench_domain import NOW, evidence, identified_product

    project = new_project("时效报告", "旅行收纳")
    product = identified_product(project)
    evidence(project, product["id"], "meta", advertiser_count=4)

    text = research_report(project_view(project, now=NOW))
    assert "时效 unknown" in text
    assert "没有明确的复核或有效期限" in text


def test_report_defensively_removes_sensitive_url_parameters():
    p = new_project("URL 报告", "旅行收纳")
    apply_command(
        p,
        "add_product",
        {"name": "商品", "url": "https://shop.example/?p=123"},
    )
    p["products"][0]["url"] = (
        "https://shop.example/?p=123&token=SYNTHETIC_BEARER"
        "&X-Amz-Signature=SYNTHETIC_SIGNATURE"
    )

    text = research_report(project_view(p))

    assert "SYNTHETIC_BEARER" not in text
    assert "SYNTHETIC_SIGNATURE" not in text
    assert "https://shop.example/?p=123" in text


def test_report_explains_navigation_trends_and_keyword_provenance():
    p = new_project("证据链报告", "旅行收纳")
    apply_command(
        p,
        "add_product",
        {"name": "商品", "url": "https://shop.example/products/a"},
    )
    product = p["products"][0]
    product["landing_snapshot"] = {
        "requested_url": "https://shop.example/start",
        "http_final_url": "https://shop.example/redirected",
        "http_status_code": 200,
        "browser_final_url": "https://shop.example/products/a",
        "browser_status_code": 200,
        "final_url": "https://shop.example/products/a",
        "rendering_mode": "browser",
        "observed_at": "2026-09-18T08:00:00Z",
        "body_text": "FULL PRIVATE COLLECTION BODY MUST NOT LEAK",
    }
    product["automatic_trends"] = [
        {
            "window": "12m",
            "conclusion": "stable",
            "observed_at": "2026-09-18T08:00:00Z",
            "classification": {
                "classifier_version": "trend-window-v1",
                "label": "stable",
                "features": {"coverage": "1.0", "recent_mean": "70.0"},
            },
        }
    ]
    p["keywords"].append(
        {
            "id": "expanded-keyword",
            "text": '"carry on organizer"',
            "status": "pending_review",
            "parent_id": "parent-keyword",
            "source_kind": "ad",
            "source_keyword_id": "parent-keyword",
            "source_ad_id": "ad-123",
            "source_identity_revision": 2,
            "source_quote": "fits inside carry-on luggage",
        }
    )

    report = research_report(p)

    assert "浏览器最终地址" in report
    assert "HTTP 状态：200" in report
    assert "trend-window-v1" in report
    assert "来源广告 ad-123" in report
    assert "身份版本 2" in report
    assert "fits inside carry-on luggage" in report
    assert "FULL PRIVATE COLLECTION BODY MUST NOT LEAK" not in report


def test_funnel_counts_distinguish_triage_coarse_and_test_outcomes():
    from rabbit_hole.application.reports import selection_funnel

    counts = selection_funnel(guided_funnel_project())

    assert counts == {
        "discovered": 7,
        "pending": 1,
        "retained": 4,
        "observing": 1,
        "rejected": 1,
        "active_workload": 5,
        "coarse_passed": 3,
        "test_candidates": 2,
        "confirmed_tests": 1,
    }


def test_report_preserves_rejection_audit_and_uses_shared_funnel_counts():
    report = research_report(project_view(guided_funnel_project()))

    for expected in (
        "发现线索 7",
        "待筛 1",
        "保留 4",
        "观察 1",
        "淘汰 1",
        "当前工作量 5",
        "粗筛通过 3",
        "测试候选 2",
        "已确认测试 1",
        "广告与商品不相关",
        "重复商品档案",
    ):
        assert expected in report
    assert "SYNTHETIC_FUNNEL_SECRET" not in report


def test_report_period_summary_excludes_rejected_coarse_pass_from_current_count():
    project = guided_funnel_project()
    rejected = next(
        product for product in project["products"] if product["name"] == "rejected"
    )
    rejected["identification"] = {
        "relevance_confirmed": True,
        "active_days": 30,
        "distinct_active_creatives": 3,
        "passed": True,
    }

    report = research_report(project_view(project))

    assert "粗筛通过 3" in report
    assert "当前去重产品：7；粗筛通过：3。" in report


def test_report_treats_malformed_triage_as_pending_instead_of_crashing():
    project = guided_funnel_project()
    project["products"][0]["triage"] = "legacy-invalid-value"

    report = research_report(project_view(project))

    assert "初筛：待筛；理由：尚未填写" in report
