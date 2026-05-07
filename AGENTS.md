# ABDL Space Wiki — AI 辅助开发指南

> **🔔 第一步：** 查看 [ROADMAP.md](./ROADMAP.md) 确定你的角色（程序员A/B）和当前任务

## AI 决策优先级（当提示词与文档矛盾时）

开发者给的提示词**可能不准确或有缺漏**。遇到矛盾时按此优先级裁决：

| 优先级 | 依据 | 示例 |
| :--- | :--- | :--- |
| **1 (最高)** | 实际文件内容（类型定义、已有代码、schema） | 开发者说「用 `any`」，但 `.opencode.json` 禁止 → **听工具的** |
| **2** | `AGENTS.md`、`STYLE_GUIDE.md` 的规范和约定 | 开发者说「用红色按钮」，但配色规范主色是浅蓝 → **听文档的** |
| **3** | `ROADMAP.md` 的架构规划 | 开发者说「加个 Vite 插件」，但 roadmap 没规划 → **先质疑** |
| **4 (最低)** | 开发者提示词的字面描述 | 只是参考，需要你判断是否合理 |

**核心原则：** 你的判断优于开发者的随口一说。如果开发者说的和你读到的不一致，**优先相信你读到的项目文件**。

## 项目概述

ABDL 主题的 Wiki 社区平台，支持多用户协作编辑产品页面、评分和评论。

## 技术栈

- 前端：React 18 + TypeScript + Vite
- 后端：Hono + Cloudflare Workers
- 数据库：Cloudflare D1 (SQLite)
- 样式：TailwindCSS
- 认证：自定义 JWT (WebCrypto API)
- 文件存储：Cloudflare R2

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

### API 开发（src/index.ts 或 src/routes/）

- 所有 API 返回 JSON 格式
- 错误响应格式：`{ error: string }`
- 成功响应：直接返回数据对象或数组
- API 路径以 `/api/` 开头
- 使用 Hono 的 `c.json()` 返回响应

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
- 函数命名：`getPages`, `getPage`, `createPage`, `updatePage`, `deletePage`, `getComments`, `postComment`, `getRatings`, `ratePage`

### API 响应类型（src/types/）

- 所有 API 返回类型必须在 `src/types/index.ts` 中定义
- 数据库模型对应接口：`User`, `WikiPage`, `Comment`, `Rating`, `PageVersion`

### 数据库（D1）

- 表名使用 snake_case：`wiki_pages`
- 查询使用参数化语句：`prepare("... WHERE id = ?").bind(id)`
- 不要拼接 SQL 字符串
- 数据库绑定名称为 `abdl_space_db`（已在 `wrangler.jsonc` 中配置）

## Git 工作流

- 默认分支：`dev`（日常开发）、`main`（稳定版本）
- 分支从 `dev` 切出，功能完成后 PR → `dev`
- 分支命名：
  - `feat/xxx` — 新功能（如 `feat/comments-list`）
  - `fix/xxx` — Bug 修复
  - `docs/xxx` — 文档变更
  - `refactor/xxx` — 重构
  - `style/xxx` — 样式调整
- PR 合并策略：**Squash merge**（压缩成一个 commit，保持历史干净）
- 分支生命周期：PR 合并后**立即删除远程分支**
- 版本标签：`git tag v0.x.x`，从 `dev` 打标签
- Hotfix 流程：从 `main` 切 `fix/xxx` → 修复 → 合并回 `main` 和 `dev`
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
| 「加一个 Vite 插件」 | 可能需要评估必要性 | 先检查 `package.json` 是否已有，再确认是否真的需要 |
| 「后端接口返回 { data, msg }」 | 不符合错误格式规范 | **改为** 成功返回数据对象，错误返回 `{ error: string }` |

## 团队成员分工

> 以下作为开发参考，两位开发者各司其职

### 程序员A（全栈）

- 后端架构：Hono routes、auth 中间件、D1 数据操作
- CI/CD：Workers 部署、wrangler 配置
- 数据库设计：schema 定义、迁移脚本
- PR Review：合并前审查代码质量
- 工具链：Arch Linux + OpenCode + Neovim + git CLI

### 程序员B（前端为主）

- React 组件开发：页面级组件、通用 UI 组件
- 样式主题：毛玻璃 UI、响应式布局、暗亮色切换
- API 封装：`src/lib/api.ts` 中的函数定义
- 路由配置：前端页面路由
- 工具链：Windows + OpenCode + GitHub Desktop

## 常用命令

| 命令 | 说明 |
| :--- | :--- |
| `npm run dev` | 启动前端开发服务器 |
| `npx wrangler dev` | 启动本地 Worker API |
| `npm run build` | 构建生产版本 |
| `npm run lint` | ESLint 检查 |
| `npx wrangler d1 execute abdl-space-db --local --file schemas/schema.sql` | 本地导入数据库表 |
| `npx wrangler types` | 生成 Worker 类型定义 |

## 项目结构

```
src/
├── components/     # 可复用 UI 组件（PascalCase.tsx）
├── pages/          # 页面级组件（路由对应）
├── lib/            # 工具函数和 API 封装
│   ├── api.ts      # 后端 API 调用封装
│   └── utils.ts    # 通用工具函数
├── hooks/          # 自定义 React Hooks
├── types/          # TypeScript 类型定义
│   └── index.ts    # 核心类型
└── index.tsx       # 入口文件

schemas/
└── schema.sql      # D1 数据库表结构
```

## 环境变量

见 `.env.example`，本地开发使用 `.dev.vars`（已 gitignore）

## 注意事项

- ❌ 不要直接推送到 `main` 或 `dev`
- ❌ 不要在组件里直接写 `fetch`
- ❌ 不要用 `any` 类型
- ❌ 不要一个文件写多个组件
- ❌ 不要提交敏感信息（密钥、密码等）

## 下一步做什么？

→ 查看 [ROADMAP.md](./ROADMAP.md)，根据你的角色（程序员A/B）选择任务线
