# 兔子洞选品 Phase 1 运维手册

本文档适用于第一阶段的 US 选品闭环。系统只收集、评分和回写到`待人工复核`；它绝不自动把产品写入测试池、备选池或淘汰池。

## 发布前检查

- 使用可安装自建应用的飞书组织，应用仅授予目标 Base 的读取、创建和更新权限。服务帐户不可访问无关 Base。
- 为服务准备 PostgreSQL 16、私有（private）S3 兼容对象存储和可运行 Chromium 的容器环境。对象存储桶必须启用版本控制，禁止匿名读取，证据只保存对象 ID、摘要和受限的短期签名读取链接。
- 在 `.env` 中填入飞书应用、数据库、对象存储和 AI 凭据；不要把 `.env`、Chrome/飞书登录目录或 Meta cookie 提交、挂载到镜像或共享给其他人。
- US 订单级成本输入必须完整：预计订单组合、订单件数、单品售价、预计客单价、订单货值、运费、包装、税费/关税、广告成本、支付 payment 百分比/固定费及退款/拒付 reserve。任一项未知时系统只能进入待补充，不能生成最终评分。

## 初始化与启动

1. 复制 `.env.example` 为 `.env`，将 `RABBIT_HOLE_POSTGRES_PASSWORD` 与数据库 URL 的密码设为同一强密码；为 S3 访问账号设置独立强密钥。
2. 先渲染配置：`docker compose config --quiet`。确认数据库和 MinIO 没有 host 端口映射，API 仅绑定 `127.0.0.1:8000`。
3. 启动依赖并构建服务：`docker compose up -d --build db minio minio-init api worker`。
4. 在 API 容器中执行迁移：`docker compose exec api alembic upgrade head`。当前迁移修订为 `0003_daily_admission`；发布时把实际镜像 digest 与 `alembic current` 输出记录在变更单中。
5. 检查 `curl -fsS http://127.0.0.1:8000/health`，随后用 `curl -fsS http://127.0.0.1:8000/ready` 确认数据库、私有版本化存储与飞书 token 都就绪。`/metrics` 是 Prometheus 文本端点，不包含记录 ID、URL 或密钥。

## 飞书 Base：先演练，后写入

绝不把 bootstrap 指向现有生产 Base 做试验。对一个清晰命名的可删除 staging Base，先执行：

```bash
docker compose exec api python -m rabbit_hole.cli bootstrap-feishu --dry-run
```

dry-run 必须报告九张业务表、所有字段和所需视图，且不产生写入。确认目标 Base token 后才运行不带 `--dry-run` 的同一命令。bootstrap 只创建缺失项；发现字段类型或选项不兼容时停止并人工处理，不会删除、覆盖或重建已有字段。

九张业务表是：细分领域池、关键词库、搜索批次、产品主表、市场评估表、广告与素材、证据表、供应商报价和评分记录。运行时告警是搜索批次中的受控 `AUTO` 告警行，视图必须按记录类型过滤，不能把它当作研究批次。

## 人工输入与每日准入

### 本地可视化工作台

服务启动后打开 `http://127.0.0.1:8000/`。工作台每 5 秒读取真实任务状态，展示全量任务计数、最近 100 条任务的持久化阶段、采集数量、业务结果、重试时间和执行器心跳。支持按状态筛选与关键词/任务 ID 搜索。刷新失败会保留旧结果并明确提示数据已过期。

工作台只读，不触发任务或修改飞书。资料填写、重新触发与最终复核继续在飞书操作。阶段“未记录”不表示完成，“已跳过”不表示失败；任务成功也不代表最终进入测试池。API 无公共访问认证，必须保持 Compose 的 `127.0.0.1` 绑定，不得直接暴露到公网或转发共享。

- 链接验证使用市场评估表的 `人工｜广告或落地页链接`、`人工｜通用产品词`、`人工｜产品名称`；也可只关联一个产品主记录，系统读取并锁定其版本。Meta ID 链接必须补通用产品词，不能用 `ads/library` 当作产品词。
- 人工风险、素材可行性证据须勾选 `人工｜证据已确认`。供应商报价须显式确认有效、已确认、可信度、来源和带时区采集时间（最长 14 天）；Bundle 必须有依据并勾选订单组合确认。缺失不按零分处理，重新验证会清空过时的当前分数/毛利率，保留历史快照。
- 领域初始化使用 `人工｜选择大类`；AI 生成卡片保留未知观察数据。人工补齐研究卡、确认 Trends 来源和 5–10 个 Meta 代表词观察，批准领域后勾选研究确认及生成种子词。每批生成 60 个待审核词；不自动启用或扫描。
- `RABBIT_HOLE_ADMISSION__*` 控制每市场 UTC 日的关键词、扫描、候选品、预计 AI 次数与预计美元费用准入；默认 20/50/50、500 次和 USD 10。预估单次价格由运维配置，不代表供应商实际收费。配额记在 PostgreSQL `daily_usage`，重启不清零；重复任务不重复计费。已获准工作继续完成，超额新触发保留原状态、下一个 UTC 日才可再次准入；无 Phase 3 定时扫描。
- 预计调用数按种子批次 60 次、领域初始化 12 次、其他任务 1 次保守展示；不是实际 token 账单，重试或生成重复词可能增加实际费用。上线前按所选模型和重试负载校准单次预算估计。
- Trends 阈值通过 `RABBIT_HOLE_TREND_THRESHOLDS__*` 配置，实际阈值随证据保存。改变阈值或规则后只对新验证生效，不覆盖旧评分记录。

## 受控 staging 验收

1. 在 disposable Base 手动把一个已审核 US 关键词设为`待扫描`，然后运行 `python -m rabbit_hole.cli poll-once` 和 `python -m rabbit_hole.cli worker-once`。重复 poll 同一记录，确认幂等键不产生重复任务。
2. 手动提交一个 Meta 广告或落地页链接，补全全部订单级成本并设为`开始验证`，再执行同样的 poll/worker 命令。确认落地页首屏、信任证明、FAQ、Bundle、折扣均明确或为未知；分数历史新增而不是覆盖旧记录。
3. 以保存的页面夹具验证白屏恢复、延迟重试、截断和 CAPTCHA 的显式状态。公开 Meta 广告资料库搜索无需预先提供登录会话。受控运行 `python -m rabbit_hole.cli meta-smoke --market US --query 'portable organizer' --limit 5`，检查实际搜索词为 `"portable organizer"`，并验证 US、active、video、exact_phrase 的页面读回值及真实截图，才可声明实时 Meta 冒烟通过。程序会自动补一对英文双引号；已输入的英文或中文外层引号会规范化。
4. 如果 Meta 出现 CAPTCHA、页面结构漂移或连续白屏，不尝试规避限制。保留截图/检查点，按系统的即时与延迟重试策略运行；第六次失败进入`需人工处理`。修复后由人工显式 requeue，不要手工篡改任务行。
5. 确认所有自动处理结果最终只到`待人工复核`或明确的待补充/观察/人工状态。最终业务分池只能由人完成并填写原因。

如果没有认证可用的 disposable Base、可访问的公开 Meta 页面或真实对象存储，就记录具体的 staging blocker；不得把假 Feishu、固定 HTML 或本地模拟成功表述为线上验收成功。超时本身不能证明需要登录。

公开页由 `PublicMetaPage` 读取，测试 HTML 由 `PlaywrightMetaPage` 读取，两者不可互作实时验收证明。公开页当前支持英文与简体中文，使用页面实际广告容器及资料库编号确定卡片边界。未知页面结构会报错。广告文案命中搜索词不代表已确认产品相关性；未验证的视频指纹、商品页类型与创意差异保留未知，后续业务记录会进入待识别/待确认流程。

## 监控、告警和恢复

- 在代理使用 fake-IP DNS（如域名解析为 `198.18.*`）的环境，可显式设置 `RABBIT_HOLE_PUBLIC_DNS=google` 后重建服务。它通过 Google DNS HTTPS 查询公开域名（Google 会收到域名查询），仍拒绝内网/保留地址并固定连接到已验证 IP；默认 `system` 不改变系统 DNS。不要通过允许保留地址来修复采集失败。
- Trends 页面或时间序列请求返回 HTTP 401/403/429 时记录 `access_restricted`；429 是来源限流，不意味着需要登录。等待来源恢复或使用产品支持的合规人工输入，不切换身份或代理规避限制。真实 Trends 未成功时不得宣称市场评分全链路实时验收通过。

- `/health` 仅表示 API 进程存活；`/ready` 同时检查 PostgreSQL、对象存储的私有/版本化属性和飞书 token。
- `/metrics` 包含队列深度、任务时长、采集器成功/失败、Meta recovery/CAPTCHA、飞书 outbox 年龄与深度、AI schema failure 和每日候选品数。
- 以下阈值会创建幂等 runtime alert：任务等待 2 小时、一个采集器连续失败 5 次、outbox 最老事件超过 15 分钟、当天 Meta 成功率低于 70%。`runtime_alerts` 保存 `first_seen`、`last_seen`、`occurrence_count`、`sent_count` 和事件指纹；重复监控 tick 只更新时间，不增加次数，只有新事件指纹才增加 `occurrence_count`。告警投递失败会在 PostgreSQL 中保留待投递记录并重试；搜索批次告警行使用稳定键并以绝对的首次/最后时间和累计次数更新，避免重复提醒。
- 排障顺序：先看 `/ready` 和 `/metrics`，再查任务检查点、outbox 和证据对象 ID；不要把原始 HTML、完整 URL 查询参数或凭据贴到工单。
- 只可通过 `python -m rabbit_hole.cli requeue <job-id>` 重排合法的显式失败任务。对于输入已变更、CAPTCHA 或供应商报价问题，先在飞书修正人工输入并重新触发。

## 规则、证据与备份

- 当前评分规则版本为 `phase1-v2`。规则升级必须使用新版本号，保留评分记录及输入/证据快照；不得覆盖历史分数。
- 保留证据到其不可变 retention date。`python -m rabbit_hole.cli purge-expired-evidence --dry-run` 只能列出候选对象，正式清理需经单独变更流程；对象版本删除必须匹配原始 VersionId。
- 每日备份 PostgreSQL，并对 MinIO 数据和版本清单做加密、受限访问的备份。恢复演练使用独立环境，先恢复数据库，再恢复对应对象版本和 manifest。

## 回滚（rollback）

记录本次镜像 digest、迁移修订、评分规则版本 `phase1-v2`、Meta/landing/trends collector 版本和 AI 模型版本。发现发布问题时：停止 worker 消费，保留任务/检查点和证据，部署上一个已验证 image digest，然后运行 `alembic current`。只有经过测试的可逆迁移才允许 `alembic downgrade <previous_revision>`；数据迁移或证据 schema 不可逆时恢复数据库备份，不要盲目降级。API 恢复后先检查 `/ready`，再由人工逐项 requeue。
