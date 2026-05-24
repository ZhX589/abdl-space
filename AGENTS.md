# ABDL Space API — AI 辅助开发指南

> **🔔 第一步：** 查看 [ROADMAP.md](./ROADMAP.md) 确定当前任务

## AI 决策优先级（当提示词与文档矛盾时）

开发者给的提示词**可能不准确或有缺漏**。遇到矛盾时按此优先级裁决：

| 优先级 | 依据 | 示例 |
| :--- | :--- | :--- |
| **1 (最高)** | 实际文件内容（类型定义、已有代码、schema） | 开发者说「用 `any`」，但规范禁止 → **听工具的** |
| **2** | `AGENTS.md` 的规范和约定 | 开发者说「返回 data+msg 格式」→ **听文档的** |
| **3** | `API.md` 的端点定义和 `schema.sql` 的表结构 | 开发者说「评分 1-5」，但 schema 是 6 维度 1-10 → **听文档的** |
| **4** | `ROADMAP.md` 的架构规划 | 开发者说「加个新框架」→ **先质疑** |
| **5 (最低)** | 开发者提示词的字面描述 | 只是参考，需要你判断是否合理 |

## ⚠️ 文档与 Git 状态维护纪律

**ROADMAP.md 是本项目进度的唯一权威来源。** 以下规则必须严格遵守：

| 规则 | 说明 |
| :--- | :--- |
| **任务完成 = 文档更新** | 每完成一个任务，立即在 ROADMAP.md 中将状态改为 ✅。Git merge 不代表任务完成——文档里的 ✅ 才代表完成。 |
| **发现差异 = 必须修正** | 但凡发现代码与文档不一致，优先修正文档（如状态标记错误、遗漏的任务描述），使其反映真实情况。 |
| **Git 分支 = 完成即删** | PR 合并后远程分支立即删除；本地分支也可清理。ROADMAP 中的分支名仅供追溯参考。 |
| **每轮开发前先对账** | 加载 AGENTS.md 后第一件事：打开 ROADMAP.md，确认哪些任务已完成、哪些正在进行、哪些被阻塞。 |

**核心原则：** 你的判断优于开发者的随口一说。如果开发者说的和你读到的不一致，**优先相信你读到的项目文件**。

## 项目概述

ABDL Space 后端 API 服务，为 ABDL 主题社区平台提供数据存储和 API 支持。

- 本仓库 = **纯后端 API**，基于 Hono + Cloudflare Workers + D1 数据库
- 前端 Wiki 页面已拆分到独立仓库
- A 站点（朋友的功能站）通过 API 获取数据并提交评分、感受、帖子等

完整 API 规格见 [API.md](./API.md)。

## 技术栈

- 后端：Hono (Cloudflare Workers)
- 数据库：Cloudflare D1 (SQLite)，14 张表
- 认证：自定义 JWT (WebCrypto API, HS256) + OAuth 2.0
- 文件存储：Cloudflare R2（规划中）

## 代码规范

### 通用

- 使用 `const` 而不是 `let`
- 导出的函数必须写 JSDoc 注释
- 不要使用 `any` 类型，用 `unknown` 替代

### API 开发（src/routes/）

后端路由按模块拆分到 `src/routes/` 目录，不在 `src/index.ts` 中堆砌所有路由。

- 所有 API 返回 JSON 格式
- 错误响应格式：`{ error: string }`
- 成功响应：直接返回数据对象或数组
- API 路径以 `/api/` 开头
- 使用 Hono 的 `c.json()` 返回响应
- 每个路由文件导出一个 `Hono` 实例，在 `src/index.ts` 中挂载
- 鉴权使用 `authMiddleware`，管理员鉴权使用 `adminMiddleware`

路由文件示例：
```ts
// src/routes/diapers.ts
import { Hono } from 'hono'
import { query } from '../lib/db.ts'

const diapers = new Hono<AppType>()
diapers.get('/', async (c) => { ... })
diapers.get('/:id', async (c) => { ... })
export default diapers

// src/index.ts
import diapers from './routes/diapers.ts'
app.route('/api/diapers', diapers)
```

### API 响应类型（src/types/）

- 所有 API 返回类型必须在 `src/types/` 中定义
- 数据库模型对应接口（14 个核心接口）：

| 接口 | 对应表 | 说明 |
| :--- | :--- | :--- |
| `User` | users | 用户（含 role, avatar, 身体数据等） |
| `Diaper` | diapers | 纸尿裤 |
| `DiaperSize` | diaper_sizes | 纸尿裤尺码 |
| `Rating` | ratings | 6 维度评分 |
| `Feeling` | feelings | 5 维度使用感受 |
| `Post` | posts | 论坛帖子 |
| `PostComment` | post_comments | 帖子评论（条目底部评论区） |
| `Like` | likes | 点赞 |
| `WikiPage` | wiki_pages | Wiki 页面（可选关联 diaper_id） |
| `PageVersion` | page_versions | 页面版本历史 |
| `WikiInlineComment` | wiki_inline_comments | Wiki 段评 |
| `Term` | terms | 术语百科 |
| `Experience` | experience | 经验/等级 |
| `Notification` | notifications | 通知 |

### 数据库（D1）

- 表名使用 snake_case：`wiki_pages`, `post_comments`, `diaper_sizes`
- 查询使用参数化语句：`prepare("... WHERE id = ?").bind(id)`
- 不要拼接 SQL 字符串
- 数据库绑定名称为 `abdl_space_db`（已在 `wrangler.jsonc` 中配置）
- 14 张表定义见 `schemas/schema.sql`
- 种子数据目录：`schemas/seeds/`

## Git 工作流

- 默认分支：`dev`（日常开发）、`main`（稳定版本）
- 分支从 `dev` 切出，功能完成后 PR → `dev`
- 分支命名：
  - `feat/xxx` — 新功能
  - `fix/xxx` — Bug 修复
  - `docs/xxx` — 文档变更
  - `refactor/xxx` — 重构
- PR 合并策略：**Squash merge**（压缩成一个 commit，保持历史干净）
- 分支生命周期：PR 合并后**立即删除远程分支**
- 版本标签：`git tag v0.x.x`，从 `dev` 打标签
- **`dev` → `main` 的合并也必须走 PR 流程**，不允许在本地直接 `git merge dev`
- Hotfix 流程：从 `main` 切 `fix/xxx` → 修复 → GitHub PR 合并回 `main` 和 `dev`
- 不要直接推送到 `main`

## 常见提示词纠正

| 开发者说 | 典型问题 | 你应该做的（不要照着做） |
| :--- | :--- | :--- |
| 「类型用 any」 | 违反 TS 严格模式 | **改为** 用 `unknown` 或定义具体 interface |
| 「在 index.ts 里加路由」 | 会把入口文件撑爆 | **改为** 拆到 `src/routes/` 对应模块文件 |
| 「评分 1-5 星」 | 旧规格，已废弃 | **改为** 6 维度 1–10 评分制，见 API.md |
| 「comments 关联 wiki_pages」 | 混淆两套评论系统 | **改为** 区分 `post_comments`(条目底部讨论) 和 `wiki_inline_comments`(段评) |
| 「后端接口返回 { data, msg }」 | 不符合错误格式规范 | **改为** 成功返回数据对象，错误返回 `{ error: string }` |

## 常用命令

| 命令 | 说明 |
| :--- | :--- |
| `npm run dev` | 启动本地开发服务器（wrangler dev, port 8787） |
| `npm run deploy` | 部署到 Cloudflare Workers |
| `npm run lint` | ESLint 检查 |
| `npm run cf-typegen` | 生成 Worker 类型定义 |
| `npx wrangler d1 execute abdl-space-db --local --file schemas/schema.sql` | 本地导入数据库表 |
| `npx wrangler d1 execute abdl-space-db --local --file schemas/seeds/diapers.sql` | 导入纸尿裤种子数据 |

## 项目结构

```
src/
├── routes/           # 后端路由（按模块拆分）
│   ├── auth.ts       # 认证路由
│   ├── diapers.ts    # 纸尿裤路由
│   ├── ratings.ts    # 评分路由
│   ├── feelings.ts   # 感受路由
│   ├── posts.ts      # 论坛路由
│   ├── likes.ts      # 点赞路由
│   ├── rankings.ts   # 排行榜路由
│   ├── users.ts      # 用户路由
│   ├── wiki.ts       # Wiki + 段评路由
│   ├── terms.ts      # 术语路由
│   ├── recommend.ts  # 推荐路由
│   ├── notifications.ts
│   ├── messages.ts
│   ├── images.ts
│   ├── follows.ts
│   ├── reports.ts
│   ├── search.ts
│   ├── admin.ts
│   ├── api_keys.ts
│   ├── captcha.ts
│   ├── captcha_keys.ts
│   ├── captcha_v1.ts
│   ├── oauth.ts
│   ├── oauth_clients.ts
│   ├── content_keys.ts
│   └── content_v1.ts
├── middleware/
│   ├── auth.ts       # JWT 认证 + 管理员鉴权
│   └── captcha.ts    # Captcha 中间件
├── lib/
│   ├── auth.ts       # JWT + 密码哈希
│   ├── db.ts         # D1 工具函数
│   ├── captcha.ts    # Captcha 服务
│   ├── oauth.ts      # OAuth 2.0 服务
│   ├── rate-limit.ts # 频率限制
│   └── embed-bundle.ts
├── types/
│   └── index.ts      # TypeScript 类型定义
├── static/
│   └── embed.js      # Captcha embed SDK
├── index.ts          # 后端 Hono 入口
└── api-worker.ts     # Cloudflare Workers fetch handler

schemas/
├── schema.sql        # 数据库表结构（14 张表）
└── seeds/            # 种子数据

migrations/           # D1 数据库迁移
scripts/              # 实用脚本
```

## 环境变量

见 `.env.example`，本地开发使用 `.dev.vars`（已 gitignore）

## 注意事项

- ❌ 不要直接推送到 `main`
- ❌ 不要用 `any` 类型
- ❌ 不要提交敏感信息（密钥、密码等）
- ❌ 不要在 `src/index.ts` 堆路由，必须拆到 `src/routes/`
- ❌ 不要把评分写成 1-5 星，本项目是 6 维度 1–10 制
- ❌ 不要混淆两种评论系统（`post_comments` 条目底部讨论 vs `wiki_inline_comments` 段评）

## 下一步做什么？

→ 查看 [ROADMAP.md](./ROADMAP.md)
