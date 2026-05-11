# ABDL Space — 部署指南

> 本文档说明何时需要部署、部署什么、以及部署顺序。

## 1. 部署架构概述

| 组件 | 平台 | 触发方式 |
|:---|:---|:---|
| 前端 + Workers API | Cloudflare Pages | 推送到 `dev` 分支 → 自动构建部署 |
| D1 数据库 | Cloudflare D1 | 手动 `wrangler d1 execute --remote` |
| 环境变量 / 密钥 | Cloudflare Pages Secrets | 手动 `wrangler pages secret put` 或 Dashboard |

- **Pages 项目名**: `abdl-space`
- **Production 分支**: `dev`（推送即触发部署）
- **构建命令**: `npm run build`
- **输出目录**: `dist`
- **Functions 目录**: `functions/`（`functions/api/[[route]].ts` 作为 Workers 入口）
- **D1 数据库**: `abdl-space-db`（binding 名 `abdl_space_db`）

## 2. 部署类型与触发条件

### 2.1 代码部署（自动）

**触发**: 推送到 `dev` 分支（直接 push 或合并 PR）

Cloudflare Pages 自动执行：
1. `npm install`
2. `npm run build`（tsc + vite build → `dist/`）
3. 部署前端静态资源 + Functions

**无需手动操作**，只需确保代码已合并到 `dev`。

### 2.2 数据库 Schema 部署（手动）

**触发**: `schemas/schema.sql` 有变更（新增表、新字段、新索引、FTS 虚拟表等）

```bash
npx wrangler d1 execute abdl-space-db --remote --file schemas/schema.sql
```

> `--remote` 操作生产数据库，不加则操作本地。

**必须在依赖新 schema 的代码部署之前执行**，否则新代码会因查不到表/字段而报错。

### 2.3 种子数据部署（手动）

**触发**: `schemas/seeds/` 目录下新增或更新了 SQL 文件

```bash
npx wrangler d1 execute abdl-space-db --remote --file schemas/seeds/<name>.sql
```

种子数据可在代码部署前后任意时间执行，不影响已有功能。

### 2.4 环境变量 / 密钥部署（手动）

**触发**: 新增或修改了密钥（如 `JWT_SECRET`、`AI_API_KEY` 等）

```bash
echo "your-secret-value" | npx wrangler pages secret put <KEY_NAME> --project-name abdl-space
```

或在 Cloudflare Dashboard: **Workers & Pages → abdl-space → Settings → Variables and Secrets**。

**必须在依赖该密钥的代码部署之前设置**。设置后需要**重新部署**才会被 Functions 读取（在 Dashboard 中点击 Retry deploy，或推送任意 commit 到 `dev`）。

## 3. 首次部署完整流程

如果从头开始部署项目，按以下顺序操作：

### Step 1: 推送代码到 GitHub

```bash
git checkout dev
git push origin dev
```

### Step 2: 在 Cloudflare Dashboard 创建 Pages 项目

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. **Workers & Pages → Create application → Pages → Connect to Git**
3. 选择 `abdl-space` 仓库
4. 配置：
   - **Production branch**: `dev`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
5. 点击 Deploy

### Step 3: 导入数据库

```bash
# 导入表结构（14 张表 + 索引）
npx wrangler d1 execute abdl-space-db --remote --file schemas/schema.sql

# 导入种子数据（11 条纸尿裤 + 尺码）
npx wrangler d1 execute abdl-space-db --remote --file schemas/seeds/diapers.sql

# 如果已导入过，需要先清空再导：
# npx wrangler d1 execute abdl-space-db --remote --command "DELETE FROM diaper_sizes; DELETE FROM diapers;"
```

### Step 4: 设置 JWT 密钥

```bash
openssl rand -base64 32 | npx wrangler pages secret put JWT_SECRET --project-name abdl-space
```

### Step 5: 重新部署使密钥生效

在 Cloudflare Dashboard 中点击 **Retry deploy**，或推送一个空 commit：

```bash
git commit --allow-empty -m "chore: 触发重新部署使密钥生效"
git push origin dev
```

### Step 6: 验证

```bash
# 替换为实际域名
curl https://<your-project>.pages.dev/api/health
# 期望: {"status":"ok","timestamp":"..."}

curl https://<your-project>.pages.dev/api/health/db
# 期望: {"status":"ok","db":{"ok":1}}

curl https://<your-project>.pages.dev/api/diapers
# 期望: 返回 11 条纸尿裤数据
```

## 4. 各版本部署检查清单

> ✅ = 已完成 / ❌ = 不需要 / ⚠️ = 需要注意

### v0.1.0 — Schema 重构 + 核心数据（✅ 已部署）

| 任务 | 类型 | 状态 |
|:---|:---|:---:|
| 14 表 Schema | D1 手动 | ✅ |
| 11 条纸尿裤种子 | D1 手动 | ✅ |
| JWT_SECRET | Secret | ✅ |
| A1 `feat/backend-core` — Hono + D1 + 类型 | 代码 | ✅ |
| A2 `feat/auth` — JWT 注册/登录 + 中间件 | 代码 | ✅ |
| A3 `feat/schema-v2` — Schema + API.md | 文档 | ✅ |
| A5 `feat/diapers-api` — 5 个 API 端点 | 代码 | ✅ |
| B1 `feat/frontend-shell` — 路由 + 布局 + 主题 | 代码 | ✅ |
| B2 `feat/frontend-fix` — router.tsx + index.css + api.ts + utils.ts | 代码 | ✅ |
| A4 `feat/auth-v2` — PATCH /api/users/me + 用户资料扩展 | 代码 | ⬜ |

### v0.2.0 — Wiki + 评分展示 + 评论区

| 任务 | 类型 | 操作 |
|:---|:---|:---|
| A6 `feat/wiki-api` | 代码 | PR 合并到 dev → 自动部署 |
| A7 `feat/routes-refactor` | 代码 | PR 合并到 dev → 自动部署 |
| B3 `feat/diapers-ui` | 代码 | PR 合并到 dev → 自动部署 |
| B4 `feat/wiki-ui` | 代码 | PR 合并到 dev → 自动部署 |
| B5 `feat/diaper-comments` | 代码 | PR 合并到 dev → 自动部署 |

> 所有表已在 v0.1.0 建立，**无需 schema 变更**。纯代码部署。

### v0.3.0 — 排行榜 + 对比 + 搜索 + 术语

| 任务 | 类型 | 操作 |
|:---|:---|:---|
| A8 `feat/rankings-api` | 代码 | PR 合并到 dev → 自动部署 |
| A9 `feat/compare-api` | 代码 | PR 合并到 dev → 自动部署 |
| A10 `feat/search-api` | 代码 + 可能 Schema | 见下方说明 |
| A11 `feat/terms-api` | 代码 | PR 合并到 dev → 自动部署 |
| B6-B9 前端页面 | 代码 | PR 合并到 dev → 自动部署 |

> **搜索 (A10) 注意**: 如果使用 D1 FTS（全文搜索），需要先创建 FTS 虚拟表，再部署代码。

### v0.4.0 — 猜你喜欢 + 版本历史 + 富文本

| 任务 | 类型 | 操作 |
|:---|:---|:---|
| A12 `feat/guess-api` | 代码 | PR 合并到 dev → 自动部署 |
| A13 `feat/versions-api` | 代码 | PR 合并到 dev → 自动部署 |
| A14 `feat/rich-editor` | 代码 | PR 合并到 dev → 自动部署 |
| B10-B12 前端页面 | 代码 | PR 合并到 dev → 自动部署 |
| AI_API_KEY | Secret | 需要手动设置 |
| R2 Bucket | wrangler.jsonc + Dashboard | 需要手动配置 |

> **AI 推荐**: 部署代码前先设置 `AI_API_KEY` Secret，再在 Dashboard 重新部署。
>
> **R2 存储**: 先在 Dashboard 创建 R2 bucket，更新 `wrangler.jsonc` 添加 binding，再部署代码。

## 5. 部署顺序规则

```
密钥/Secret  ──→  Schema 变更  ──→  种子数据  ──→  代码推送
   (先)            (先)            (任意)        (最后)
```

| 优先级 | 部署项 | 原因 |
|:---|:---|:---|
| 1 | **新增密钥 (Secrets)** | 代码启动时会读取，缺失则报错。设置后需重新部署。 |
| 2 | **Schema 变更** | 新代码依赖新表/新字段，先建表再部署代码。 |
| 3 | **种子数据** | 非关键路径，可在代码部署前后执行。 |
| 4 | **代码推送** | 推送到 `dev` 即自动部署，是最后一步。 |

**核心原则**: 永远先部署"被依赖的东西"，再部署"依赖别人的东西"。

## 6. 日常部署操作

### 合并功能分支并部署

1. 在 GitHub 上创建 PR：`feat/xxx → dev`
2. 审查通过后 Squash merge
3. Cloudflare Pages 自动检测 dev 变更 → 构建部署
4. 等待部署完成（Pages Dashboard 可查看进度）

### 验证部署

```bash
curl https://<your-project>.pages.dev/api/health
curl https://<your-project>.pages.dev/api/health/db
curl https://<your-project>.pages.dev/api/diapers
```

## 7. 回滚方案

### 代码回滚

在 GitHub 上 revert 对应的 PR，合并后 Pages 自动重新部署。

### Schema 回滚

D1 不支持迁移回滚，需手动执行逆向 SQL：

```bash
npx wrangler d1 execute abdl-space-db --remote --command "<逆向SQL>"
```

> ⚠️ 回滚 Schema 前确保没有代码依赖这些表。

## 8. 当前部署信息

| 项 | 值 |
|:---|:---|
| 生产域名 (latest) | `https://f0614066.abdl-space.pages.dev` |
| Pages 项目 | `abdl-space` |
| D1 数据库 | `abdl-space-db` (id: `159f81ba-ea32-4667-a3ce-d72cb1659d93`) |
| Production 分支 | `dev` |
| 当前 commit (main/dev) | `23569c2` |
| 构建命令 | `npm run build` |
| 输出目录 | `dist` |
| 本地 API 端口 | `8787` (`npm run api`) |
| 本地前端端口 | `5173` (`npm run dev`) |

## 9. 部署日志

### 2026-05-10 — v0.1.0 首次部署

| 时间 | 操作 | 状态 |
|:---|:---|:---:|
| - | dev 分支同步到 main (merge, commit `da94234`) | ✅ |
| - | Cloudflare Dashboard 创建 Pages 项目 `abdl-space` | ✅ |
| - | 导入 schema: `schemas/schema.sql` (14 张表) | ✅ |
| - | 导入种子: `schemas/seeds/diapers.sql` (11 条纸尿裤) | ✅ |
| - | 设置 Secret: `JWT_SECRET` | ✅ |
| - | 重新部署使 Secret 生效 | ✅ |
| - | 验证: `/api/health`、`/api/diapers` 正常响应 | ✅ |
| - | 删除已合并分支 `feat/diapers-api` | ✅ |

### Git 分支状态

```
main  @ 23569c2                     ← 当前所在
dev   @ 23569c2 (已同步)             ← Cloudflare Pages production 分支
```

> 已删除远程/本地: `feat/diapers-api`、`feat/frontend-fix`

> ⚠️ `de98b4b` 的 production 部署曾失败（021cd073），后续 `3fce82f` 部署成功覆盖。

### 2026-05-11 — B2 完成 + bug 修复 + 端口统一

| 时间 | 操作 | Commit | 状态 |
|:---|:---|:---|:---:|
| - | docs: AGENTS.md 新增「文档与 Git 状态维护纪律」 | `de98b4b` | ✅ |
| - | fix: 创建 router.tsx + 重写 index.css (品牌色+glass+dark) | `de98b4b` | ✅ |
| - | fix: diapers.ts 路由顺序修复 + avg_score/feeling_count 实时计算 | `de98b4b` | ✅ |
| - | fix: GET /api/auth/me 补充 body 字段 | `de98b4b` | ✅ |
| - | feat: 新增 src/lib/utils.ts | `de98b4b` | ✅ |
| - | fix: 统一本地端口为 8787 + 新增 npm run api 命令 | `c4ebb59` | ✅ |
| - | fix: 登录 SQL 补充 role 字段 | `3fce82f` | ✅ |
| - | ROADMAP.md B2 标记 ✅ + API.md 端口修正 | - | ✅ |
| - | docs: DEPLOYMENT.md 更新清单和日志 | `23569c2` | ✅ |
| - | Production 部署验证: `/api/health` + `/api/health/db` + `/api/diapers` OK | `23569c2` | ✅ |

## 10. 常见问题

### Q: 推送 dev 后部署失败？

查看 Cloudflare Dashboard → Pages → abdl-space → Deployments → 构建日志。

### Q: Secret 设置后不生效？

设置 Secret 后需要**重新部署**。在 Dashboard 中点击 Retry deploy。

### Q: 种子数据重复导入报错？

先清空再导入：
```bash
npx wrangler d1 execute abdl-space-db --remote --command "DELETE FROM diaper_sizes; DELETE FROM diapers;"
npx wrangler d1 execute abdl-space-db --remote --file schemas/seeds/diapers.sql
```
