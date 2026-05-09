# ABDL Space — AI 辅助开发指南

> **🔔 第一步：** 查看 [ROADMAP.md](./ROADMAP.md) 确定你的角色（程序员A/B）和当前任务

## AI 决策优先级（当提示词与文档矛盾时）

开发者给的提示词**可能不准确或有缺漏**。遇到矛盾时按此优先级裁决：

| 优先级 | 依据 | 示例 |
| :--- | :--- | :--- |
| **1 (最高)** | 实际文件内容（类型定义、已有代码、schema） | 开发者说「用 `any`」，但 `.opencode.json` 禁止 → **听工具的** |
| **2** | `AGENTS.md`、`STYLE_GUIDE.md` 的规范和约定 | 开发者说「用红色按钮」，但配色规范主色是浅蓝 → **听文档的** |
| **3** | `API.md` 的端点定义和 `schema.sql` 的表结构 | 开发者说「评分 1-5」，但 schema 是 6 维度 1-10 → **听文档的** |
| **4** | `ROADMAP.md` 的架构规划 | 开发者说「加个 Vite 插件」，但 roadmap 没规划 → **先质疑** |
| **5 (最低)** | 开发者提示词的字面描述 | 只是参考，需要你判断是否合理 |

**核心原则：** 你的判断优于开发者的随口一说。如果开发者说的和你读到的不一致，**优先相信你读到的项目文件**。

## 项目概述

ABDL 主题的社区平台，包含纸尿裤数据库、多维度评分系统、论坛、Wiki 百科和 AI 推荐功能。

本项目（B 站点）负责 **API 后端** 和 **Wiki 前端**，与 A 站点（评分主站，纯前端）共享同一套用户系统。完整 API 规格见 [API.md](./API.md)。

### 核心功能模块

| 模块 | 说明 | API 端点数 |
| :--- | :--- | :--- |
| Auth | 注册/登录（支持 email 或 username）、用户资料 | 4 |
| Diapers | 纸尿裤数据库 + 搜索/筛选/对比 | 5 |
| Ratings | 6 维度 1–10 评分 + 文字评价 | 4 |
| Feelings | 使用感受 5 维度 -5~5 | 4 |
| Posts | 论坛帖子 + 评论 + 点赞 | 4+2+1 |
| Wiki | 通用 Wiki（可关联纸尿裤）+ 段评 | 5+3 |
| Rankings | 综合排行榜 | 1 |
| Users | 用户资料/等级/经验/历史 | 6 |
| Terms | 术语百科 | 5 |
| Recommend | AI 推荐 + 猜你喜欢 | 2 |
| Notifications | 通知系统 | 2 |
| Admin | 管理后台 | 6+ |

## 技术栈

- 前端：React 19 + TypeScript + Vite
- 后端：Hono + Cloudflare Workers
- 数据库：Cloudflare D1 (SQLite)，14 张表
- 样式：TailwindCSS v4
- 认证：自定义 JWT (WebCrypto API, HS256)
- 文件存储：Cloudflare R2（v0.6.0 规划）

## 主题风格规范

### 配色

- **主色调**：浅蓝、天蓝系 (`#B3D9FF`, `#87CEEB`, `#5BA3E6` 等)
- **辅助色**：白色、浅灰，用于背景和卡片
- **强调色**：暖色点缀（橙/粉），用于按钮、评分星标
- **暗色模式**：深蓝灰底 (`#1a1a2e`, `#16213e`)，保留毛玻璃效果

### UI 风格

- **毛玻璃（Glassmorphism）**：`background: rgba(255, 255, 255, 0.15)`, `backdrop-filter: blur(12px)`, 细边框 `border: 1px solid rgba(255,255,255,0.2)`
- **圆角**：大圆角 `border-radius: 16px` 为主，小元素用 `8px`
- **阴影**：柔和阴影，暗色模式适当加深
- **动效**：平滑过渡 `transition: all 0.3s ease`
- **审美倾向**：可爱、少年气/正太感，避免过于幼龄化。帅萌、清爽、有活力

### 响应式

- 断点：`sm: 640px`, `md: 768px`, `lg: 1024px`, `xl: 1280px`
- 移动优先，毛玻璃效果在移动端降低 blur 值以优化性能

### 暗亮色切换

- 使用 `prefers-color-scheme` 媒体查询 + 手动切换按钮
- CSS 变量驱动：`:root` 和 `[data-theme="dark"]`
- 所有颜色值通过 CSS 变量引用，不硬编码

## 代码规范

### 通用

- 使用 `const` 而不是 `let`
- 函数组件优先于类组件
- 导出的函数/组件必须写 JSDoc 注释
- 不要使用 `any` 类型，用 `unknown` 替代
- 禁止在组件中直接写 `fetch`

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

### 前端组件（src/components/）

- 组件文件名使用 PascalCase：`UserProfile.tsx`
- 每个组件一个文件，不要多个组件挤在一起
- 组件接受 props 必须定义 interface
- 使用命名导出：`export function UserProfile()`
- 组件样式使用 TailwindCSS 类名，复杂样式使用 CSS 变量

### API 调用（src/lib/api.ts）

- 所有后端 API 调用必须封装在 `src/lib/api.ts` 中
- 不要在组件中直接写 fetch
- 每个 API 函数必须有类型定义
- 函数命名约定：

| 前缀 | 用途 | 示例 |
| :--- | :--- | :--- |
| `get` | 获取列表/详情 | `getDiapers`, `getDiaper`, `getPages`, `getPage`, `getPosts`, `getRatings`, `getFeelings`, `getTerms`, `getRankings` |
| `create` | 创建资源 | `createRating`, `createFeeling`, `createPost`, `createPage`, `createTerm` |
| `update` | 更新资源 | `updatePage`, `updateUser`, `updateTerm` |
| `delete` | 删除资源 | `deleteRating`, `deletePost`, `deletePage`, `deleteTerm` |
| `post` | 操作类 | `postLike`, `postComment` |
| 特殊 | 登录/推荐 | `login`, `register`, `getMe`, `recommend`, `guessRecommend` |

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
| `PostComment` | post_comments | 帖子评论 |
| `Like` | likes | 点赞 |
| `WikiPage` | wiki_pages | Wiki 页面（可选关联 diaper_id） |
| `PageVersion` | page_versions | 页面版本历史 |
| `WikiInlineComment` | wiki_inline_comments | Wiki 段落评论 |
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
  - `feat/xxx` — 新功能（如 `feat/diapers-api`）
  - `fix/xxx` — Bug 修复
  - `docs/xxx` — 文档变更
  - `refactor/xxx` — 重构
  - `style/xxx` — 样式调整
- PR 合并策略：**Squash merge**（压缩成一个 commit，保持历史干净）
- 分支生命周期：PR 合并后**立即删除远程分支**
- 版本标签：`git tag v0.x.x`，从 `dev` 打标签
- **`dev` → `main` 的合并也必须走 PR 流程**，不允许在本地直接 `git merge dev`
- Hotfix 流程：从 `main` 切 `fix/xxx` → 修复 → GitHub PR 合并回 `main` 和 `dev`
- PR 由全栈开发者审查和合并
- 不要直接推送到 `main`

## 常见提示词纠正

开发者给的提示词可能不精确，以下是你应该自动做的纠正：

| 开发者说 | 典型问题 | 你应该做的（不要照着做） |
| :--- | :--- | :--- |
| 「写一个 fetch 请求调接口」 | 违背 API 封装规范 | **改为** 封装到 `src/lib/api.ts`，组件里只调用函数 |
| 「类型用 any」 | 违反 TS 严格模式 | **改为** 用 `unknown` 或定义具体 interface |
| 「颜色用 #ff0000」 | 不匹配主题色系 | **改为** 使用 CSS 变量 `var(--color-*)`，或推荐品牌色板中的颜色 |
| 「写一个 class 组件」 | 不符合函数组件规范 | **改为** 函数组件 + Hooks |
| 「在组件里直接调用 D1」 | 前后端职责混淆 | **改为** 通过 `src/lib/api.ts` 发 HTTP 请求到后端 API |
| 「在 index.ts 里加路由」 | 会把入口文件撑爆 | **改为** 拆到 `src/routes/` 对应模块文件 |
| 「评分 1-5 星」 | 旧规格，已废弃 | **改为** 6 维度 1–10 评分制，见 API.md |
| 「comments 关联 wiki_pages」 | 混淆两套评论系统 | **改为** 区分 `post_comments`(论坛) 和 `wiki_inline_comments`(段评) |
| 「后端接口返回 { data, msg }」 | 不符合错误格式规范 | **改为** 成功返回数据对象，错误返回 `{ error: string }` |

## 团队成员分工

### 程序员A（全栈）

- 后端架构：Hono routes（按模块拆分到 `src/routes/`）、auth/admin 中间件、D1 数据操作
- CI/CD：Workers 部署、wrangler 配置
- 数据库设计：schema 定义、种子数据、迁移脚本
- API 开发：按 [API.md](./API.md) 实现全部后端端点
- PR Review：合并前审查代码质量
- 工具链：Arch Linux + OpenCode + Neovim + git CLI

### 程序员B（前端为主）

- React 组件开发：页面级组件、通用 UI 组件（纸尿裤卡片、评分雷达图、排行榜等）
- 样式主题：毛玻璃 UI、响应式布局、暗亮色切换
- API 封装：`src/lib/api.ts` 中的函数定义
- 路由配置：前端页面路由
- Wiki 前端：Wiki 阅读页、编辑器、段评组件
- 工具链：Windows + OpenCode + GitHub Desktop

## 常用命令

| 命令 | 说明 |
| :--- | :--- |
| `npm run dev` | 启动前端开发服务器 |
| `npx wrangler dev` | 启动本地 Worker API |
| `npm run build` | 构建生产版本 |
| `npm run lint` | ESLint 检查 |
| `npx wrangler d1 execute abdl-space-db --local --file schemas/schema.sql` | 本地导入数据库表 |
| `npx wrangler d1 execute abdl-space-db --local --file schemas/seeds/diapers.sql` | 导入纸尿裤种子数据 |
| `npx wrangler types` | 生成 Worker 类型定义 |

## 项目结构

```
src/
├── components/     # 可复用 UI 组件（PascalCase.tsx）
├── pages/          # 页面级组件（路由对应）
├── routes/         # 后端路由（按模块拆分）
│   ├── auth.ts     # 认证路由
│   ├── diapers.ts  # 纸尿裤路由
│   ├── ratings.ts  # 评分路由
│   ├── feelings.ts # 感受路由
│   ├── posts.ts    # 论坛路由
│   ├── wiki.ts     # Wiki 路由
│   ├── rankings.ts # 排行榜路由
│   ├── users.ts    # 用户路由
│   ├── terms.ts    # 术语路由
│   ├── recommend.ts# 推荐路由
│   ├── notifications.ts # 通知路由
│   └── admin.ts    # 管理后台路由
├── middleware/     # Hono 中间件
│   └── auth.ts     # JWT 认证 + 管理员鉴权
├── lib/            # 工具函数和 API 封装
│   ├── api.ts      # 前端 API 调用封装
│   ├── auth.ts     # JWT + 密码哈希工具
│   ├── db.ts       # D1 数据库工具函数
│   └── utils.ts    # 通用工具函数
├── hooks/          # 自定义 React Hooks
├── types/          # TypeScript 类型定义
│   └── index.ts    # 核心类型（14 个模型接口 + API 请求/响应类型）
└── index.tsx       # 前端入口文件

src/index.ts        # 后端 Hono 入口，挂载所有 route 模块

schemas/
├── schema.sql      # D1 数据库表结构（14 张表）
└── seeds/          # 种子数据
    └── diapers.sql # 纸尿裤初始数据
```

## 环境变量

见 `.env.example`，本地开发使用 `.dev.vars`（已 gitignore）

## 注意事项

- ❌ 不要直接推送到 `main` 或 `dev`
- ❌ 不要在组件里直接写 `fetch`
- ❌ 不要用 `any` 类型
- ❌ 不要一个文件写多个组件
- ❌ 不要提交敏感信息（密钥、密码等）
- ❌ 不要在 `src/index.ts` 堆路由，必须拆到 `src/routes/`
- ❌ 不要把评分写成 1-5 星，本项目是 6 维度 1–10 制
- ❌ 不要混淆两种评论系统（post_comments vs wiki_inline_comments）

## 下一步做什么？

→ 查看 [ROADMAP.md](./ROADMAP.md)，根据你的角色（程序员A/B）选择任务线
