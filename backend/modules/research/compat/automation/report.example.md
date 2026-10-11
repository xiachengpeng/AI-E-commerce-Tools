# 兔子洞选品评估报告

数据源：`candidates.example.csv`　候选品：3 个

| 产品 | 市场 | 贡献毛利率 | 总分 | 结论 |
|---|---|---:|---:|---|
| Portable pet paw cleaner | US | 62.9% | 24/25 | 首轮广告测试池 |
| Foldable desk organizer | UK | 40.0% | 19/25 | 淘汰池（硬门槛） |
| Oversized glass lamp | EU | 2.2% | 6/25 | 淘汰池（硬门槛） |

## Portable pet paw cleaner · US

产品页：https://example.com/paw-cleaner

评分：需求趋势 5/5；素材空间 5/5；利润物流 4/5；竞争强度 5/5；合规风险 5/5

结论：**首轮广告测试池**

硬门槛：全部通过。

证据：

- https://example.com/evidence-1
- https://example.com/evidence-2

备注：Strong worked example

## Foldable desk organizer · UK

产品页：https://example.com/desk-organizer

评分：需求趋势 4/5；素材空间 5/5；利润物流 2/5；竞争强度 3/5；合规风险 5/5

结论：**淘汰池（硬门槛）**

硬门槛失败：

- 贡献毛利率 40.0% < 60%

证据：

- https://example.com/evidence-3

备注：Borderline example

## Oversized glass lamp · EU

产品页：https://example.com/glass-lamp

评分：需求趋势 0/5；素材空间 2/5；利润物流 1/5；竞争强度 0/5；合规风险 3/5

结论：**淘汰池（硬门槛）**

硬门槛失败：

- 贡献毛利率 2.2% < 60%
- 重量 5.5kg 不符合 0–2kg
- 12个月趋势为 peaked
- 5年趋势为 declining

备注：Hard-gate failure example
