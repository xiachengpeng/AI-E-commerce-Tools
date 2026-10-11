"""Human-readable exports of the current business state, never fabricated results."""

from __future__ import annotations

import html
import json
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from rabbit_hole.domain.project import active_test_results
from rabbit_hole.input_urls import sanitize_research_url_fields

STATE_NAMES = {
    "pending": "未开始",
    "needs_input": "待补充",
    "blocked": "待处理",
    "passed": "通过",
    "failed": "不通过",
    "not_applicable": "不适用",
    "complete": "完成",
    "incomplete": "证据不足",
    "rejected": "硬门槛未通过",
    "test": "测试池",
    "observe": "观察",
    "backup": "备选",
    "reject": "淘汰",
}

TRIAGE_NAMES = {
    "pending": "待筛",
    "retained": "保留",
    "observing": "观察",
    "rejected": "淘汰",
}


def _triage_state(product: dict[str, Any]) -> str:
    triage = product.get("triage")
    value = triage.get("state") if isinstance(triage, dict) else None
    return value if value in TRIAGE_NAMES else "pending"


def _is_current_candidate(product: dict[str, Any]) -> bool:
    return not product.get("merged_into") and _triage_state(product) not in {
        "observing",
        "rejected",
    }


def selection_funnel(project: dict[str, Any]) -> dict[str, int]:
    """Return one non-overlapping triage view plus downstream SOP stages."""
    products = [
        product
        for product in project.get("products", [])
        if not product.get("merged_into")
    ]

    triage_counts = {
        state: sum(_triage_state(product) == state for product in products)
        for state in TRIAGE_NAMES
    }
    candidates = [product for product in products if _is_current_candidate(product)]
    test_candidates = [
        product
        for product in candidates
        if (product.get("decision") or {}).get("pool") == "test"
        and not (product.get("decision") or {}).get("stale")
    ]
    return {
        "discovered": len(products),
        **triage_counts,
        "active_workload": triage_counts["pending"] + triage_counts["retained"],
        "coarse_passed": sum(
            bool(product.get("identification", {}).get("passed"))
            for product in candidates
        ),
        "test_candidates": len(test_candidates),
        "confirmed_tests": sum(
            any(result.get("confirmed") for result in active_test_results(product))
            for product in test_candidates
        ),
    }


def source_attribution(project: dict[str, Any]) -> list[dict[str, Any]]:
    """Assign each product once to its first recorded source, not causal credit."""
    rows: dict[str, dict[str, Any]] = {
        word["id"]: {
            "keyword": word["text"],
            "primary_products": 0,
            "assisting_products": 0,
            "qualified_products": 0,
            "test_pool_products": 0,
            "confirmed_records": 0,
            "confirmed_orders": None,
            "confirmed_revenue": None,
            "confirmed_spend": None,
        }
        for word in project.get("keywords", [])
    }
    seen: set[str] = set()
    for product in project.get("products", []):
        if product.get("merged_into"):
            continue
        if product["id"] in seen:
            continue
        seen.add(product["id"])
        sources = list(dict.fromkeys(product.get("source_keyword_ids", [])))
        if not sources:
            continue
        for source in sources[1:]:
            if source in rows:
                rows[source]["assisting_products"] += 1
        if sources[0] not in rows:
            continue  # Do not transfer missing primary-source credit to an assistant.
        row = rows[sources[0]]
        row["primary_products"] += 1
        eligible = _is_current_candidate(product)
        row["qualified_products"] += bool(
            eligible and product.get("identification", {}).get("passed")
        )
        decision = product.get("decision") or {}
        in_test_pool = bool(
            eligible
            and decision.get("pool") == "test"
            and not decision.get("stale")
            and decision.get("score_revision") == product.get("revision")
            and all(
                s["state"] == "passed"
                for s in product.get("steps", [])
                if s["key"] == "decision"
            )
        )
        row["test_pool_products"] += in_test_pool
        if not in_test_pool:
            continue
        for result in active_test_results(product):
            if result.get("confirmed") is not True:
                continue
            row["confirmed_records"] += 1
            for source, target in [
                ("orders", "confirmed_orders"),
                ("revenue", "confirmed_revenue"),
                ("spend", "confirmed_spend"),
            ]:
                if result.get(source) is not None:
                    row[target] = round((row[target] or 0) + result[source], 2)
    for row in rows.values():
        count = row["primary_products"]
        row["qualified_rate"] = (
            round(row["qualified_products"] / count * 100, 2) if count else None
        )
        row["test_pool_rate"] = (
            round(row["test_pool_products"] / count * 100, 2) if count else None
        )
    return list(rows.values())


def period_summary(project: dict[str, Any]) -> list[str]:
    now = datetime.now(ZoneInfo("Asia/Shanghai"))
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    lines = [
        "## 日 / 周 / 月复盘概览",
        "",
        "时间口径：北京时间；统计已记录事实，不代表已实现销售。",
        "",
    ]

    def within(item: dict[str, Any], start: datetime) -> bool:
        stamp = item.get("created_at", item.get("recorded_at"))
        return bool(stamp and start <= datetime.fromisoformat(stamp) <= now)

    for label, start in [
        ("今天", today),
        ("本周", today - timedelta(days=today.weekday())),
        ("本月", today.replace(day=1)),
    ]:
        words = [w for w in project.get("keywords", []) if within(w, start)]
        products = [
            p
            for p in project.get("products", [])
            if not p.get("merged_into") and within(p, start)
        ]
        reviews = [
            r
            for p in project.get("products", [])
            if not p.get("merged_into")
            for r in p.get("reviews", [])
            if within(r, start)
        ]
        lines.append(
            f"- {label}：新增关键词 {len(words)}；新增产品线索 {len(products)}；记录复盘 {len(reviews)}。"
        )
    products = [p for p in project.get("products", []) if not p.get("merged_into")]
    passed = selection_funnel(project)["coarse_passed"]
    lines.extend(
        [
            "",
            f"当前去重产品：{len(products)}；粗筛通过：{passed}。",
            "首次发现与辅助来源分开追踪，同一产品不重复计入通过数。",
        ]
    )
    results = [
        result
        for product in products
        for result in active_test_results(product)
        if result.get("confirmed")
    ]
    lines.append(
        f"已确认测试记录：{len(results)}；不同产品与周期不可直接合并转化率。"
        if results
        else "无已确认测试数据，不能统计测试成功率、实销或已实现利润。"
    )
    lines.extend(["", "样本不足时不自动提升关键词优先级；新一轮关键词仍需审核。", ""])
    return lines


def research_report(
    project: dict[str, Any], intelligence: dict[str, Any] | None = None
) -> str:
    sanitized = sanitize_research_url_fields(project)
    if not isinstance(sanitized, dict):
        raise TypeError("project must be an object")
    project = sanitized

    def safe(value: Any) -> str:
        return html.escape(str(value)).replace("`", "\\`").replace("\n", " ")

    lines = [
        f"# {safe(project['title'])} · 研究报告",
        "",
        f"市场：{safe(project['market'])} ｜ 数据版本：{project['version']}",
        f"更新：{safe(project['updated_at'])}",
        "",
        f"研究方向：{safe(project['direction'])}",
        "",
        "> 来源未配置或证据不足不代表通过。人工证据、自动观察和经营结论必须分开理解。",
        "",
    ]
    counts = selection_funnel(project)
    lines.extend(
        [
            "## 选品漏斗",
            "",
            (
                f"发现线索 {counts['discovered']}；待筛 {counts['pending']}；"
                f"保留 {counts['retained']}；观察 {counts['observing']}；"
                f"淘汰 {counts['rejected']}；当前工作量 {counts['active_workload']}。"
            ),
            (
                f"粗筛通过 {counts['coarse_passed']}；"
                f"测试候选 {counts['test_candidates']}；"
                f"已确认测试 {counts['confirmed_tests']}。"
            ),
            "保留只代表进入深挖，不代表已通过30天及3个独立活跃创意的粗筛门槛。",
            "",
        ]
    )
    lines.extend(period_summary(project))
    lines.extend(
        [
            "## 当前规则与版本历史",
            "",
            f"规则版本：{project.get('rules_version', 1)}；调整规则不改写历史评分。",
            "```json",
            json.dumps(
                {
                    "rules": project.get("rules", {}),
                    "history": project.get("rule_history", []),
                },
                ensure_ascii=False,
                indent=2,
            ).replace("```", "\\`\\`\\`"),
            "```",
            "",
            "## 首次发现 / 辅助来源归因",
            "",
            "口径：累计已记录数据，按产品首次来源归属；辅助来源仅计协助数，不重复计收入。不是因果归因或自然月经营报表。",
            "销售额和广告花费仅来自已确认测试记录；缺少实际货值、退款金额及履约等账单，不能据此计算已实现利润。",
            "",
        ]
    )
    for row in source_attribution(project):
        lines.append(
            f"- {safe(row['keyword'])}：首次发现 {row['primary_products']}，辅助发现 {row['assisting_products']}，当前粗筛通过 {row['qualified_products']}，当前测试池 {row['test_pool_products']}。"
        )
        if row["confirmed_records"]:
            lines.append(
                f"  - 已确认测试：{row['confirmed_records']} 条；订单 {row['confirmed_orders']}；销售额 USD {row['confirmed_revenue']}；广告花费 USD {row['confirmed_spend']}。不代表已实现利润。"
            )
        else:
            lines.append("  - 尚无归属此词的已确认测试记录；不能推断测试表现。")
    lines.extend(["## 关键词路径", ""])
    words = {x["id"]: x["text"] for x in project.get("keywords", [])}
    for word in project.get("keywords", []):
        lines.append(
            f"- {safe(word['text'])} ｜ {safe(word['status'])} ｜ 父词：{safe(words.get(word.get('parent_id'), '初始词'))}"
        )
        if word.get("source_kind"):
            source_label = (
                f"来源广告 {safe(word.get('source_ad_id', '未知'))}"
                if word.get("source_kind") == "ad"
                else "来源商品页"
            )
            lines.append(
                "  - "
                f"{source_label}；来源关键词 {safe(word.get('source_keyword_id') or '无')}；"
                f"身份版本 {safe(word.get('source_identity_revision', '未知'))}；"
                f"短引用：{safe(word.get('source_quote', ''))}"
            )
    concepts = project.get("product_concepts", [])
    if concepts:
        lines.extend([
            "", "## 同款商品与卖家档案", "",
            "人工确认的同款关系；各卖家商品仍是独立档案，评分、物流、价格和测试结果不合并。",
        ])
        products_by_id = {
            item["id"]: item for item in project.get("products", [])
            if not item.get("merged_into")
        }
        for concept in concepts:
            status = "当前关联" if concept.get("status") == "active" else "已结束，保留历史"
            lines.append(f"### {safe(concept.get('name', '未命名同款'))} · {status}")
            for offer_id in concept.get("offer_ids", []):
                offer = products_by_id.get(offer_id)
                if offer:
                    lines.append(
                        f"- 卖家档案：{safe(offer.get('name', '未命名'))} ｜ "
                        f"{safe(offer.get('url', '链接未知'))}"
                    )
            for event in concept.get("history", []):
                lines.append(
                    f"- 历史：{safe(event.get('at', '时间未知'))} · "
                    f"{safe(event.get('action', '操作未知'))} · "
                    f"{safe(event.get('reason', '无补充理由'))}"
                )
            lines.append("")
    lines.extend(["", "## 产品档案", ""])
    products = [p for p in project.get("products", []) if not p.get("merged_into")]
    if not project.get("products"):
        lines.append("尚未形成具体产品；不能据此宣称已有合格候选品。")
    for product in products:
        triage_value = product.get("triage")
        triage = triage_value if isinstance(triage_value, dict) else {}
        triage_state = triage.get("state")
        triage_label = (
            TRIAGE_NAMES.get(triage_state, "待筛")
            if isinstance(triage_state, str)
            else "待筛"
        )
        lines.extend(
            [
                f"### {safe(product['name'])}",
                "",
                f"来源：{safe(product.get('url') or '待识别具体商品')}",
                f"初筛：{safe(triage_label)}；理由：{safe(triage.get('reason') or '尚未填写')}",
                "",
            ]
        )
        signal = product.get("evergreen_signal") or {}
        signal_names = {
            "observed": "观察到长期广告存续线索",
            "not_observed": "目前未观察到一年以上存续线索",
            "unknown": "未知，证据不足",
        }
        signal_status = str(signal.get("status") or "unknown")
        lines.extend([
            "#### 辅助研究（不改变评分与硬门槛）", "",
            (
                f"- 常青信号：{safe(signal_names.get(signal_status, '未知，证据不足'))}；"
                f"广告年龄 {safe(signal.get('age_days') if signal.get('age_days') is not None else '未知')} 天。"
                " 不证明持续投放或盈利。"
            ),
        ])
        references = product.get("creative_references") or []
        if references:
            lines.append("- 创意参考：仅记录结构与来源，不复制第三方素材。")
            for item in references:
                lines.append(
                    f"  - {safe(item.get('source_ad_id', '未知'))} · "
                    f"{safe(item.get('format', '未知形式'))} · "
                    f"Hook：{safe(item.get('hook', ''))} · "
                    f"模式：{safe(item.get('pattern_note', ''))} · "
                    f"来源：{safe(item.get('source_url', ''))} · "
                    f"观察：{safe(item.get('observed_at', ''))}"
                    f"{' · 旧商品身份，仅供历史参考' if item.get('stale_identity') else ''}"
                )
        investigations = product.get("funnel_investigations") or []
        if investigations:
            lines.append("- 漏斗调查：脚本存在只表示观察，不代表邮件、弃购或再营销流程可用。")
            area_names = {
                "email_marketing": "邮件营销", "abandoned_cart": "弃购",
                "analytics": "分析追踪", "retargeting": "再营销",
            }
            for item in investigations:
                lines.append(
                    f"  - {safe(area_names.get(item.get('area'), item.get('area', '未知')))}："
                    f"{safe(item.get('status', 'unknown'))} · "
                    f"方法 {safe(item.get('method') or '未记录')} · "
                    f"来源 {safe(item.get('source_url') or '未记录')} · "
                    f"观察 {safe(item.get('observed_at') or '未记录')}"
                    f"{' · 旧商品身份，仅供历史参考' if item.get('stale_identity') else ''}"
                )
        lines.append("")
        landing = product.get("landing_snapshot")
        if isinstance(landing, dict):
            lines.extend(
                [
                    "#### 自动页面观察",
                    "",
                    f"- 请求地址：{safe(landing.get('requested_url', '旧记录未保存'))}",
                    f"- HTTP 最终地址：{safe(landing.get('http_final_url', '旧记录未保存'))}；HTTP 状态：{safe(landing.get('http_status_code', '旧记录未保存'))}",
                    f"- 浏览器最终地址：{safe(landing.get('browser_final_url', '未使用或旧记录未保存'))}；浏览器状态：{safe(landing.get('browser_status_code', '未使用或旧记录未保存'))}",
                    f"- 业务最终地址：{safe(landing.get('final_url') or landing.get('source_url', '未知'))}；渲染方式：{safe(landing.get('rendering_mode', '旧记录未保存'))}；观察时间：{safe(landing.get('observed_at', ''))}",
                    "",
                ]
            )
        trends = product.get("automatic_trends")
        if isinstance(trends, list) and trends:
            lines.extend(["#### 自动 Trends 窗口分类", ""])
            for item in trends:
                classification = item.get("classification") or {}
                features = classification.get("features") or {}
                summary = {
                    key: features[key]
                    for key in sorted(features)[:6]
                    if isinstance(key, str)
                }
                lines.append(
                    f"- {safe(item.get('window', ''))}：{safe(item.get('conclusion', ''))}；"
                    f"分类器 {safe(classification.get('classifier_version', '旧记录未保存'))}；"
                    f"特征摘要 {safe(json.dumps(summary, ensure_ascii=False, default=str))}；"
                    f"观察时间 {safe(item.get('observed_at', ''))}。"
                )
            lines.append("")
        for step in product.get("steps", []):
            lines.append(
                f"- {safe(step['label'])}：{safe(STATE_NAMES.get(step['state'], step['state']))}；{safe(step.get('reason', ''))}"
            )
        lines.extend(["", "#### 来源证据", ""])
        for evidence in product.get("evidence", []):
            lines.append(
                f"- {safe(evidence.get('channel'))} / {safe(evidence.get('window', ''))}：{safe(evidence.get('conclusion', ''))}；来源 {safe(evidence.get('source_url', ''))}；采集 {safe(evidence.get('observed_at', ''))}；确认 {safe(evidence.get('confirmed', False))}；时效 {safe(evidence.get('freshness_status', 'unknown'))}（{safe(evidence.get('freshness_reason', '没有明确有效期限'))}）；{safe(evidence.get('notes', ''))}"
            )
            if evidence.get("not_applicable"):
                lines.append(
                    f"  - 有限证据 / 渠道豁免：{safe(evidence.get('reason', '未填写理由'))}"
                )
        quote_freshness = (product.get("economics") or {}).get("quote_freshness")
        if isinstance(quote_freshness, dict):
            lines.append(
                f"- 供应商报价时效：{safe(quote_freshness.get('status', 'unknown'))}；"
                f"有效至 {safe(quote_freshness.get('valid_until') or '未知')}；"
                f"{safe(quote_freshness.get('reason', ''))}"
            )
        estimates = product.get("estimates") or []
        if estimates:
            lines.extend(["", "#### 情景估算，不是真实测试", ""])
            for estimate in estimates:
                scenarios = estimate.get("scenarios") or {}
                lines.append(
                    f"- 范围 {safe(estimate.get('traffic_scope', 'unknown'))}；"
                    f"流量证据 {safe(estimate.get('traffic_evidence_id', '未知'))}；"
                    f"CVR 来源 {safe(estimate.get('cvr_source', '未知'))}；"
                    f"{'历史/需重算' if estimate.get('stale') else '当前输入快照'}。"
                )
                for name in ("low", "base", "high"):
                    row = scenarios.get(name) or {}
                    lines.append(
                        f"  - {name}：月订单 {safe(row.get('monthly_orders', '未知'))}；"
                        f"月营收 USD {safe(row.get('monthly_revenue', '未知'))}。"
                    )
                if scenarios.get("product_monthly_revenue") is None:
                    lines.append("  - 商品级订单/营收：未知；不可从域名或店铺流量推断。")
                else:
                    lines.append("  - 商品级订单/营收：仅为本情景估算，不是真实销量。")
        scores = product.get("scores")
        current_score = scores[-1] if isinstance(scores, list) and scores else None
        if isinstance(current_score, dict):
            lines.extend(["", "#### 当前评分解释", ""])
            lines.append(
                f"评分契约：{safe(current_score.get('score_version', '旧记录未保存'))}；"
                f"项目规则版本：{safe(current_score.get('rule_version', '未知'))}；"
                f"状态：{safe(current_score.get('status', '未知'))}；"
                f"总分：{safe(current_score.get('total', '未计算'))}。"
            )
            lines.extend(["", "##### 五维评分", ""])
            dimensions = current_score.get("dimensions") or []
            if not dimensions:
                lines.append(
                    f"尚未形成五维分数：{safe(current_score.get('recommendation', '证据不足或需要人工复核'))}"
                )
            for dimension in dimensions:
                lines.append(
                    f"- {safe(dimension.get('key', '未知维度'))}："
                    f"{safe(dimension.get('score', '未计算'))}/5；"
                    f"{safe(dimension.get('reason', ''))}"
                )
                lines.append(
                    f"  - 规则：{safe(', '.join(dimension.get('rule_ids', [])) or '旧记录未保存')}"
                )
                lines.append(
                    f"  - 证据：{safe(', '.join(dimension.get('evidence_ids', [])) or '无')}"
                )
                lines.append(
                    f"  - 计算：{safe(dimension.get('calculation', '旧记录未保存'))}"
                )
                if dimension.get("missing_evidence"):
                    lines.append(
                        f"  - 缺失：{safe(', '.join(dimension['missing_evidence']))}"
                    )
            lines.extend(["", "##### 最终硬门槛", ""])
            gates = current_score.get("final_gates") or []
            if not gates:
                lines.append("旧评分未保存结构化硬门槛明细。")
            for gate in gates:
                lines.append(
                    f"- {safe(gate.get('key', '未知门槛'))}："
                    f"{safe(gate.get('status', 'unknown'))}；"
                    f"{safe(gate.get('reason', ''))}"
                )
                lines.append(f"  - 规则：{safe(gate.get('rule_id', '旧记录未保存'))}")
                lines.append(
                    f"  - 证据：{safe(', '.join(gate.get('evidence_ids', [])) or '无')}"
                )
        for field, label in [
            ("funnel", "漏斗拆解"),
            ("economics", "订单经济数据"),
            ("quote_history", "历史报价对比（当前测算之外，不自动复用旧报价）"),
            ("scores", "评分历史（审计明细）"),
            ("decision", "人工决策"),
            ("decision_history", "历史决策"),
            ("test_plan", "测试准备包"),
            ("test_runs", "测试轮次历史"),
            ("test_results", "测试数据"),
            ("reviews", "复盘"),
        ]:
            lines.extend(["", f"#### {label}", ""])
            value = product.get(field)
            lines.append(
                "尚无记录"
                if not value
                else "```json\n"
                + json.dumps(value, ensure_ascii=False, indent=2, default=str).replace(
                    "```", "\\`\\`\\`"
                )
                + "\n```"
            )
    merged = [
        *project.get("merged_products", []),
        *(p for p in project.get("products", []) if p.get("merged_into")),
    ]
    if merged:
        lines.extend(["", "## 已合并档案历史", ""])
        for product in merged:
            lines.append(
                f"- {safe(product.get('name'))} → {safe(product.get('merged_into'))}；理由：{safe(product.get('merge_reason', ''))}；时间：{safe(product.get('merged_at', ''))}。"
            )
            lines.append(
                f"  - 来源档案摘要：来源关键词 {safe(', '.join(product.get('source_keyword_ids', [])) or '无')}；身份 {safe(product.get('identity_key', '未知'))}。来源档案测试结果未转记。"
            )
    if intelligence is not None:
        window = intelligence.get("window") or {}
        lines.extend([
            "", "## 研究洞察（描述性统计）", "",
            f"累计窗口：{safe(window.get('start', '未知'))} → {safe(window.get('end', '未知'))}。",
            safe(intelligence.get("association_note", "跨关键词关联数不可相加。")),
            "比例均展示分子/分母；分母为零表示样本不足，不做排序或自动调权重结论。",
            "", "### 关键词与明确类型", "",
        ])

        def ratio(value: dict[str, Any]) -> str:
            numerator, denominator = value.get("numerator", 0), value.get("denominator", 0)
            percent = value.get("percent")
            return f"{numerator}/{denominator}（{percent}%）" if percent is not None else f"{numerator}/{denominator}（样本不足）"

        if not intelligence.get("keywords"):
            lines.append("暂无关键词；没有可比较的表现。")
        for word in intelligence.get("keywords", []):
            scan_attempts = word.get("scan_attempts")
            scan_label = safe(scan_attempts) if scan_attempts is not None else "旧记录不可还原"
            lines.append(
                f"- {safe(word.get('text', ''))}（{safe(word.get('type', ''))}）："
                f"扫描尝试 {scan_label}；去重广告 {safe(word.get('ads_found', 0))}；"
                f"关联商品 {safe(word.get('associated_products', 0))}；"
                f"首次 {safe(word.get('primary_products', 0))}、辅助 {safe(word.get('assisting_products', 0))}；"
                f"当前保留 {ratio(word.get('retained_rate') or {})}；"
                f"当前测试池 {ratio(word.get('test_pool_rate') or {})}。"
            )
        lines.extend(["", "### 类型关联", ""])
        for row in intelligence.get("keyword_types", []):
            lines.append(
                f"- {safe(row.get('type', ''))}：{safe(row.get('keywords', 0))} 个词；"
                f"关联商品 {safe(row.get('associated_products', 0))}；"
                f"当前保留 {ratio(row.get('retained_rate') or {})}。"
            )
        lines.extend(["", "### 发现来源，不是因果归因", ""])
        source_labels = {"meta": "Meta", "unattributed": "来源未明确", "amazon": "Amazon", "tiktok": "TikTok", "pinterest": "Pinterest", "similarweb": "Similarweb"}
        for row in intelligence.get("discovery_sources", []):
            label = safe(source_labels.get(row.get("source"), row.get("source", "未知")))
            if row.get("status") == "not_observed":
                lines.append(f"- {label}：暂无可归因发现记录；不是 0% 成功率。")
            else:
                lines.append(
                    f"- {label}：当前商品线索 {safe(row.get('candidate_products', 0))}；"
                    f"保留 {ratio(row.get('retained_rate') or {})}。"
                )
        lines.extend(["", "### 已确认测试与原定 CPA 目标", ""])
        if not intelligence.get("calibration"):
            lines.append("无可比的已确认测试轮次；销量情景和草稿不当作真实测试。")
        for row in intelligence.get("calibration", []):
            result = "高于目标" if row.get("comparison") == "above_target" else "达到或低于目标"
            lines.append(
                f"- {safe(row.get('product_name', ''))} / 轮次 {safe(row.get('run_id', ''))}："
                f"确认记录 {safe(row.get('confirmed_records', 0))}；"
                f"实际 CPA {safe(row.get('actual_cpa'))}，原定目标 {safe(row.get('target_cpa'))}；"
                f"原评分 {safe(row.get('score_total'))} / 规则版本 {safe(row.get('score_rule_version'))}；{result}。"
            )
        for prompt in intelligence.get("review_prompts", []):
            lines.append(f"- 人工复核提示：{safe(prompt.get('message', ''))}")
    lines.extend(["", "## 当前待办", ""])
    for todo in project.get("todos", []):
        lines.append(
            f"- {safe(todo.get('label', todo.get('step', '')))}：{safe(todo.get('reason', ''))}"
        )
    lines.extend(
        [
            "",
            "## 复盘口径",
            "",
            "关键词被发现和产品采集不等于成交。无真实测试结果时不统计测试成功率；同一产品多来源不能重复归因。",
            "本报告不代表已创建广告、已花费预算或已采购。",
        ]
    )
    return "\n".join(lines) + "\n"
