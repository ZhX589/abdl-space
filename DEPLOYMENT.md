# ABDL Space API — 部署指南

> 本文档说明何时需要部署、部署什么、以及部署顺序。

## 1. 部署架构概述

| 组件 | 域名 | 平台 | 触发方式 |
|:---|:---|:---|:---|
| 后端 (API) | `api.abdl-space.top` | Cloudflare Workers | 手动 `wrangler deploy` |
| D1 数据库 | — | Cloudflare D1 | 手动 `wrangler d1 execute --remote` |
| 环境变量 / 密钥 | — | Cloudflare Workers Secrets | 手动 `wrangler secret put` |

- **Workers 项目名**: `abdl-space-api`
- **D1 数据库**: `abdl-space-db` (binding 名 `abdl_space_db`)

> 前端 Wiki 页面已拆分到独立仓库，不再由此仓库部署。

## 2. 部署类型与触发条件

### 2.1 后端 API 部署

```bash
npm run deploy
```

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
echo "your-secret-value" | npx wrangler secret put JWT_SECRET --name abdl-space-api
```

## 3. 首次部署完整流程

### Step 1: 推送代码到 GitHub

```bash
git checkout dev
git push origin dev
```

### Step 2: 在 Cloudflare Dashboard 创建 Workers 项目

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. **Workers & Pages → Create application → Workers → Connect to Git**
3. 选择 `abdl-space` 仓库
4. 配置：
   - **Build command**: `npm run deploy`
   - **Branch**: `dev`

### Step 3: 导入数据库

```bash
# 导入表结构（14 张表 + 索引）
npx wrangler d1 execute abdl-space-db --remote --file schemas/schema.sql

# 导入种子数据（11 条纸尿裤 + 尺码）
npx wrangler d1 execute abdl-space-db --remote --file schemas/seeds/diapers.sql
```

### Step 4: 设置 JWT 密钥

```bash
echo "your-secret-value" | npx wrangler secret put JWT_SECRET --name abdl-space-api
```

### Step 5: 验证

```bash
curl https://api.abdl-space.top/api/health
# 期望: {"status":"ok","timestamp":"..."}

curl https://api.abdl-space.top/api/diapers
# 期望: 返回纸尿裤数据
```

## 4. 部署顺序规则

```
密钥/Secret  ──→  Schema 变更  ──→  种子数据  ──→  代码推送
   (先)            (先)            (任意)        (最后)
```

| 优先级 | 部署项 | 原因 |
|:---|:---|:---|
| 1 | **新增密钥 (Secrets)** | 代码启动时会读取，缺失则报错。设置后需重新部署。 |
| 2 | **Schema 变更** | 新代码依赖新表/新字段，先建表再部署代码。 |
| 3 | **种子数据** | 非关键路径，可在代码部署前后执行。 |
| 4 | **代码推送** | 推送到 `dev` 即自动部署（如配置了 auto-deploy）。 |

**核心原则**: 永远先部署"被依赖的东西"，再部署"依赖别人的东西"。

## 5. 日常部署操作

### 合并功能分支并部署

1. 在 GitHub 上创建 PR：`feat/xxx → dev`
2. 审查通过后 Squash merge
3. 推送 dev 到远程
4. 手动运行 `npm run deploy`

### 验证部署

```bash
curl https://api.abdl-space.top/api/health
curl https://api.abdl-space.top/api/diapers
```

## 6. 回滚方案

### 代码回滚

在 GitHub 上 revert 对应的 PR，重新部署。

### Schema 回滚

D1 不支持迁移回滚，需手动执行逆向 SQL：

```bash
npx wrangler d1 execute abdl-space-db --remote --command "<逆向SQL>"
```

> ⚠️ 回滚 Schema 前确保没有代码依赖这些表。

## 7. 当前部署信息

| 项 | 值 |
|:---|:---|
| API 域名 | `https://api.abdl-space.top` |
| Workers 项目 | `abdl-space-api` |
| D1 数据库 | `abdl-space-db` (id: `159f81ba-ea32-4667-a3ce-d72cb1659d93`) |
| 本地 API 端口 | `8787` (`npm run dev` → Worker dev) |

## 8. 常见问题

### Q: 部署后不生效？

查看 Cloudflare Dashboard → Workers & Pages → abdl-space-api → Deployments → 构建日志。

### Q: Secret 设置后不生效？

设置 Secret 后需要**重新部署**。在 Dashboard 中点击 Retry deploy。

### Q: 种子数据重复导入报错？

先清空再导入：
```bash
npx wrangler d1 execute abdl-space-db --remote --command "DELETE FROM diaper_sizes; DELETE FROM diapers;"
npx wrangler d1 execute abdl-space-db --remote --file schemas/seeds/diapers.sql
```
