# ABDL Space — 开发路线图

> 开始前请告诉我你是**程序员A**还是**程序员B**，我会引导你进入对应的任务线。

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
  commit id: "App.tsx + index.css + api.ts"
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
| **v0.2.0** | 评分系统 + 论坛 + Wiki CRUD | ratings + posts + post_comments + likes + wiki + wiki_inline_comments |
| **v0.3.0** | 排行榜 + 感受 + 用户系统 | rankings + feelings + users + experience |
| **v0.4.0** | 术语 + 推荐 + 对比 | terms + recommend + guess + compare |
| **v0.5.0** | 通知 + 管理后台 + 搜索 | notifications + admin + search |
| **v0.6.0** | 版本历史 + 富文本 + 文件上传 | page_versions UI + rich editor + R2 |

---

## v0.1.0 — Schema 重构 + 核心数据 + Auth 更新

### 程序员A 任务线（后端）

| # | 分支 | 内容 | 前置依赖 | 状态 |
|:-:|:---|:---|:---:|:---:|
| A1 | `feat/backend-core` | Hono Worker 入口 + D1 工具函数 + 类型定义 | 无 | ✅ |
| A2 | `feat/auth` | JWT 注册/登录 + 认证中间件 | A1 | ✅ |
| A3 | `feat/schema-v2` | 14 表 schema 重构 + API.md + 种子数据 | A2 | |
| A4 | `feat/auth-v2` | Auth 更新：支持 email/username 登录 + 用户资料扩展（role/avatar/age/region 等） | A3 | |
| A5 | `feat/diapers-api` | 纸尿裤列表/详情/品牌/尺码 + 种子数据导入 | A3 | |

### 程序员B 任务线（前端）

| # | 分支 | 内容 | 前置依赖 | 状态 |
|:-:|:---|:---|:---:|:---:|
| B1 | `feat/frontend-shell` | 路由配置 + 全局布局 + 主题切换 hook | A1 | ✅ |
| B2 | `feat/frontend-fix` | 修复 App.tsx（路由）+ index.css（品牌色变量+glass 类）+ 创建 api.ts | B1 | |

---

## v0.2.0 — 评分 + 论坛 + Wiki CRUD

### 程序员A 任务线

| # | 分支 | 内容 | 前置依赖 |
|:-:|:---|:---|:---:|
| A6 | `feat/ratings-api` | 6 维度评分 CRUD + 统计 | A5 |
| A7 | `feat/posts-api` | 帖子 CRUD + post_comments + likes | A4 |
| A8 | `feat/wiki-api` | Wiki CRUD + 段评（wiki_inline_comments）+ 可选 diaper_id 关联 | A5 |
| A9 | `feat/routes-refactor` | 将 src/index.ts 中的路由拆分到 src/routes/ 模块 | A6+A7+A8 |

### 程序员B 任务线

| # | 分支 | 内容 | 前置依赖 |
|:-:|:---|:---|:---:|
| B3 | `feat/frontend-auth` | 登录/注册页面 + AuthContext + useAuth hook | B2+A4 |
| B4 | `feat/diapers-ui` | 纸尿裤列表/详情/筛选页 | B2+A5 |
| B5 | `feat/ratings-ui` | 评分表单 + 雷达图 + 评分统计展示 | B4+A6 |
| B6 | `feat/forum-ui` | 帖子列表/详情/发帖 + 评论 + 点赞 | B3+A7 |
| B7 | `feat/wiki-ui` | Wiki 列表/阅读/编辑 + 段评组件 | B3+A8 |

---

## v0.3.0 — 排行榜 + 感受 + 用户系统

### 程序员A 任务线

| # | 分支 | 内容 | 前置依赖 |
|:-:|:---|:---|:---:|
| A10 | `feat/rankings-api` | 综合排行榜（hot/absorbency/popular/dimension） | A6 |
| A11 | `feat/feelings-api` | 使用感受 CRUD + 统计 | A6 |
| A12 | `feat/users-api` | 用户资料 + 经验等级 + 用户历史 | A4 |

### 程序员B 任务线

| # | 分支 | 内容 | 前置依赖 |
|:-:|:---|:---|:---:|
| B8 | `feat/rankings-ui` | 排行榜页（多类型切换） | A10 |
| B9 | `feat/feelings-ui` | 感受表单 + 可视化 | A11 |
| B10 | `feat/users-ui` | 用户资料页 + 等级展示 + 个人历史 | A12 |

---

## v0.4.0 — 术语 + 推荐 + 对比

### 程序员A 任务线

| # | 分支 | 内容 | 前置依赖 |
|:-:|:---|:---|:---:|
| A13 | `feat/terms-api` | 术语百科 CRUD | A4 |
| A14 | `feat/recommend-api` | AI 推荐 + 猜你喜欢 | A6+A12 |
| A15 | `feat/compare-api` | 纸尿裤对比 | A6 |

### 程序员B 任务线

| # | 分支 | 内容 | 前置依赖 |
|:-:|:---|:---|:---:|
| B11 | `feat/terms-ui` | 术语百科页 | A13 |
| B12 | `feat/recommend-ui` | AI 推荐组件 + 猜你喜欢 | A14 |
| B13 | `feat/compare-ui` | 纸尿裤对比页 | A15 |

---

## v0.5.0 — 通知 + 管理后台 + 搜索

### 程序员A 任务线

| # | 分支 | 内容 | 前置依赖 |
|:-:|:---|:---|:---:|
| A16 | `feat/notifications-api` | 通知 CRUD + 触发逻辑 | A7 |
| A17 | `feat/admin-api` | 管理后台全部端点 | A12 |
| A18 | `feat/search-api` | 全文搜索（D1 FTS） | A5+A8 |

### 程序员B 任务线

| # | 分支 | 内容 | 前置依赖 |
|:-:|:---|:---|:---:|
| B14 | `feat/notifications-ui` | 通知组件 + 未读徽章 | A16 |
| B15 | `feat/admin-ui` | 管理后台页面 | A17 |
| B16 | `feat/search-ui` | 搜索框 + 搜索结果页 | A18 |

---

## v0.6.0 — 版本历史 + 富文本 + 文件上传

### 程序员A 任务线

| # | 分支 | 内容 | 前置依赖 |
|:-:|:---|:---|:---:|
| A19 | `feat/versions-api` | Wiki 版本历史 + 回滚 | A8 |
| A20 | `feat/r2-upload` | R2 文件上传 + 图片处理 | A17 |

### 程序员B 任务线

| # | 分支 | 内容 | 前置依赖 |
|:-:|:---|:---|:---:|
| B17 | `feat/rich-editor` | Markdown/富文本编辑器 | A8 |
| B18 | `feat/image-upload` | 图片上传组件 | A20 |

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
| **API 规范** | 端点定义见 [API.md](./API.md)，以文档为准 |
| **路由拆分** | 后端路由在 `src/routes/`，不在 `src/index.ts` 堆砌 |
| **样式** | 颜色用 CSS 变量，不硬编码 |
| **组件** | PascalCase 文件名 + 命名导出 |
| **数据库** | `prepare().bind()` 参数化查询 |
| **评分类** | 6 维度 1–10（不是 1-5 星） |
| **评论类** | `post_comments`(论坛) vs `wiki_inline_comments`(段评)，不要混淆 |
| **毛玻璃** | 卡片/导航用 `backdrop-filter: blur(12px)` |
| **暗亮色** | 通过 `data-theme` 属性 + CSS 变量切换 |
