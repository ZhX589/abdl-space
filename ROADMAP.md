# ABDL Space Wiki — 开发路线图

> 开始前请告诉我你是**程序员A**还是**程序员B**，我会引导你进入对应的任务线。

## 当前里程碑：v0.1.0 — MVP 基础功能

```mermaid
gitGraph
  commit id: "v0.0.1 docs"
  branch feat/backend-core
  commit id: "Hono + D1 + types"
  checkout dev
  merge feat/backend-core
  branch feat/auth
  branch feat/frontend-shell
  commit id: "router + layout + theme"
  checkout feat/auth
  commit id: "JWT register/login"
  checkout dev
  merge feat/auth
  checkout dev
  merge feat/frontend-shell
  branch feat/pages-api
  branch feat/frontend-pages
  commit id: "page list/detail/edit"
  checkout feat/pages-api
  commit id: "pages CRUD"
  checkout dev
  merge feat/pages-api
  checkout dev
  merge feat/frontend-pages
```

### 程序员A 任务线（全栈 — 后端 API + 数据库）

| # | 分支 | 内容 | 前置依赖 |
|:-:|:---|:---|:---:|
| A1 | `feat/backend-core` | Hono Worker 入口 + D1 工具函数 + 类型定义 | 无 |
| A2 | `feat/auth` | JWT 注册/登录 + 认证中间件 | A1 |
| A3 | `feat/pages-api` | Wiki 页面 CRUD | A1 |
| A4 | `feat/comments-api` | 评论 CRUD | A1 |
| A5 | `feat/ratings-api` | 评分接口 | A1 |

### 程序员B 任务线（前端 — React 组件 + 页面）

| # | 分支 | 内容 | 前置依赖 |
|:-:|:---|:---|:---:|
| B1 | `feat/frontend-shell` | 路由配置 + 全局布局 + 主题切换 hook | 等待 A1 合并（类型定义）|
| B2 | `feat/frontend-auth` | 登录/注册页面 | B1 |
| B3 | `feat/frontend-pages` | Wiki 列表/详情/编辑页 | B1 |
| B4 | `feat/frontend-comments` | 评论组件 + 评论区 | B1 |
| B5 | `feat/frontend-ratings` | 星级评分组件 | B1 |

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
| **样式** | 颜色用 CSS 变量，不硬编码 |
| **组件** | PascalCase 文件名 + 命名导出 |
| **数据库** | `prepare().bind()` 参数化查询 |
| **毛玻璃** | 卡片/导航用 `backdrop-filter: blur(12px)` |
| **暗亮色** | 通过 `data-theme` 属性 + CSS 变量切换 |

## 版本规划

| 版本 | 目标 |
| :--- | :--- |
| v0.1.0 | MVP — 用户认证 + Wiki CRUD + 评论评分 |
| v0.2.0 | 版本历史 + 回滚 + 富文本编辑 |
| v0.3.0 | 搜索 + 文件上传（R2）+ 用户主页 |
