# AGENTS.md 项目指南全面同步设计

## 目标

将根目录 `AGENTS.md` 更新为与当前代码一致的精简项目操作手册，让后续开发者能够快速定位功能、理解 AI 调用链、正确运行测试，并避免提交本地状态或破坏已确认的业务约束。

## 文档结构

更新后的 `AGENTS.md` 包含：

1. 项目概览与当前功能。
2. 核心入口与前端模块职责。
3. 后端服务职责与 AI 调用链。
4. 运行、CSS 构建、测试和语法检查命令。
5. SQLite、环境变量、生成资产、工作区和日志的本地状态边界。
6. AI 路由、设置、日志、详情页、方图重绘、历史和竞品分析的实现约束。

## 关键内容

- 浏览器 AI 请求必须经过 `callAI(capability)` 和 `/api/ai/generate`。
- 后端通过 `AIRouter`、SQLite 能力绑定和协议 adapter 路由文本与图片能力。
- 支持 Gemini、Vertex AI 和 OpenAI Compatible 提供商；保存设置立即生效并持久化。
- 设置页实时日志属于当前进程内存状态，并必须保持敏感信息脱敏。
- 详情页产品必须忠实于上传素材，模块默认不选，模块可独立选择是否包含新增文案。
- 文本翻译支持多语言批处理与中文目标语言。
- 新 worktree 中被忽略的 Tailwind 构建产物需要重新构建或安全复制。

## 避免过时

文档不逐项复制所有 FastAPI 路由、不列出固定测试数量、不描述易变的 UI 像素细节。接口与测试只记录稳定入口、命令和职责。

## 安全边界

继续明确禁止提交：

- `.env`、`backend/.env`、`.env.local`。
- `backend/history.db`。
- `debug/`。
- `backend/static/` 生成内容。
- `frontend/dist/` 构建产物。
- `.claude/`、`.codex-run-logs/`、`.worktrees/` 等本地工具状态。
- 任何硬编码 API Key、Authorization 或服务账号凭据。

## 验证

- 所有列出的路径在仓库中存在。
- 所有命令与 `package.json`、`run.py` 和测试目录一致。
- 文档没有固定测试数量、失效入口、明文密钥或未完成占位符。
- Markdown 结构清晰且 `git diff --check` 通过。
