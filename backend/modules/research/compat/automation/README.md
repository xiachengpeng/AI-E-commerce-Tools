# 兔子洞选品自动化 MVP

这个目录把《兔子洞选品》中的判断规则变成一个可重复执行的流水线：

1. 从关键词或广告线索得到候选品。
2. 把候选品和多渠道证据填写到 CSV。
3. 自动计算含广告成本的贡献毛利率。
4. 执行硬门槛，失败项直接进入淘汰池。
5. 对通过硬门槛的产品按 25 分制评分。
6. 自动分入测试池、备选池或淘汰池，并生成 Markdown 报告。

这个 CSV 工具保留为离线兼容入口。正式 Phase 1 服务以飞书多维表格为业务工作台、PostgreSQL 为任务/检查点存储，并把自动流程停在`待人工复核`。部署、bootstrap、受控 Meta 冒烟、恢复和回滚请遵循 [`docs/operations/rabbit-hole-runbook.md`](../docs/operations/rabbit-hole-runbook.md)。

## 快速开始

```bash
cd automation
cp candidates.example.csv candidates.csv
python3 rabbit_hole.py candidates.csv --output report.md
```

脚本只使用 Python 标准库。`candidates.example.csv` 中有三个示例，运行后可先检查评分是否符合直觉，再替换成真实数据。

## CSV 字段

金额统一折算为美元；百分比填写数字，例如 `65` 表示 65%。多值字段使用竖线分隔。同一产品测试多个国家时，每个市场单独一行，因为售价、物流、税费、广告成本和趋势证据可能不同。

| 字段 | 含义 |
|---|---|
| `name` | 产品名，必填 |
| `target_market` | 目标市场代码，默认支持 `US` / `UK` / `EU` |
| `product_url` | 产品或竞品落地页 |
| `niche` | 细分领域 |
| `source_keyword` | 发现该产品的搜索词，用于月度复盘 |
| `audience/pain/scenario/selling_point` | 兔子洞四类关键词 |
| `price_usd` | 售价或预计客单价 |
| `product_cost_usd` | 货值 |
| `shipping_usd` | 运费 |
| `packaging_usd` | 包装 |
| `vat_duty_usd` | VAT 与关税预估 |
| `ad_cost_usd` | 单次成交的预估广告成本 |
| `weight_kg` | 包装后的发货重量 |
| `compliance_risk` | `low` / `medium` / `high` |
| `ip_risk` | 侵权风险：`low` / `medium` / `high` |
| `meta_active_days` | 同域名或落地页持续投放天数 |
| `meta_creatives` | 可确认的创意变体数 |
| `trend_12m/trend_5y` | `rising` / `stable` / `declining` / `peaked` / `unknown` |
| `amazon_validated` | 是否有真实购买验证：`yes` / `no` |
| `social_heat` | `rising` / `high` / `stable` / `low` / `unknown` |
| `pinterest_trend` | `rising` / `high` / `stable` / `low` / `unknown` |
| `creative_formats` | 如 `ugc|unboxing|before-after` |
| `creative_scenarios` | 如 `bedtime|travel|gift` |
| `supplier_verified` | 供应链和报价是否已确认：`yes` / `no` |
| `advertiser_count` | 观察到的同类活跃广告主数量；`0` 视为未知 |
| `brand_concentration` | `low` / `medium` / `high` / `unknown` |
| `direct_traffic_pct` | Similarweb 直接流量占比；未知可留空 |
| `landing_page_type` | `single-product` / `product` / `category` |
| `evidence_urls` | 证据链接，用 `|` 分隔 |
| `notes` | 补充说明 |

## 当前评分规则

- 需求与趋势 5 分：Meta 投放时长、12 个月趋势、5 年趋势、Amazon 购买验证、社媒/Pinterest 热度各 1 分。
- 素材空间 5 分：创意形式最多 2 分、使用场景最多 2 分、Meta 至少 3 个创意变体 1 分。
- 利润与物流 5 分：贡献毛利率最多 2 分，重量、价格带、供应链确认各 1 分。
- 竞争强度 5 分：广告主数量最多 2 分、品牌集中度最多 2 分、直接流量不高于 50% 得 1 分。
- 合规风险 5 分：合规风险最多 3 分，侵权风险最多 2 分。

分池规则沿用原笔记：`>=18` 进入首轮广告测试池，`15–17` 进入备选池，`<15` 淘汰。任何硬门槛失败都会直接淘汰，不以总分抵消。

## 自动化边界

当前版本故意把“采集”和“决策”分开。Meta 广告资料库、Amazon、Similarweb 等来源存在登录、地区、接口和反爬限制；第一阶段先由人收集证据、程序统一决策。验证评分模型后，再逐个接入浏览器自动化或正式 API，避免采集不稳定污染评分。
