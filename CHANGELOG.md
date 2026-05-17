# Changelog

## v0.2.0 (2026-05-17)

### ✨ 新功能

- **Wiki 系统** — 完整的 Wiki 页面 CRUD + 段评（段落级评论）系统
- **纸尿裤评分展示** — 6 维度雷达图、综合评分、维度统计
- **纸尿裤对比** — 多款纸尿裤可视化对比表格
- **综合排行榜** — 热门/吸水量/人气/单维度 4 种类型
- **全文搜索** — 跨纸尿裤、Wiki、术语的统一搜索
- **术语百科** — 完整的 CRUD 管理
- **猜你喜欢** — 纯数据驱动的推荐
- **Wiki 版本历史** — 查看历史版本并支持回滚
- **Markdown 富文本编辑器** — 带工具栏和实时预览
- **DeepSeek AI 推荐** — 基于用户资料的智能推荐（需配置 API Key）
- **API Key 管理** — `/api_set` 管理页面配置第三方 AI 服务密钥
- **频率限制** — auth 端点 5 次/分钟/IP 限制
- **安全加固** — JWT httpOnly Cookie + 严格 CORS + 密码复杂度校验

### 🐛 Bug 修复

- 修复 `sort=rating_count` 500 错误（JOIN 别名排序）
- 修复 `avg_score` 计算公式不一致问题（统一使用 `computeAvgScore` 函数）
- 修复 `GET /api/terms/:id` 缺失实现
- 修复 SQL 语法错误 `COALESCE(ROUND(..., 0), 0)` → `COALESCE(ROUND(..., 1), 0)`
- 修复 `rankings` 端点 `avg_score` → `rating_avg` 列引用
- 修复 terms 验证逻辑对空字符串的处理
- 17 个 TS build errors 修复

### 📚 文档更新

- 更新 API.md 新增 5.16(api_keys)、5.17(Wiki Pages)、5.18(Inline Comments)、5.19(Page Versions)
- 更新 DEPLOYMENT.md 完整部署日志
- 更新 ROADMAP.md 标记所有功能完成

### 🔧 基础设施

- 新增 `api_keys` 表存储第三方 API 密钥
- 新增 `FRONTEND_ORIGIN` 环境变量支持
- 路由拆分到 `src/routes/` 14 个模块
- `computeAvgScore` 函数提取到 `src/lib/db.ts` 共享

## v0.1.0-beta.1 (2026-05-08)

### 🏗️ 前端技术栈初始化

- 安装 `tailwindcss` + `@tailwindcss/vite` — TailwindCSS v4，Vite 零配置集成
- 安装 `react-router-dom` — 前端路由框架
- `vite.config.ts` — 添加 `@tailwindcss/vite` 插件
- `src/index.css` — 顶部引入 `@import "tailwindcss"`
- 创建前端目录结构：`components/`、`pages/`、`lib/`、`hooks/`、`types/`

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
