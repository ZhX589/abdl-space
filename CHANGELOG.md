# Changelog

## v0.0.3 (2026-05-08)

### 🚀 后端基础设施

- 新增 `src/types/index.ts` — 完整 DB 模型类型（User, WikiPage, Comment, Rating, PageVersion）+ API 请求/响应类型
- 新增 `src/lib/db.ts` — `query` / `run` / `queryOne` 三个参数化 D1 工具函数
- 新增 `src/index.ts` — Hono Worker 入口，CORS + logger 中间件，`/api/health` 和 `/api/health/db` 端点
- 新增 `functions/api/[[route]].ts` — Cloudflare Pages Functions 适配到 Hono
- 修改 `tsconfig.app.json` — 加入 `@cloudflare/workers-types` 类型支持

## v0.0.2 (2026-05-08)

### 🛡️ AI 抗干扰加固

- `.opencode.json` — 规则升级为 CRITICAL，每条附带提示词纠正逻辑
- `AGENTS.md` — 新增「AI 决策优先级」「常见提示词纠正」两节
- `STYLE_GUIDE.md` — 改为 ✅/❌ 对比格式 + CSS 变量速查表
- `src/index.css` — 替换为品牌色变量体系，新增 `.glass` 毛玻璃工具类
- 明确 `dev` → `main` 也必须走 PR 流程

## v0.0.1 (2026-05-08)

### ✨ 文档体系建设

- 重写 `README.md` — 项目介绍、功能特性、技术栈、快速开始
- 扩展 `AGENTS.md` — 主题风格规范、代码规范、分工说明、常用命令
- 更新 `CONTRIBUTING.md` — 分支命名规则、样式贡献指南、数据库变更流程
- 新建 `STYLE_GUIDE.md` — 品牌色值、毛玻璃规范、暗亮色切换机制、响应式断点
- 新建 `CHANGELOG.md` — 版本变更记录

### 🛠️ 配置与工具

- 更新 `.opencode.json` — 增加 docs agent、补充 7 条开发规则
- 更新 `.github/pull_request_template.md` — 增加 Issue 关联、Checklist 细化
- 新建 `.env.example` — 环境变量模板
- 新建 `.vscode/extensions.json` — 推荐扩展

### 🗄️ 数据库

- 新建 `schemas/schema.sql` — 定义 5 张核心表（users, wiki_pages, page_versions, comments, ratings）及索引
