# ABDL Space API — 部署指南

> 本文档说明何时需要部署、部署什么、以及部署顺序。

## 2026-10-03：Android 3.0.0 / code31 正式发布

安装包已通过既有 R2 桶 `abdl-space-img` 发布到 https://r2.abdl-space.top/apk/ABDL-Space-3.0.0-31.apk，完整回下载哈希验证后写入 latest 元数据与14条日志。首次图床 multipart 上传因上游返回HTML失败，未写版本；成功路径为R2上传及既有JSON版本接口。此次不部署新的Worker代码，不改鉴权或退役策略。分支、签名、测试失败边界及恢复旧metadata方法见 [正式版发布记录](docs/app-release-3.0.0-31-2026-10-03.md)。

## 宝宝相册（0071，2026-10-05 后端已自动部署，App未发布）

`feat/baby-albums` 包含独立私有 COS 相册与原子容量账本。现有库先核对赞助者 0062 前置表，再仅审查并应用 `migrations/0071_baby_albums.sql`，随后部署后端，最后发布支持相册的新 App。不要在现有生产库重放完整 schema 或批量 apply 历史迁移。公开相册帖子对网页/旧 App 仍为兼容文字；相册名称、描述和签名预览每次按实时可见性读取。

2026-10-05 用户授权后端合入 main 并触发自动部署；已核验前置表、保存 D1 恢复点并执行生产 migration 0071；PR #18合入main `92a15f3`，Workers Builds `f444aaf0-0d92-4f89-b50e-8b1653666873`成功，Worker版本 `374248ab-063d-4871-9b06-a27ed9a9b087`100%启用。相册401/no-store、赞助容量权益及旧时间线均在直连和主站代理核验通过。没有运行本地 Worker 部署、批量 COS 历史复制、APK 发布或 latest 更新。状态及恢复点见 [生产交付记录](docs/baby-albums-production-2026-10-05.md)。容量在取消后仅于实际清理成功时释放；有效历史赞助者若缺少真实方案快照，保守回退周档 5 GiB。历史导入只处理可证明所有权的托管文件，不保证外部/他人链接全量迁移。详细接口、真实双账号/COS/真机验收与发布边界见 [宝宝相册说明](docs/baby-albums-api.md)。

## 1. 部署架构概述

| 组件 | 域名 | 平台 | 触发方式 |
|:---|:---|:---|:---|
| 后端 (API) | `api.abdl-space.top` | Cloudflare Workers | 已关联 main 的 Workers Builds；手动 `wrangler deploy` 仅用于另行授权场景 |
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

**触发**: 基础 schema 或任一功能迁移有变更。

`schemas/schema.sql` 包含基础表与部分完整功能表，不能替代有序增量迁移。新数据库必须使用 bootstrap manifest，按固定顺序应用 schema 与账号徽章、赞助者、小说 v2、宝宝认证、QQ 身份和 App client 等迁移（当前已有 paper_color 历史迁移回归缺陷需要单独处理，不能宣称 bootstrap 已全部通过）：

```bash
npm run db:bootstrap -- --remote
```

该命令必须显式传入 `--local` 或 `--remote`，不会猜测目标环境。

现有数据库只执行当前增量 migration，例如：

```bash
npx wrangler d1 execute abdl-space-db --remote --file migrations/0043_cos_uploads.sql
```

> 不要对现有数据库用完整 `schema.sql` 代替增量 migration。`CREATE TABLE IF NOT EXISTS` 不会为已有表增加字段。
>
> 生产 D1 的 Wrangler migration 账本可能落后于真实 schema。运行 `wrangler d1 migrations apply --remote` 前必须核对待执行列表；若它包含已实际存在的历史迁移，不得批量 apply，应只执行当前已审查的 SQL 文件。

> `--remote` 操作生产数据库，不加则操作本地。

**必须在依赖新 schema 的代码部署之前执行**，否则新代码会因查不到表/字段而报错。

### 2.3 Native App timeline policy rollout (migration 0070)

1. Review and apply only `migrations/0070_app_clients.sql` to the intended existing D1 **before** deploying the Worker. New databases include it in `scripts/database-bootstrap-files.mjs`; do not replace existing tables with the full schema. This starts a new stable measurement epoch and deliberately does not backfill legacy has_app data.
2. Deploy the reviewed Worker. Existing header-preserving proxies have been verified; no proxy implementation changes are required for this feature. Every identified native timeline must bypass HTTP CDN/shared response-cache lookup and preserve request User-Agent/X-App-Version-Code/Authorization plus response private,no-store/Vary. Internal shared real-data snapshots remain allowed only after per-request fresh authentication, observation and policy evaluation; synthetic notices never enter those snapshots. Purge or bypass any pre-existing native timeline CDN response caches; otherwise the Worker never observes cache-hit calls.
3. Deploy the admin UI. Policy defaults are `enabled=false`, empty deprecated codes, `block_unversioned=false`. Missing/corrupt policy returns503 to administrators; timeline delivery fails open. Do not enable the policy to test deployment health.
4. Verify admin stats `available=true`, stable epoch, current-user observations, authenticated home401, unchanged web responses and native response no-store. Monitor structured `app_client_observation_failed`, `app_client_policy_unavailable` and `app_client_stats_unavailable`; current read availability does not certify no historical write gaps.
5. Configure explicit deprecated codes/message first. Enable the master switch only after legacy native/all/NBW notice rendering is verified. Missing-version blocking is a separate deliberate switch. Fixed download page is https://abdl-space.top/app. Rollback is master `enabled=false`; observation continues independently. Retain migrated measurement tables on code rollback.

Counts are authenticated timeline-observed accounts with self-reported client version, not all installations or all active users. Unknown historical native UAs cannot be reconstructed. See API.md for distinct-account, version overlap, rolling UTC activity windows, latest downgrade and unavailability semantics. Reserved account `-1` and status `app-update-required` are presentation-only and real read/mutation routes return404. This gate is timeline-only, not complete server-wide blocking.

2026-10-03 已执行生产 migration 0070，并部署 Worker `1ee067d7-728e-4428-9f2d-5237fce3f4a0` 与管理端生产 Pages `8ebd6f4f-1618-42a5-9653-52cb1c4ac8b7`。总开关仍关闭。迁移起点、恢复点、真实代理链路检查及未完成的登录/旧APK验收见 [生产部署记录](docs/app-clients-production-deployment-2026-10-03.md)。

### 2.4 种子数据部署（手动）

**触发**: `schemas/seeds/` 目录下新增或更新了 SQL 文件

```bash
npx wrangler d1 execute abdl-space-db --remote --file schemas/seeds/<name>.sql
```

种子数据可在代码部署前后任意时间执行，不影响已有功能。

### 2.5 环境变量 / 密钥部署（手动）

**触发**: 新增或修改了密钥（如 `JWT_SECRET`、`AI_API_KEY` 等）

```bash
npx wrangler secret put JWT_SECRET --name abdl-space-api
```

由交互提示安全输入 Secret，不要把 Secret 写入命令参数、shell history、仓库文件或日志。

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
npx wrangler secret put JWT_SECRET --name abdl-space-api
```

### Step 5: 设置 COS 密钥

先在腾讯云 CAM 创建仅允许目标 Bucket 业务目录执行必要 PutObject、HeadObject、DeleteObject 的子账号密钥，再交互设置：

```bash
npx wrangler secret put COS_SECRET_ID --name abdl-space-api
npx wrangler secret put COS_SECRET_KEY --name abdl-space-api
```

已在聊天、日志或其他非 Secret 渠道出现过的密钥必须先轮换，禁止复用。

### Step 6: 验证

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


## 9. 宝宝认证部署前置（仅说明，不在本任务执行）

现有 D1 先确认小说 `0064_novel_authoring_v2.sql` 已执行，再单独执行 `migrations/0065_baby_verification.sql`，最后部署依赖该 schema 的 Worker。禁止用完整 schema 覆盖现有库。

宝宝认证复用发帖传图已有的 `COS_SECRET_ID`、`COS_SECRET_KEY`、`COS_BUCKET`、`COS_REGION`，对象固定写入 `baby-verification/private/<user>/<application>/` 独立前缀。无需创建新 Bucket 或新 COS 密钥。

认证上传授权会把 `x-cos-acl: private` 与对象路径、大小、MD5、SHA-256、禁止覆盖头一起签名，因此该目录中的新对象即使位于公共读 Bucket 也必须签名访问。仍建议通过 Bucket Policy 对 `baby-verification/private/*` 显式拒绝匿名 `GetObject`，作为纵深防御。仍需配置：

```bash
# 32-byte 随机值的标准 Base64，用于 QQ AES-GCM 加密
npx wrangler secret put BABY_VERIFICATION_DATA_KEY --name abdl-space-api
# 高熵独立 HMAC 密钥，用于可重建的 256-bit 证书 token
npx wrangler secret put BABY_VERIFICATION_TOKEN_KEY --name abdl-space-api
```

Android 默认按现有 `COS_BUCKET` / `COS_REGION` 对应的 `abdl-1339643562.cos.ap-shanghai.myqcloud.com` 校验上传地址；如后续更换现有发帖 Bucket，可在构建时用 `BABY_VERIFICATION_COS_HOST=<bucket>.cos.<region>.myqcloud.com` 覆盖。启用前必须以真实 COS 完成 PUT→HEAD→GET、跨用户/跨对象覆盖拒绝、签名头、`x-cos-forbid-overwrite=true`，并验证 `baby-verification/private/*` 无法匿名读取。

正式站点还必须部署两端 `public/.well-known/assetlinks.json`，并确认其中 `top.abdl_space.app` 的 SHA-256 指纹与实际发布签名一致；debug/nightly 包不接管正式证书链接。功能默认 `enabled=0`，真实 COS、App Link 和真机相机验证完成后才通过管理配置开启。
