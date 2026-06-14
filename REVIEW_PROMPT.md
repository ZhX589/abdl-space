# Mastodon API 兼容层 — 代码审查提示词

## 背景

我有一个名为 ABDL Space 的垂直社区后端（Cloudflare Worker + D1），现有 API 是自定义 REST 风格。为了让我现有的 Android 客户端 Moshidon（Mastodon 开源客户端 fork）能连接到我的后端，我在不改动现有 API 的前提下，新增了一层 Mastodon 兼容 API（`/api/v1/*`）。

## 需要你审查的内容

### 1. 架构合理性

当前架构：
```
Moshidon (Mastodon Android Client)
        │
        ▼
Cloudflare Worker
├── /api/*        → 现有 ABDL 自定义 API（不动）
├── /api/v1/*     → 新增 Mastodon 兼容层（纯转换层，无独立数据库）
├── /api/oauth/*  → 现有 OAuth 2.0 Provider
└── 共享 D1 数据库
```

兼容层特点：
- 不影响现有 API
- 读写同一个 D1 数据库
- 有自己的转换函数（ABDL entity → Mastodon entity）
- 支持 OAuth access_token 和 JWT 两种认证

**请评估**：这个架构是否合理？有没有更好的方案？

### 2. Mastodon API 兼容性

我实现了以下端点（完整代码见 `src/mastodon/routes.ts`）：

**Instance & Apps:**
- `GET /api/v1/instance` — 实例信息（静态配置 + 用户/帖子统计）
- `POST /api/v1/apps` — 注册 OAuth 应用（写入 oauth_clients 表）
- `GET /api/v1/apps/verify_credentials` — 验证应用

**Accounts:**
- `GET /api/v1/accounts/verify_credentials` — 当前用户（CredentialAccount，含 source）
- `PATCH /api/v1/accounts/update_credentials` — 编辑资料（支持 note/avatar）
- `GET /api/v1/accounts/:id` — 用户信息
- `GET /api/v1/accounts/:id/statuses` — 用户帖子列表
- `GET /api/v1/accounts/:id/followers` — 粉丝
- `GET /api/v1/accounts/:id/following` — 关注
- `POST /api/v1/accounts/:id/follow` — 关注
- `POST /api/v1/accounts/:id/unfollow` — 取关
- `GET /api/v1/accounts/relationships` — 关系状态

**Statuses:**
- `POST /api/v1/statuses` — 发帖
- `GET /api/v1/statuses/:id` — 帖子详情
- `DELETE /api/v1/statuses/:id` — 删帖
- `POST /api/v1/statuses/:id/favourite` — 点赞
- `POST /api/v1/statuses/:id/unfavourite` — 取消赞
- `POST /api/v1/statuses/:id/reblog` — 转发（no-op，ABDL 无此功能）
- `POST /api/v1/statuses/:id/unreblog` — 取消转发
- `GET /api/v1/statuses/:id/context` — 评论上下文（ancestors/descendants）

**Timelines:**
- `GET /api/v1/timelines/home` — 关注时间线（关注的人 + 自己的帖子）
- `GET /api/v1/timelines/public` — 公共时间线
- `GET /api/v1/timelines/tag/:hashtag` — 标签时间线

**Other:**
- `GET /api/v1/notifications` — 通知
- `POST /api/v1/media` — 上传图片（代理到 img.abdl-space.top）
- `GET /api/v1/search` — 搜索（用户 + 帖子 + 标签）
- `GET /api/v1/conversations` — 私信会话
- `GET /api/v1/favourites` — 收藏（返回空数组）
- `GET /api/v1/bookmarks` — 书签（返回空数组）

**请评估**：
- Moshidon（或任何标准 Mastodon 客户端）连接时，哪些端点可能有问题？
- 有没有我遗漏的关键端点？
- 响应格式是否符合 Mastodon API 规范？

### 3. 数据模型转换

转换逻辑在 `src/mastodon/converter.ts`：

**Account 转换：**
- ABDL `users` 表 → Mastodon Account
- id 转为 string
- avatar 为 null 时使用默认头像 URL
- role=admin 时添加 roles 数组
- bio → note（HTML 格式）

**Status 转换：**
- ABDL `posts` 表 → Mastodon Status
- content 从纯文本转为 HTML（段落、链接、@mention、#hashtag）
- images → media_attachments
- diaper_id → card（预览卡片）
- like_count → favourites_count
- comment_count → replies_count
- 帖子和评论的 ID 通过偏移量避免冲突（评论 ID + 10000000）

**Notification 转换：**
- ABDL like → Mastodon favourite
- ABDL follow → Mastodon follow
- ABDL comment/reply → Mastodon mention
- ABDL repost → Mastodon reblog

**请评估**：
- 转换逻辑是否有遗漏或错误？
- Mastodon 客户端是否能正确解析这些格式？
- ID 偏移量方案是否可接受？

### 4. OAuth 认证兼容性

认证流程：
1. 客户端通过 `POST /api/v1/apps` 注册应用，获取 client_id/client_secret
2. 客户端引导用户到 OAuth 授权页面
3. 用户授权后，客户端获取 authorization_code
4. 客户端用 code 换 access_token（通过现有 `/api/oauth/token`）
5. 后续请求用 `Authorization: Bearer <access_token>` 认证

认证中间件（`mastodonAuth`）：
1. 先尝试 OAuth access_token（通过 `introspectToken`）
2. 失败则尝试 JWT（通过 `verifyJWT`）

**请评估**：
- Mastodon 客户端的 OAuth 流程是否能与现有 OAuth 2.0 Provider 兼容？
- scope 映射是否正确（Mastodon: read/write/follow/push）？

### 5. 潜在问题和风险

已知限制：
- 无 ActivityPub 联邦化（纯本地实例）
- 无 Streaming API（WebSocket 推送）
- 无 Push 通知
- reblog 是 no-op
- favourites/bookmarks 返回空数组

**请评估**：
- 缺少 Streaming API 会导致 Moshidon 出现什么问题？
- 有哪些 Mastodon 客户端的隐含假设我可能没考虑到？

## 相关文件

- `src/mastodon/types.ts` — Mastodon 实体类型定义
- `src/mastodon/converter.ts` — 数据模型转换函数
- `src/mastodon/routes.ts` — 所有兼容端点实现
- `src/index.ts` — 路由注册（`app.route('/api/v1', mastodon)`）
- `src/types/index.ts` — Env 类型（含 IMGBED_UPLOAD_KEY）

## 技术栈

- Runtime: Cloudflare Workers
- Framework: Hono
- Database: Cloudflare D1 (SQLite)
- Auth: JWT + OAuth 2.0 (Authorization Code + PKCE)
- Language: TypeScript

请给出具体的改进建议，包括代码级别的修改建议。
