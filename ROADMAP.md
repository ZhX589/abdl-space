# ABDL Space — 开发路线图

> 开始前请告诉我你是**程序员A**还是**程序员B**，我会引导你进入对应的任务线。

> **⚠️ 文档维护纪律：** 本文件是项目进度的**唯一权威来源**。每完成一个任务、每合并一个 PR、每发现一处代码与文档不一致，**必须同步更新本文件和 AGENTS.md 的对应状态**。Git 提交不代表任务完成——文档里的 ✅ 才代表任务完成。严禁"代码合了但文档没改"。

## 项目定位（重要）

**B 站点（我们）** = 信息站，主要功能是**展示**整理好的信息，供查询和参考。

- Wiki 页面（完整编辑 + 查看）
- 纸尿裤数据库（列表 + 详情 + 筛选）
- 信息展示：评分雷达图、综合评分、排行榜、对比、术语等
- 条目底部评论区（供用户讨论该条目）
- 段评（段落级评论）
- 搜索

**A 站点（朋友）** = 功能站，用户主要在这里**提交**数据（评分、感受、帖子等）。两站共享同一套账号系统，后端 API 由我们实现。

## 当前里程碑：v0.1.0 — Schema 重构 + 核心数据

```mermaid
gitGraph
  commit id: "v0.0.1 docs"
  branch feat/backend-core
  commit id: "Hono + D1 + types ✓"
  checkout dev
  merge feat/backend-core
  branch feat/auth
  branch feat/frontend-shell
  commit id: "router + layout + theme"
  checkout feat/auth
  commit id: "JWT register/login ✓"
  checkout dev
  merge feat/auth
  checkout dev
  merge feat/frontend-shell
  branch feat/schema-v2
  commit id: "14-table schema + API.md"
  checkout dev
  merge feat/schema-v2
  branch feat/diapers-api
  branch feat/frontend-fix
  commit id: "api.ts (仅); App.tsx+index.css 待修"
  checkout feat/diapers-api
  commit id: "diapers CRUD + seeds"
  checkout dev
  merge feat/diapers-api
  checkout dev
  merge feat/frontend-fix
```

## 版本规划

| 版本 | 目标 | 核心端点 |
| :--- | :--- | :--- |
| **v0.1.0** | Schema 重构 + Auth 更新 + 纸尿裤数据 + 前端基础修复 | auth (改) + diapers + seeds |
| **v0.2.0** | Wiki CRUD + 评分展示 + 条目底部评论区 | wiki + wiki_inline_comments + ratings(展示) + post_comments(条目页) |
| **v0.3.0** | 排行榜 + 对比 + 搜索 + 术语 | rankings + compare + search + terms |
| **v0.4.0** | 猜你喜欢 + 版本历史 + 富文本 | guess + page_versions + rich editor |

---

## v0.1.0 — Schema 重构 + 核心数据 + Auth 更新

### 程序员A 任务线（后端）

| # | 分支 | 内容 | 前置依赖 | 状态 |
|:-:|:---|:---|:---:|:---:|
| A1 | `feat/backend-core` | Hono Worker 入口 + D1 工具函数 + 类型定义 | 无 | ✅ |
| A2 | `feat/auth` | JWT 注册/登录 + 认证中间件 | A1 | ✅ |
| A3 | `feat/schema-v2` | 14 表 schema 重构 + API.md + 种子数据 | A2 | ✅ |
| A4 | `feat/auth-v2` | Auth 更新：支持 email/username 登录 + 用户资料扩展 | A3 | |
| A5 | `feat/diapers-api` | 纸尿裤列表/详情/品牌/尺码/对比 + 种子数据导入 | A3 | ✅ |

### 程序员B 任务线（前端）

| # | 分支 | 内容 | 前置依赖 | 状态 |
|:-:|:---|:---|:---:|:---:|
| B1 | `feat/frontend-shell` | 路由配置 + 全局布局 + 主题切换 hook | 无 | ✅ |
| B2 | `feat/frontend-fix` | 修复路由入口（router.tsx + main.tsx）+ index.css（品牌色变量+glass 类+dark mode）+ 创建 api.ts + utils.ts | B1 | ✅ |

---

## v0.2.0 — Wiki CRUD + 评分展示 + 评论区

### 程序员A 任务线

| # | 分支 | 内容 | 前置依赖 |
|:-:|:---|:---|:---:|
| A6 | `feat/wiki-api` | Wiki CRUD + 可选 diaper_id 关联 + 段评 API | A5 |
| A7 | `feat/routes-refactor` | 将 src/index.ts 路由拆分到 src/routes/ 模块 | A6 |

### 程序员B 任务线

B 站前端**只做展示和 Wiki 编辑**，评分/感受/帖子的提交由 A 站负责，我们只调用 get 类接口。

| # | 分支 | 内容 | 前置依赖 |
|:-:|:---|:---|:---:|
| B3 | `feat/diapers-ui` | 纸尿裤列表/详情/筛选（包含评分展示 + 雷达图） | B2+A5 |
| B4 | `feat/wiki-ui` | Wiki 列表/阅读/编辑 + 段评组件 | B2+A6 |
| B5 | `feat/diaper-comments` | 条目页面底部评论区（post_comments 展示 + 发评论） | B3+A6 |

---

## v0.3.0 — 排行榜 + 对比 + 搜索 + 术语

### 程序员A 任务线

| # | 分支 | 内容 | 前置依赖 |
|:-:|:---|:---|:---:|
| A8 | `feat/rankings-api` | 综合排行榜（hot/absorbency/popular/dimension） | A5 |
| A9 | `feat/compare-api` | 纸尿裤对比 | A5 |
| A10 | `feat/search-api` | 全文搜索（D1 FTS） | A5+A6 |
| A11 | `feat/terms-api` | 术语百科 CRUD | A4 |

### 程序员B 任务线

| # | 分支 | 内容 | 前置依赖 |
|:-:|:---|:---|:---:|
| B6 | `feat/rankings-ui` | 排行榜页（多类型切换） | A8 |
| B7 | `feat/compare-ui` | 纸尿裤对比页（可视化） | A9 |
| B8 | `feat/search-ui` | 搜索框 + 搜索结果页 | A10 |
| B9 | `feat/terms-ui` | 术语百科页 | A11 |

---

## v0.4.0 — 猜你喜欢 + 版本历史 + 富文本

### 程序员A 任务线

| # | 分支 | 内容 | 前置依赖 |
|:-:|:---|:---|:---:|
| A12 | `feat/guess-api` | 猜你喜欢（纯数据驱动，无 AI） | A5 |
| A13 | `feat/versions-api` | Wiki 版本历史 + 回滚 | A6 |
| A14 | `feat/rich-editor` | 富文本/Markdown 编辑器 | A6 |

### 程序员B 任务线

| # | 分支 | 内容 | 前置依赖 |
|:-:|:---|:---|:---:|
| B10 | `feat/guess-ui` | 猜你喜欢展示（首页模块） | A12 |
| B11 | `feat/versions-ui` | 版本历史对比 UI + 回滚按钮 | A13 |
| B12 | `feat/rich-editor-ui` | 富文本编辑器组件 | A14 |

---

## 如何开始

```bash
# 1. 拉到最新 dev
git checkout dev && git pull origin dev

# 2. 切新分支（按上表选择你的分支名）
git checkout -b feat/你的分支名

# 3. 开发完成后提交
git add .
git commit -m "feat(模块): 简短描述"
git push origin feat/你的分支名

# 4. 去 GitHub 创建 PR → 合并到 dev
#    ⚠️ 所有合并（包括 dev → main）都必须在 GitHub 上走 PR 流程
#    不要在本地执行 git merge
```

## 代码规范速查

| 规则 | 说明 |
| :--- | :--- |
| **类型安全** | 不用 `any`，用 `unknown` |
| **API 调用** | 在 `src/lib/api.ts` 封装，组件里不写 `fetch` |
| **B 站 API 原则** | 只调用 get 类接口（展示数据）；提交类接口（createRating/createPost 等）由 A 站调用，不写在我们的前端代码里 |
| **API 规范** | 端点定义见 [API.md](./API.md)，以文档为准 |
| **路由拆分** | 后端路由在 `src/routes/`，不在 `src/index.ts` 堆砌 |
| **样式** | 颜色用 CSS 变量，不硬编码 |
| **组件** | PascalCase 文件名 + 命名导出 |
| **数据库** | `prepare().bind()` 参数化查询 |
| **评分类** | 6 维度 1–10（不是 1-5 星），我们只展示不提交 |
| **评论类** | `post_comments`(条目底部讨论) vs `wiki_inline_comments`(段评)，不要混淆 |
| **毛玻璃** | 卡片/导航用 `backdrop-filter: blur(12px)` |
| **暗亮色** | 通过 `data-theme` 属性 + CSS 变量切换 |