# ABDL Space — API 规格文档

> 本文档是 ABDL Space API 后端的权威 API 参考。前端 Wiki 页面已拆分到独立仓库，A 站点据此对接。

## 一、概述

### 协作关系

| | A 站点（主站） | 本项目（API 后端） |
|--|---------------|---------------|
| 定位 | 评分/评论平台，纯前端 | API 后端 |
| 职责 | 展示评分、纸尿裤、论坛 | 数据存储 + 所有 API |
| 账号 | 共享同一套用户系统（JWT） | 用户注册/登录/鉴权 |

### Base URL

```
生产: https://api.abdl-space.top
本地: http://localhost:8787
```

---

## 二、认证与鉴权

### JWT Bearer Token

所有需鉴权接口在请求头携带：

```
Authorization: Bearer <token>
```

也支持 HttpOnly Cookie：`token=<jwt>; Domain=.abdl-space.top`

### 鉴权级别

| 级别 | 说明 | 检查方式 |
|------|------|---------|
| 无需鉴权 | 公开接口 | 无 |
| 需鉴权 | 登录用户可用 | 验证 JWT 有效性 |
| 需管理员 | 仅 admin 角色 | JWT 中 `role === 'admin'` |

### 登录规则

- 支持用 **email** 或 **username** 登录，由后端自动判断
- 请求体中 `login` 字段接受 email 或 username

---

## 三、通用约定

### 分页

请求参数：`?page=1&limit=20`（page ≥ 1，limit 1–100）

响应格式：
```json
{
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 42,
    "totalPages": 3
  }
}
```

### 时间格式

所有时间字段使用 ISO 8601：`2026-05-08T15:10:35.472Z`

### 错误响应

```json
{ "error": "错误描述" }
```

| HTTP 状态码 | 含义 |
|------------|------|
| 400 | 请求参数错误 |
| 401 | 未认证或 token 无效 |
| 403 | 无权限 |
| 404 | 资源不存在 |
| 409 | 冲突（重复创建）|
| 429 | 频率限制 |
| 500 | 服务器错误 |

### 用户信息脱敏

所有 API 返回的用户信息统一为：

```json
{
  "id": 1,
  "username": "ZhX",
  "avatar": "https://..."
}
```

**绝不返回** `password_hash`、`email`、`weight`、`waist`、`hip` 等敏感字段，除非是用户查看自己的资料（`/api/auth/me`）或管理员接口。

---

## 四、数据库 Schema

完整 SQL 见 [`schemas/schema.sql`](./schemas/schema.sql)。

### 表关系概览

```
users ─┬─ ratings (1:N, by user_id)
       ├─ feelings (1:N, by user_id)
       ├─ posts (1:N, by user_id)
       ├─ likes (1:N, by user_id)
       ├─ experience (1:1, by user_id)
       ├─ points (1:1, by user_id)
       ├─ notifications (1:N, by user_id)
       ├─ messages (1:N, by sender_id/receiver_id)
       ├─ follows (N:N, follower_id/following_id)
       ├─ daily_checkins (1:N, by user_id)
       ├─ invite_codes (1:N, by creator_id)
       ├─ user_badges (1:N, by user_id)
       ├─ wiki_inline_comments (1:N, by author_id)
       ├─ reports (1:N, by reporter_id)
       └─ oauth_clients (1:N, by owner_id)

diapers ─┬─ diaper_sizes (1:N, CASCADE)
         ├─ diaper_images (1:N, CASCADE)
         ├─ ratings (1:N, by diaper_id)
         ├─ feelings (1:N, by diaper_id)
         ├─ posts (1:N, optional by diaper_id)
         └─ wiki_pages (1:1, optional by diaper_id)

posts ──── post_comments (1:N, CASCADE)
         ──── post_images (1:N, CASCADE)
         ──── likes (by target_type='post')

post_comments ──── comment_images (1:N, CASCADE)
               ──── likes (by target_type='comment')

wiki_pages ─┬─ page_versions (1:N, CASCADE)
            └─ wiki_inline_comments (1:N, CASCADE)

terms (独立表)
brands (独立表, 关联 diapers.brand)
```

### 关键约束

| 表 | 约束 | 说明 |
|---|------|------|
| `ratings` | UNIQUE(user_id, diaper_id) | 每人每款只能评一次 |
| `feelings` | UNIQUE(user_id, diaper_id, size) | 每人每款每尺码一条 |
| `likes` | UNIQUE(user_id, target_type, target_id) | 每人对同一目标只能赞一次 |
| `diaper_sizes` | UNIQUE(diaper_id, label) | 每款每尺码一条 |
| `wiki_pages` | UNIQUE(diaper_id) WHERE NOT NULL | 每款纸尿裤最多一个 Wiki 页面 |

---

## 五、API 端点

### 5.1 Auth（认证）

#### POST /api/auth/send-code

发送邮箱验证码（注册/重置密码/绑定邮箱）。

- **鉴权**：否
- **请求 body**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| email | string | 是 | 目标邮箱 |
| type | string | 是 | `register` / `reset` / `bind` |

- **响应 200**：`{ "message": "验证码已发送" }`
- **错误**：429（发送过于频繁）

#### POST /api/auth/register

注册新用户，返回 JWT。

- **鉴权**：否
- **请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| email | string | 是 | 合法邮箱格式，全局唯一 |
| password | string | 是 | ≥8 字符，需包含大小写字母和数字 |
| username | string | 是 | 2–32 字符，全局唯一 |
| code | string | 条件 | 邮箱验证码（非 NBW 注册时必填） |
| nbw_code | string | 否 | NBW 授权码（旧流程） |
| nbw_token | string | 否 | NBW 绑定 token（新流程） |
| invite_code | string | 否 | 邀请码 |

- **响应 201**：
```json
{
  "token": "***",
  "user": {
    "id": 1, "email": "...", "username": "...",
    "avatar": "https://img.abdl-space.top/file/system/1781439303787_play_store_512.png",
    "role": "user", "is_beta_user": 0
  },
  "rewards": {
    "total_exp": 0,
    "total_points": 0
  }
}
```
- **错误**：400（参数不合法）、409（email 或 username 已存在）、429（频率限制）

#### POST /api/auth/login

登录，支持 email 或 username。

- **鉴权**：否
- **请求 body**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| login | string | 是 | email 或 username |
| password | string | 是 | |

- **响应 200**：
```json
{
  "token": "***",
  "user": { "id": 1, "email": "...", "username": "...", "avatar": "...", "role": "user" }
}
```
- **错误**：401（账号或密码错误）、429（频率限制）

#### POST /api/auth/reset-password

重置密码（通过邮箱验证码）。

- **鉴权**：否
- **请求 body**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| email | string | 是 | 注册邮箱 |
| code | string | 是 | 6 位验证码 |
| new_password | string | 是 | ≥8 位，含大小写字母和数字 |

- **响应 200**：`{ "message": "密码已重置" }`

#### POST /api/auth/bind-email

绑定/更换邮箱（需登录 + 验证码）。

- **鉴权**：是
- **请求 body**：`{ "email": "...", "code": "123456" }`
- **响应 200**：`{ "message": "邮箱已绑定" }`

#### GET /api/auth/me

获取当前用户完整信息。

- **鉴权**：是
- **响应 200**：
```json
{
  "id": 1, "email": "...", "username": "...", "role": "admin",
  "avatar": "...", "age": 25, "region": "北京",
  "weight": 65.0, "waist": 75.0, "hip": 95.0,
  "style_preference": "日系", "bio": "...",
  "email_verified": 0, "nbw_uid": null, "nbw_username": null,
  "is_beta_user": 0, "created_at": "..."
}
```

#### POST /api/auth/logout

登出（清除 Cookie）。

- **鉴权**：否
- **响应 200**：`{ "message": "已登出" }`

---

### 5.2 Diapers（纸尿裤）

#### GET /api/diapers

纸尿裤列表，支持筛选/排序/分页。每条附带贝叶斯加权综合评分。

- **鉴权**：否
- **请求 query**：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| search | string | — | 模糊搜索 brand + model（不区分大小写）|
| brand | string | — | 精确筛选品牌 |
| size | string | — | 筛选支持的尺码（匹配 sizes 数组内 label）|
| sort | string | id | `id` / `avg_score` / `rating_count` / `thickness` |
| order | string | ASC | `ASC` / `DESC` |
| page | integer | 1 | ≥1 |
| limit | integer | 20 | 1–100 |

- **响应 200**：
```json
{
  "diapers": [
    {
      "id": 1, "brand": "ABU", "model": "Little Kings",
      "product_type": "纸尿裤", "thickness": 4,
      "absorbency_mfr": "7500ml", "absorbency_adult": "7500ml",
      "is_baby_diaper": 0, "comfort": 4.5, "popularity": 8,
      "material": "布感面料、四钩环魔术贴",
      "features": "日本风格印花…", "avg_price": "25-30元/片",
      "brand_logo": "https://...", "brand_invert_dark": false, "brand_invert_light": false,
      "sizes": [
        { "label": "M", "waist_min": 79, "waist_max": 92, "hip_min": 95, "hip_max": 110 }
      ],
      "avg_score": 8.5, "base_score": 6.2,
      "rating_count": 23, "feeling_count": 5,
      "images": ["https://img.abdl-space.top/file/..."]
    }
  ],
  "base_scores": { "adult": 6.2, "baby": 6.5 },
  "pagination": { "page": 1, "limit": 20, "total": 11, "totalPages": 1 }
}
```

`avg_score` 使用贝叶斯加权计算（成人/婴儿权重不同），`base_score` 为评分人数为 0 时的理论基准分。

#### GET /api/diapers/:id

纸尿裤详情，含尺码 + 评分记录 + Wiki。

- **鉴权**：否
- **响应 200**：
```json
{
  "diaper": {
    "id": 1, "brand": "ABU", "model": "Little Kings",
    "product_type": "纸尿裤", "thickness": 4,
    "absorbency_mfr": "7500ml", "absorbency_adult": "7500ml",
    "is_baby_diaper": 0, "comfort": 4.5, "popularity": 8,
    "material": "...", "features": "...", "avg_price": "...",
    "official_url": "https://...",
    "brand_logo": "...", "brand_invert_dark": false, "brand_invert_light": false,
    "sizes": [ { "label": "M", "waist_min": 79, "waist_max": 92, "hip_min": 95, "hip_max": 110 } ],
    "avg_score": 8.5, "base_score": 6.2,
    "rating_count": 23, "feeling_count": 5,
    "images": ["https://..."]
  },
  "reviews": [
    {
      "id": 101, "user": { "id": 1, "username": "ZhX", "avatar": "...", "role": "admin" },
      "diaper_id": 1,
      "absorption_score": 9, "comfort_score": 9,
      "thickness_score": 7, "appearance_score": 10, "value_score": 8,
      "review": "非常舒服", "review_status": "approved",
      "created_at": "..."
    }
  ],
  "wiki": {
    "diaper_id": 1, "category": "纸尿裤/ABU",
    "title": "Little Kings", "content": "ABU 的旗舰产品…",
    "updated_at": "..."
  }
}
```

- `reviews` 按 `created_at` 降序
- `wiki` 无 Wiki 时为 `null`
- **错误**：404

#### GET /api/diapers/brands

品牌列表（去重，用于筛选下拉）。

- **鉴权**：否
- **响应 200**：`{ "brands": ["ABU", "咔哆拉", ...] }`

#### GET /api/diapers/sizes

尺码标签列表（去重，用于筛选下拉）。

- **鉴权**：否
- **响应 200**：`{ "sizes": ["S", "M", "L", "XL", "XXL", ...] }`

#### GET /api/diapers/compare

纸尿裤对比，最多 5 款。

- **鉴权**：否
- **请求 query**：`ids=1,2,3`（逗号分隔，最多 5 个，超过截断，不存在的 id 静默跳过）
- **响应 200**：
```json
{
  "diapers": [
    {
      "id": 1, "brand": "ABU", "model": "Little Kings",
      "thickness": 4, "absorbency_adult": "7500ml", "avg_price": "25-30元/片",
      "sizes": [ /* ... */ ],
      "dimensions": {
        "absorption_score": { "avg": 8.2 },
        "comfort_score": { "avg": 8.5 },
        "thickness_score": { "avg": 7.0 },
        "appearance_score": { "avg": 8.9 },
        "value_score": { "avg": 7.6 }
      },
      "avg_score": 8.5, "base_score": 6.2, "rating_count": 23
    }
  ]
}
```

#### GET /api/diapers/:id/ratings

某纸尿裤的评分列表 + 分维度统计。

- **鉴权**：否
- **响应 200**：
```json
{
  "reviews": [ /* 同 diaper detail 中的 reviews 格式 */ ],
  "stats": {
    "composite": 8.5,
    "count": 23,
    "dimensions": {
      "absorption_score": { "avg": 8.2, "count": 23 },
      "comfort_score": { "avg": 8.5, "count": 23 },
      "thickness_score": { "avg": 7.0, "count": 23 },
      "appearance_score": { "avg": 8.9, "count": 23 },
      "value_score": { "avg": 7.6, "count": 23 }
    }
  }
}
```

`composite` 使用加权计算（成人款/婴儿款权重不同）：
- 成人款：`absorption×0.30 + comfort×0.35 + thickness×0.10 + appearance×0.20 + value×0.05`
- 婴儿款：`absorption×0.07 + comfort×0.35 + thickness×0.03 + appearance×0.35 + value×0.20`

#### GET /api/diapers/:id/feelings

某纸尿裤的所有感受 + 统计。

- **鉴权**：否
- **响应 200**：
```json
{
  "feelings": [
    {
      "id": 1, "user": { "id": 1, "username": "ZhX", "avatar": "..." },
      "diaper_id": 1, "size": "M",
      "looseness": -2, "softness": 4, "dryness": 3,
      "odor_control": 1, "quietness": -1, "created_at": "..."
    }
  ],
  "stats": {
    "looseness": -1.5, "softness": 3.2,
    "dryness": 2.6, "odor_control": 0.8, "quietness": -0.3
  },
  "count": 12
}
```

`stats` 每维度取所有记录均值，保留 1 位小数。

---

### 5.3 Ratings（评分）

#### POST /api/ratings

为纸尿裤评分（5 维度 + 文字评价）。

- **鉴权**：是
- **请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| diaper_id | integer | 是 | 必须存在 |
| absorption_score | integer | 是 | 1–10 |
| comfort_score | integer | 是 | 1–10 |
| thickness_score | integer | 是 | 1–10 |
| appearance_score | integer | 是 | 1–10 |
| value_score | integer | 是 | 1–10 |
| review | string | 否 | 最长 500 字符 |

- **响应 200**：
```json
{
  "message": "评分成功",
  "review_status": "approved",
  "id": 101,
  "rewards": {
    "total_exp": 30,
    "total_points": 10,
    "level_change": { "from": 1, "to": 2 },
    "details": [
      { "type": "rating", "amount": 30, "currency": "exp" },
      { "type": "rating", "amount": 10, "currency": "points" },
      { "type": "newbie_rating", "amount": 5, "currency": "exp" }
    ]
  }
}
```

> **奖励规则**：
> - 评价经验 +30，积分 +10（受等级倍率影响）
> - 前 3 条评价额外 +5 经验（新手奖励）
> - 仅 review ≥ 10 字符时触发奖励，每日最多 2 条
> - 首次评价额外 +50 积分（邀请码奖励）

- **错误**：400（score 不在 1–10 / review 超限）、404（diaper 不存在）、409（已评过）

#### GET /api/ratings/me/:diaperId

当前用户对某纸尿裤的评分。

- **鉴权**：是
- **响应 200**：`{ "rating": { /* 评分对象 */ } }` 或 `{ "rating": null }`

#### DELETE /api/ratings/:id

删除评分（自动扣回获得的经验/积分）。

- **鉴权**：是（仅本人或管理员）
- **响应 200**：`{ "message": "删除成功" }`
- **错误**：404、403

---

### 5.4 Feelings（使用感受）

#### POST /api/feelings

创建使用感受。

- **鉴权**：是
- **请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| diaper_id | integer | 是 | |
| size | string | 是 | 最长 10 |
| looseness | integer | 是 | -5 到 5（负=太紧，0=刚好，正=太松）|
| softness | integer | 是 | -5 到 5（负=粗糙，正=柔软）|
| dryness | integer | 是 | -5 到 5（负=潮湿，正=干爽）|
| odor_control | integer | 是 | -5 到 5（负=异味明显，正=锁味好）|
| quietness | integer | 是 | -5 到 5（负=沙沙声大，正=静音）|

- **响应 200**：`{ "message": "提交成功", "id": 1 }`
- **错误**：409（同一用户+diaper+size 已存在）、429（每分钟最多 5 次）

#### GET /api/feelings/me/:diaperId/:size

当前用户对某纸尿裤+尺码的感受。

- **鉴权**：是
- **响应 200**：`{ "feeling": { /* ... */ } }` 或 `{ "feeling": null }`

#### DELETE /api/feelings/:id

删除感受。

- **鉴权**：是（仅本人或管理员）
- **响应 200**：`{ "message": "删除成功" }`
- **错误**：404、403

---

### 5.5 Posts（论坛帖子）

#### GET /api/posts

帖子列表。

- **鉴权**：否（已登录时 `has_liked` 返回实际值，否则 `false`）
- **请求 query**：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| page | integer | 1 | |
| limit | integer | 20 | ≤100 |
| search | string | — | 搜索 content |

- **响应 200**：
```json
{
  "posts": [
    {
      "id": 1,
      "user": { "id": 1, "username": "ZhX", "avatar": "...", "role": "admin" },
      "content": "今天试了 Little Kings，吸水量惊人！",
      "diaper_id": 1, "pinned": false, "has_nsfw": false,
      "like_count": 5, "has_liked": true,
      "comment_count": 3, "created_at": "...",
      "images": [ { "image_url": "https://...", "is_nsfw": false } ],
      "repost": null,
      "is_announcement": 0
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 42, "totalPages": 3 }
}
```

排序：置顶优先 → `created_at` 降序。

#### GET /api/posts/announcements/latest

获取最新公告帖子。

- **鉴权**：否
- **响应 200**：`{ "post": { /* 帖子对象 */ } }` 或 `{ "post": null }`

#### GET /api/posts/:id

帖子详情 + 评论。

- **鉴权**：否
- **响应 200**：
```json
{
  "post": { /* 同列表中单条 */ },
  "comments": [
    {
      "id": 1, "post_id": 1,
      "user": { "id": 2, "username": "userB", "avatar": "...", "role": "user" },
      "parent_id": null, "content": "同感！",
      "like_count": 0, "has_liked": false, "created_at": "...",
      "images": [ { "image_url": "https://...", "is_nsfw": false } ]
    }
  ]
}
```

`comments` 按 `created_at` 升序；`parent_id` 非空表示回复（仅一层嵌套）。

#### POST /api/posts

创建帖子。

- **鉴权**：是
- **请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| content | string | 是 | 1–5000 字符，不能纯空格 |
| diaper_id | integer | 否 | 关联纸尿裤 id |
| images | array | 否 | 图片数组 `[{ "url": "...", "is_nsfw": false }]` |
| repost_id | integer | 否 | 转发的原帖 id |
| is_announcement | boolean | 否 | 仅管理员可设为 true |

- **响应 201**：
```json
{
  "id": 1, "message": "发布成功",
  "rewards": { "total_exp": 10, "total_points": 3 }
}
```
- **错误**：400（content 为空或超限）

#### PATCH /api/posts/:id

编辑帖子。

- **鉴权**：是（仅本人或管理员）
- **请求 body**：`{ "content": "新内容" }`
- **响应 200**：`{ "message": "已修改" }`

#### DELETE /api/posts/:id

删除帖子（自动扣回获得的经验/积分，级联删除图片）。

- **鉴权**：是（仅本人或管理员）
- **响应 200**：`{ "message": "已删除" }`
- **错误**：404、403

---

### 5.6 Post Comments（帖子评论）

#### POST /api/posts/:id/comments

在帖子下发表评论。

- **鉴权**：是
- **请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| content | string | 是 | 1–2000 字符 |
| parent_id | integer | 否 | 回复的评论 id，null 为顶级评论 |
| images | array | 否 | 图片数组 `["https://..."]` |

- **响应 201**：
```json
{
  "message": "评论成功", "id": 1,
  "rewards": { "total_exp": 5, "total_points": 2 }
}
```
- **错误**：404（帖子不存在）、400（content 空/超限/parent_id 不合法）

#### DELETE /api/posts/:postId/comments/:commentId

删除评论（自动扣回经验/积分）。

- **鉴权**：是（仅本人或管理员）
- **响应 200**：`{ "message": "评论已删除" }`

---

### 5.7 Likes（点赞）

#### POST /api/likes

点赞或取消点赞（toggle）。

- **鉴权**：是
- **请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| target_type | string | 是 | `post` 或 `comment` |
| target_id | integer | 是 | 必须存在 |

- **响应 200**：`{ "liked": true }` 或 `{ "liked": false }`
- **错误**：400（target_type 不合法）、404（target 不存在）、429（取消点赞后 5 分钟内不可重新点赞）

> **奖励规则**：
> - 点赞给内容作者经验 +3、积分 +3（每日上限 30 经验/30 积分）
> - 取消点赞自动扣回作者获得的经验/积分
> - 5 分钟冷却期（取消后不能立刻重新点赞）

---

### 5.8 Rankings（排行榜）

#### GET /api/rankings

- **鉴权**：否
- **请求 query**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| type | string | 是 | `hot` / `absorbency` / `popular` / `dimension` |
| dimension | string | 否 | type=dimension 时必填：`absorption_score` / `comfort_score` / `thickness_score` / `appearance_score` / `value_score` |
| limit | integer | 否 | 默认 20，最大 100 |
| offset | integer | 否 | 默认 0 |

- **排序规则**：
  - `hot`：按贝叶斯加权 avg_score 降序
  - `absorbency`：按 absorbency_adult 提取 mL 数值降序
  - `popular`：按 rating_count 降序
  - `dimension`：按指定维度所有评分均值降序

- **响应 200**：
```json
{
  "rankings": [
    {
      "id": 1, "brand": "ABU", "model": "Little Kings",
      "is_baby_diaper": false,
      "avg_score": 8.5, "base_score": 6.2, "rating_count": 23,
      "thickness": 4, "absorbency_adult": "7500ml"
    }
  ],
  "type": "hot",
  "base_scores": { "adult": 6.2, "baby": 6.5 },
  "total": 11, "hasMore": false
}
```

- **错误**：400（type 不合法 / dimension 缺失）

---

### 5.9 Search（搜索）

#### GET /api/search

全文搜索，跨纸尿裤、Wiki、术语三表。

- **鉴权**：否
- **请求 query**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| q | string | 是 | ≥2 字符 |
| type | string | 否 | `all`（默认）/ `diapers` / `wiki` / `terms` |
| limit | integer | 否 | 默认 20，最大 50 |

- **响应 200**：
```json
{
  "query": "ABU", "type": "all", "total": 5,
  "results": {
    "diapers": [ { "id": 1, "brand": "ABU", "model": "...", "avg_score": 8.5, "rating_count": 23 } ],
    "wiki": [ { "id": 1, "slug": "abu-guide", "title": "ABU 指南", "content_preview": "..." } ],
    "terms": [ { "id": 1, "term": "ABDL", "abbreviation": "...", "category": "基本概念" } ]
  }
}
```

---

### 5.10 Notifications（通知）

#### GET /api/notifications

当前用户通知列表。

- **鉴权**：是
- **响应 200**：
```json
{
  "notifications": [
    {
      "id": 1, "type": "like",
      "message": "ZhX 赞了你的帖子",
      "related_id": 1, "read": false, "created_at": "..."
    }
  ],
  "unread_count": 3
}
```

触发事件：`like`（帖子/评论被赞）、`comment`（帖子被评论）、`reply`（评论被回复）、`follow`（被关注）、`repost`（帖子被转发）

#### POST /api/notifications/read-all

全部标记已读。

- **鉴权**：是
- **响应 200**：`{ "message": "已全部标为已读" }`

---

### 5.11 Users & Experience（用户与等级）

#### GET /api/users/search?q=

搜索用户（模糊匹配 username）。

- **鉴权**：否
- **响应 200**：
```json
{
  "users": [ { "id": 1, "username": "ZhX", "avatar": "...", "role": "admin" } ]
}
```

#### GET /api/users/:id

用户公开信息。

- **鉴权**：否
- **响应 200**：
```json
{
  "user": {
    "id": 1, "username": "ZhX", "role": "admin",
    "avatar": "...", "age": 25, "region": "北京",
    "style_preference": "日系", "bio": "...",
    "created_at": "...", "worn_count": 5
  }
}
```

不返回 weight/waist/hip/email。`worn_count` 为评过分的不同纸尿裤数。

#### PATCH /api/users/me

修改当前用户信息。

- **鉴权**：是
- **请求 body**（所有字段可选，未传不修改）：

| 字段 | 类型 | 约束 |
|------|------|------|
| avatar | string/null | URL, ≤2048 |
| age | integer/null | 1–150 |
| region | string/null | ≤50 |
| weight | number/null | kg, >0, ≤500 |
| waist | number/null | cm, >0, ≤300 |
| hip | number/null | cm, >0, ≤300 |
| style_preference | string/null | ≤100 |
| bio | string/null | ≤500 |

- **响应 200**：`{ "user": { /* 完整用户对象，无 password_hash */ } }`

#### GET /api/users/:id/level

用户等级/经验值。

- **鉴权**：否
- **响应 200**：
```json
{
  "user_id": 1,
  "level": 2,
  "total_exp": 150,
  "current_exp": 150,
  "current_streak": 5,
  "progress": { "current": 150, "needed": 300, "progress": 50 },
  "multipliers": { "checkin": 1.0, "points": 1.0 }
}
```

- **等级表**：

| 等级 | 累计经验 | 徽章 | 图标 | 签到倍率 | 积分倍率 |
|------|---------|------|------|---------|---------|
| 1 | 0 | 婴儿奶瓶 | 🍼 | 1.0 | 1.0 |
| 2 | 100 | 安抚奶嘴 | 👶 | 1.1 | 1.1 |
| 3 | 300 | 婴儿围兜 | 🧣 | 1.2 | 1.2 |
| 4 | 600 | 毛绒玩偶 | 🧸 | 1.3 | 1.3 |
| 5 | 1000 | 学步车 | 🦽 | 1.5 | 1.5 |
| 6 | 1500 | 小童床 | 🛏️ | 1.7 | 1.7 |
| 7 | 2100 | 儿童王座 | 👑 | 2.0 | 2.0 |

#### GET /api/users/:id/posts

用户发的帖子。

- **鉴权**：否
- **响应**：同 `GET /api/posts` 格式（无分页，返回最多 limit 条）

#### GET /api/users/:id/ratings

用户的评分记录。

- **鉴权**：否
- **响应**：`{ "reviews": [ /* 同 ratings 格式 */ ] }`

#### GET /api/users/:id/feelings

用户的感受记录。

- **鉴权**：否
- **响应**：`{ "feelings": [ /* 同 feelings 格式 */ ] }`

#### GET /api/users/:id/worn

用户穿过的纸尿裤（评过分的）。

- **鉴权**：否
- **响应 200**：
```json
{
  "worn": [
    {
      "diaper_id": 1, "diaper_name": "ABU Little Kings",
      "brand": "ABU", "avg_score": 8.5, "rated_at": "..."
    }
  ],
  "total": 5
}
```

---

### 5.12 Follows（关注）

#### POST /api/follows/:userId

关注用户。

- **鉴权**：是
- **响应 200**：`{ "message": "已关注", "mutual": false }`
- **错误**：400（不能关注自己）、404（用户不存在）、409（已关注）

> `mutual: true` 表示双方互相关注（成为好友）

#### DELETE /api/follows/:userId

取消关注。

- **鉴权**：是
- **响应 200**：`{ "message": "已取消关注" }`

#### GET /api/follows/:userId/status

关注状态。

- **鉴权**：是
- **响应 200**：
```json
{ "following": true, "follower": false, "mutual": false }
```

#### GET /api/follows/:userId/followers

粉丝列表。

- **鉴权**：否
- **请求 query**：`page`、`limit`
- **响应 200**：
```json
{
  "users": [ { "id": 2, "username": "userB", "avatar": "...", "role": "user" } ],
  "total": 15
}
```

#### GET /api/follows/:userId/following

关注列表。

- **鉴权**：否
- **请求 query**：`page`、`limit`
- **响应 200**：同 followers 格式

---

### 5.13 Messages（私信）

#### GET /api/messages/conversations

对话列表（最近联系人）。

- **鉴权**：是
- **响应 200**：
```json
{
  "conversations": [
    {
      "user_id": 2, "username": "userB", "avatar": "...",
      "last_message": "你好", "last_message_at": "...",
      "unread_count": 3
    }
  ]
}
```

#### GET /api/messages/:userId

与某用户的消息记录。

- **鉴权**：是
- **请求 query**：`page`（默认 1）、`limit`（默认 50，最大 100）
- **响应 200**：
```json
{
  "messages": [
    {
      "id": 1, "sender_id": 1, "receiver_id": 2,
      "content": "你好", "read": true, "created_at": "..."
    }
  ]
}
```

#### POST /api/messages

发送消息。

- **鉴权**：是
- **请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| receiver_id | integer | 是 | 不能是自己 |
| content | string | 是 | 1–2000 字符 |

- **响应 201**：`{ "id": 1, "message": "发送成功" }`
- **错误**：400（参数错误）、403（对方关闭私信）、404（用户不存在）

#### POST /api/messages/:userId/read

标记已读。

- **鉴权**：是
- **响应 200**：`{ "message": "已标为已读" }`

---

### 5.14 Images（图床代理）

#### POST /api/images/upload

代理上传到图床（img.abdl-space.top）。

- **鉴权**：是
- **请求**：`multipart/form-data`，字段 `file`
- **约束**：JPG/PNG/GIF/WebP，≤5MB
- **响应 200**：`{ "url": "https://img.abdl-space.top/file/..." }`

#### POST /api/images/delete

代理删除图床图片。

- **鉴权**：是
- **请求 body**：`{ "url": "https://img.abdl-space.top/file/..." }`
- **响应 200**：`{ "message": "已删除" }`

#### GET /api/images/list

列出图床图片（管理员）。

- **鉴权**：需管理员
- **请求 query**：`page`、`perPage`
- **响应 200**：图床 API 原始响应

---

### 5.15 Reports（举报）

#### POST /api/reports

提交举报。

- **鉴权**：是
- **请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| target_type | string | 是 | `post` / `comment` |
| target_id | integer | 是 | |
| reason | string | 是 | `nsfw` / `spam` / `other` |
| description | string | 否 | |

- **响应 201**：`{ "message": "举报已提交，感谢您的反馈" }`
- **错误**：409（已举报过，待处理）

#### GET /api/reports/admin

管理员查看举报列表。

- **鉴权**：需管理员
- **请求 query**：`status`（默认 `pending`）、`page`、`limit`
- **响应 200**：
```json
{
  "reports": [
    {
      "id": 1, "reporter_id": 1, "reporter_name": "ZhX",
      "target_type": "post", "target_id": 5,
      "reason": "nsfw", "description": "...",
      "status": "pending", "content_preview": "帖子内容前 100 字...",
      "created_at": "..."
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 3 }
}
```

#### PATCH /api/reports/admin/:id

处理举报。

- **鉴权**：需管理员
- **请求 body**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| action | string | 是 | `resolve`（处理）/ `dismiss`（驳回） |
| delete_content | boolean | 否 | action=resolve 时是否同时删除被举报内容 |

- **响应 200**：`{ "message": "举报已处理" }`

---

### 5.16 Terms（术语百科）

#### GET /api/terms

术语列表。

- **鉴权**：否
- **请求 query**：

| 字段 | 类型 | 说明 |
|------|------|------|
| search | string | 模糊搜索 term + definition |
| category | string | 精确筛选分类 |

- **响应 200**：
```json
{
  "terms": [
    {
      "id": 1, "term": "ABDL",
      "abbreviation": "Adult Baby / Diaper Lover",
      "definition": "成人宝宝/纸尿裤爱好者…",
      "category": "基本概念", "created_by": 1, "created_at": "..."
    }
  ]
}
```

#### GET /api/terms/categories

分类列表（去重）。

- **鉴权**：否
- **响应 200**：`{ "categories": ["基本概念", "品牌", "产品类型"] }`

#### GET /api/terms/:id

获取单个术语详情。

- **鉴权**：否
- **响应 200**：`{ "id": 1, "term": "ABDL", ... }`

#### POST /api/terms

创建术语。

- **鉴权**：需管理员
- **请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| term | string | 是 | 1–50 |
| abbreviation | string | 否 | ≤100 |
| definition | string | 是 | 10–2000 |
| category | string | 否 | ≤30 |

- **响应 201**：`{ "id": 1, "message": "创建成功" }`

#### PATCH /api/terms/:id

编辑术语。

- **鉴权**：需管理员
- **请求 body**：同 POST，所有字段可选

#### DELETE /api/terms/:id

删除术语。

- **鉴权**：需管理员
- **响应 200**：`{ "message": "已删除" }`

---

### 5.17 Recommend（推荐）

#### POST /api/recommend

AI 推荐，根据用户信息 + 纸尿裤数据库返回推荐（DeepSeek 模型驱动）。

- **鉴权**：是
- **请求 body**：

```json
{
  "selected": {
    "basic": true, "body": true, "prefs": true,
    "bio": true, "feelings": true
  }
}
```

`selected` 指定用户授权哪些数据用于推荐：basic(年龄/地区)、body(体重/腰围/臀围)、prefs(偏好)、bio(简介)、feelings(感受历史)

- **响应 200**：
```json
{
  "recommendations": [
    {
      "diaper_id": 1, "brand": "ABU", "model": "Little Kings",
      "reason": "吸水量极高…", "matchScore": 92
    }
  ],
  "summary": "根据您的数据，推荐以上 4 款",
  "content": [
    { "type": "text", "text": "根据你的数据分析，" },
    { "type": "diaper", "diaper_id": 1 },
    { "type": "text", "text": "非常适合你的身材特点..." }
  ],
  "diapers": [ { "id": 1, "brand": "ABU", "model": "...", "product_type": "纸尿裤" } ]
}
```

- **错误**：503（API Key 未配置）、502（DeepSeek 调用失败）

#### GET /api/recommend/guess

"猜你喜欢"，纯数据驱动（不需要 AI）。

- **鉴权**：否
- **规则**：取综合评分最高的 5 款，附推荐理由
  - avg_score ≥ 8.0 → "综合评分超高，社区力荐"
  - thickness ≤ 2 → "超薄设计，适合日常穿着"
  - 其他 → "热门之选"

- **响应 200**：
```json
{
  "recommendations": [
    {
      "id": 1, "brand": "ABU", "model": "Little Kings",
      "avg_score": 8.5, "rating_count": 23, "thickness": 4,
      "reason": "综合评分超高，社区力荐"
    }
  ]
}
```

---

### 5.18 Wiki Pages（Wiki 页面）

#### GET /api/pages

Wiki 列表。

- **鉴权**：否
- **请求 query**：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| diaper_id | integer | — | 筛选关联某纸尿裤的 Wiki |
| page | integer | 1 | |
| limit | integer | 20 | |

- **响应 200**：
```json
{
  "pages": [
    {
      "id": 1, "slug": "little-kings", "title": "Little Kings",
      "diaper_id": 1, "version": 3, "is_published": 1,
      "author_id": 1, "created_at": "...", "updated_at": "..."
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 5, "totalPages": 1 }
}
```

#### GET /api/pages/:slug

Wiki 页面详情（含 Markdown 正文）。

- **鉴权**：否
- **响应 200**：
```json
{
  "id": 1, "slug": "little-kings", "title": "Little Kings",
  "content": "# Little Kings\nABU 旗舰产品…",
  "diaper_id": 1, "version": 3, "is_published": 1,
  "author_id": 1, "created_at": "...", "updated_at": "..."
}
```

#### POST /api/pages

创建 Wiki 页面。

- **鉴权**：是
- **请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| slug | string | 是 | URL 友好标识，全局唯一 |
| title | string | 是 | |
| content | string | 是 | Markdown |
| diaper_id | integer | 否 | 关联纸尿裤 id（每款最多一个）|

- **响应 201**：`{ "id": 1, "slug": "little-kings", "message": "创建成功" }`
- **错误**：409（slug 已存在）、400（diaper_id 已绑定其他 Wiki）

#### PUT /api/pages/:slug

编辑 Wiki 页面。

- **鉴权**：是（仅作者或管理员）
- **请求 body**：

| 字段 | 类型 | 必填 |
|------|------|------|
| title | string | 否 |
| content | string | 否 |
| is_published | integer | 否 |

- **响应 200**：`{ "message": "更新成功", "version": 4 }`

#### DELETE /api/pages/:slug

删除 Wiki 页面。

- **鉴权**：是（仅作者或管理员）
- **响应 200**：`{ "message": "已删除" }`

---

### 5.19 Wiki Inline Comments（Wiki 段评）

段评是段落级评论，类似 oi-wiki 风格。

#### GET /api/pages/:slug/inline-comments

获取 Wiki 页面的段评。

- **鉴权**：否
- **请求 query**：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| paragraph_hash | string | — | 筛选某段落的评论；不传则返回全部 |

- **响应 200**：
```json
{
  "comments": [
    {
      "id": 1, "paragraph_hash": "abc123",
      "author": { "id": 1, "username": "ZhX", "avatar": "..." },
      "content": "这段写得不错", "created_at": "..."
    }
  ]
}
```

#### POST /api/pages/:slug/inline-comments

发表段评。

- **鉴权**：是
- **请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| paragraph_hash | string | 是 | 段落定位标识 |
| content | string | 是 | 1–1000 字符 |

- **响应 201**：`{ "id": 1, "message": "评论成功" }`

#### DELETE /api/pages/:slug/inline-comments/:id

删除段评。

- **鉴权**：是（仅作者或管理员）
- **响应 200**：`{ "message": "已删除" }`

---

### 5.20 Page Versions（Wiki 版本历史）

#### GET /api/pages/:slug/versions

获取 Wiki 页面的版本历史列表。

- **鉴权**：否
- **响应 200**：
```json
{
  "versions": [
    { "id": 1, "version": 3, "content": "...", "author": { "id": 1, "username": "ZhX", "avatar": "..." }, "created_at": "..." }
  ]
}
```

#### GET /api/pages/:slug/versions/:version

获取特定版本的详细内容。

- **鉴权**：否
- **响应 200**：
```json
{
  "version": { "id": 1, "version": 2, "content": "...", "author": { ... }, "created_at": "..." }
}
```

#### POST /api/pages/:slug/rollback/:version

回滚到指定版本（创建新版本，content 替换为旧版本内容）。

- **鉴权**：是
- **响应 200**：`{ "message": "回滚成功", "version": 4 }`

---

### 5.21 Checkin（签到）

#### POST /api/checkin

每日签到。

- **鉴权**：是
- **响应 200**：
```json
{
  "success": true,
  "data": {
    "checkin_date": "2026-06-14",
    "streak": 5,
    "points_earned": 10,
    "exp_earned": 10,
    "streak_bonus": 0
  },
  "rewards": {
    "total_exp": 10,
    "total_points": 10,
    "level_change": null,
    "details": [
      { "type": "checkin", "amount": 10, "currency": "points" },
      { "type": "checkin", "amount": 10, "currency": "exp" }
    ]
  }
}
```

> **奖励规则**：
> - 基础：经验 +10，积分 +10（受等级倍率影响）
> - 连续 7 天：额外 +20 积分
> - 连续 30 天：额外 +100 积分
> - 补签不计入连续天数

- **错误**：409（今天已签到）

#### GET /api/checkin/status

签到状态。

- **鉴权**：是
- **响应 200**：
```json
{
  "checked_in_today": true,
  "streak": 5,
  "last_checkin_date": "2026-06-14"
}
```

#### POST /api/checkin/makeup

补签（消耗 50 积分，只能补昨天）。

- **鉴权**：是
- **请求 body**：`{ "target_date": "2026-06-13" }`
- **响应 200**：
```json
{
  "success": true,
  "data": {
    "makeup_date": "2026-06-13",
    "cost": 50,
    "streak": 5,
    "streak_bonus": 0
  }
}
```
- **错误**：400（只能补昨天）、409（已签到）、400（积分不足）

---

### 5.22 Points & Exp（积分与经验）

#### GET /api/users/:id/points

积分余额。

- **鉴权**：是
- **响应 200**：
```json
{ "user_id": 1, "balance": 100, "total_earned": 200, "total_spent": 100 }
```

#### GET /api/users/:id/points/logs

积分流水。

- **鉴权**：是
- **请求 query**：`page`、`limit`
- **响应 200**：
```json
{
  "logs": [
    { "id": 1, "amount": 10, "type": "checkin", "description": "每日签到", "created_at": "..." }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 50, "totalPages": 3 }
}
```

#### GET /api/users/:id/exp/logs

经验流水。

- **鉴权**：是
- **请求 query**：`page`、`limit`
- **响应 200**：同 points/logs 格式

---

### 5.23 Badges（徽章）

#### GET /api/badges

所有徽章定义（公开）。

- **鉴权**：否
- **响应 200**：
```json
{
  "badges": [
    { "key": "first_rating", "name": "初次评价", "icon": "⭐", "description": "发表第一条评价", "condition_type": "rating_count", "condition_value": 1 }
  ]
}
```

#### GET /api/users/:id/badges

用户已解锁的徽章。

- **鉴权**：否
- **响应 200**：
```json
{
  "user_id": 1,
  "badges": [
    { "key": "first_rating", "name": "初次评价", "icon": "⭐", "description": "...", "unlocked_at": "...", "displayed": true }
  ]
}
```

#### POST /api/users/:id/badges/display

设置展示徽章（最多 3 个）。

- **鉴权**：是（只能改自己的）
- **请求 body**：`{ "badge_keys": ["first_rating", "streak_7"] }`
- **响应 200**：`{ "success": true, "displayed": ["first_rating", "streak_7"] }`

---

### 5.24 Invite（邀请码）

#### POST /api/invite/generate

生成邀请码。

- **鉴权**：是
- **限制**：最多 10 个有效邀请码，90 天过期
- **响应 200**：
```json
{
  "success": true,
  "data": { "code": "ABDL-XXXX-XXXX", "expires_at": "..." }
}
```

#### GET /api/invite/my-codes

我的邀请码列表。

- **鉴权**：是
- **响应 200**：
```json
{
  "codes": [
    {
      "id": 1, "code": "ABDL-XXXX-XXXX",
      "used": true, "used_by": "userB", "used_at": "...",
      "expires_at": "...", "created_at": "...", "expired": false
    }
  ]
}
```

---

### 5.25 OAuth 2.0

ABDL Space 作为 OAuth 2.0 Provider，支持第三方应用授权。

#### GET /api/oauth/authorize

授权端点（返回授权页面数据，不直接 redirect）。

- **鉴权**：是
- **请求 query**：`client_id`、`redirect_uri`、`scope`、`state`、`response_type=code`、`code_challenge`、`code_challenge_method`
- **响应 200**：
```json
{
  "client": { "client_id": "...", "name": "...", "description": "...", "logo_url": "...", "homepage_url": "..." },
  "user": { "id": 1, "username": "ZhX", "avatar": "..." },
  "scopes": [ { "value": "profile", "description": "基本信息" } ],
  "state": "...", "redirect_uri": "...",
  "expires_in": 600
}
```

#### POST /api/oauth/authorize

用户确认授权，签发授权码。

- **鉴权**：是
- **请求 body**：`{ "client_id": "...", "redirect_uri": "...", "scope": "...", "state": "...", "approved": true }`
- **响应 200**：`{ "redirect": "https://app.example.com/callback?code=xxx&state=xxx" }`

#### POST /api/oauth/token

令牌端点（支持 `authorization_code` 和 `refresh_token` grant type）。

- **鉴权**：否（通过 client_id + client_secret 验证）
- **请求 body**（form-urlencoded 或 JSON）：

authorization_code:
```
grant_type=authorization_code&code=xxx&redirect_uri=xxx&client_id=xxx&client_secret=xxx
```

refresh_token:
```
grant_type=refresh_token&refresh_token=xxx&client_id=xxx&client_secret=xxx
```

- **响应 200**：
```json
{
  "access_token": "...", "token_type": "Bearer",
  "expires_in": 3600, "refresh_token": "...", "scope": "profile email"
}
```

#### POST /api/oauth/revoke

吊销令牌。

- **请求 body**：`{ "token": "...", "token_type_hint": "refresh_token" }`
- **响应 200**：`{ "success": true }`

#### POST /api/oauth/introspect

令牌自省（资源服务器用）。

- **请求 body**：`{ "token": "..." }`
- **响应 200**：`{ "active": true, "sub": 1, "scope": "...", ... }`

#### GET /api/oauth/userinfo

OAuth2 用户信息端点。

- **请求头**：`Authorization: Bearer <access_token>`
- **响应 200**：`{ "sub": 1, "username": "ZhX", "email": "...", "avatar": "...", ... }`

#### GET /api/oauth/scopes

获取所有可用 scope。

- **响应 200**：`{ "scopes": [ { "value": "profile", "description": "基本信息" } ] }`

#### GET /api/oauth/tokens

当前用户已授权的 OAuth 应用列表。

- **鉴权**：是
- **响应 200**：`{ "tokens": [ { "client_id": "...", "client_name": "...", "scope": "...", ... } ] }`

#### POST /api/oauth/revoke-client

吊销某个 OAuth 应用的所有令牌。

- **鉴权**：是
- **请求 body**：`{ "client_id": "..." }`
- **响应 200**：`{ "success": true, "revoked": 3 }`

---

### 5.26 OAuth Clients（OAuth 应用管理）

#### GET /api/oauth/clients

当前用户的 OAuth 应用列表。

- **鉴权**：是

#### POST /api/oauth/clients

创建 OAuth 应用。

- **鉴权**：是
- **请求 body**：`{ "name": "...", "description": "...", "redirect_uris": ["..."], "logo_url": "...", "homepage_url": "..." }`

#### PATCH /api/oauth/clients/:clientId

更新 OAuth 应用。

- **鉴权**：是（仅拥有者）

#### DELETE /api/oauth/clients/:clientId

删除 OAuth 应用。

- **鉴权**：是（仅拥有者）

#### GET /api/oauth/clients/:clientId

获取 OAuth 应用详情。

- **鉴权**：是（仅拥有者）

#### GET /api/oauth/clients/my-tokens

当前用户通过 OAuth 授权的 token 列表。

- **鉴权**：是

#### POST /api/oauth/clients/revoke-client

吊销某个应用的所有 token。

- **鉴权**：是

#### GET /api/oauth/clients/scopes

获取可用的 scope 列表。

- **鉴权**：否

---

### 5.27 NBW（宝宝新天地 OAuth）

#### GET /api/auth/nbw/config

获取 NBW OAuth 公开配置。

- **鉴权**：否
- **响应 200**：`{ "client_id": "...", "redirect_uri": "..." }`

#### POST /api/auth/nbw/callback

NBW OAuth 回调。

- **请求 body**：`{ "code": "..." }`
- **响应 200**：

已绑定用户（直接登录）：
```json
{ "action": "login", "token": "...", "user": { "id": 1, "username": "...", "avatar": "...", "role": "user" } }
```

未绑定用户（需选择绑定方式）：
```json
{
  "action": "choose",
  "nbw_token": "...",
  "nbw_user": { "uid": "1234", "username": "...", "avatar": "..." }
}
```

#### POST /api/auth/nbw/bind-existing

用已有账号登录并绑定 NBW。

- **请求 body**：`{ "login": "...", "password": "...", "nbw_token": "..." }`
- **响应 200**：`{ "message": "绑定并登录成功", "user": {...}, "nbw_uid": "...", "nbw_username": "..." }`

#### POST /api/auth/nbw/bind

绑定 NBW 账户（已登录状态）。

- **鉴权**：是
- **请求 body**：`{ "code": "..." }`
- **响应 200**：`{ "message": "绑定成功", "nbw_uid": "...", "nbw_username": "..." }`

#### POST /api/auth/nbw/unbind

解除 NBW 绑定。

- **鉴权**：是
- **响应 200**：`{ "message": "已解绑宝宝新天地账户" }`
- **错误**：400（未绑定 / 未设置密码且未验证邮箱）

---

### 5.28 Captcha（验证码）

#### POST /api/captcha/risk

风险评估。

- **请求 body**：`{ "ip": "...", "action": "register" }`
- **响应 200**：`{ "risk": "low", "captcha_type": "turnstile" }`

#### POST /api/captcha/challenge

生成验证码挑战。

- **请求 body**：`{ "type": "quantum" }`
- **响应 200**：`{ "challenge_id": "...", "type": "quantum", "data": {...} }`

#### POST /api/captcha/verify

验证验证码。

- **请求 body**：`{ "challenge_id": "...", "solution": "..." }`
- **响应 200**：`{ "valid": true }`

#### POST /api/captcha/turnstile/verify

Cloudflare Turnstile 验证。

- **请求 body**：`{ "token": "..." }`
- **响应 200**：`{ "success": true }`

#### GET /api/captcha/status

验证码服务状态。

- **响应 200**：`{ "quantum": true, "turnstile": true }`

---

### 5.29 Beta（创始成员计划）

#### GET /api/beta/info

获取活动信息（名额、截止时间、状态）。

- **鉴权**：否
- **响应 200**：
```json
{
  "name": "ABDL Space 创始成员计划",
  "endsAt": "2026-07-31T23:59:59Z",
  "capacity": 120,
  "used": 45,
  "status": "active"
}
```

#### POST /api/beta/beta-register

创始成员预注册。

- **请求 body**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| username | string | 是 | 2-32 字符 |
| email | string | 是 | |
| password | string | 是 | ≥8 位，含大小写和数字 |
| code | string | 是 | 邮箱验证码 |
| inviteCode | string | 否 | 邀请码 |

- **响应 201**：
```json
{
  "token": "...",
  "user": { "id": 1, "email": "...", "username": "...", "avatar": "...", "role": "user", "is_beta_user": 1 },
  "beta": { "is_beta_user": true, "registered_at": "..." }
}
```
- **错误**：403（名额已满/活动已结束）

---

### 5.30 Admin（管理后台）

所有管理接口需 `role === 'admin'`。

#### GET /api/admin/stats

站点统计。

- **响应 200**：
```json
{ "users": 120, "posts": 340, "comments": 890, "diapers": 11, "ratings": 450 }
```

#### GET /api/admin/users

用户列表（含 email、role 等管理字段）。

#### DELETE /api/admin/users/:id

删除用户（级联删除所有关联数据，不能删除自己）。

#### POST /api/admin/users/:id/ban

封禁/解封（toggle）。

- **响应 200**：`{ "banned": true }`

#### GET /api/admin/posts

管理员帖子列表（最近 100 条）。

#### POST /api/admin/posts/:id/pin

置顶/取消置顶（toggle）。

- **响应 200**：`{ "pinned": true }`

#### DELETE /api/admin/posts/:id

删除帖子。

#### DELETE /api/admin/comments/:id

删除评论。

#### DELETE /api/admin/diapers/:id

删除纸尿裤（级联删除图片、尺码）。

#### GET /api/admin/diapers

纸尿裤列表（管理用，含图片和尺码）。

#### POST /api/admin/diapers

创建纸尿裤。

- **请求 body**：`{ "brand": "...", "model": "...", "product_type": "...", "sizes": [...], "images": [...] }`

#### PATCH /api/admin/diapers/:id

更新纸尿裤。

#### GET /api/admin/brands

品牌列表。

#### POST /api/admin/brands

创建/更新品牌（name 相同则更新）。

- **请求 body**：`{ "name": "...", "logo": "...", "invert_dark": false, "invert_light": false }`

#### DELETE /api/admin/brands/:id

删除品牌。

#### GET /api/admin/security/logs

安全日志。

- **请求 query**：`page`、`limit`、`type`（事件类型筛选）

#### GET /api/admin/security/stats

安全统计（24h 趋势、类型分布、风险等级分布）。

#### GET /api/admin/beta-mode

获取内测模式配置（公开接口）。

- **鉴权**：否
- **响应 200**：
```json
{ "enabled": false, "allowedRoutes": ["/", "/login", "/register"], "message": "产品正在内测中" }
```

#### PUT /api/admin/beta-mode

更新内测模式配置。

- **鉴权**：需管理员
- **请求 body**：`{ "enabled": true, "allowedRoutes": [...], "message": "..." }`

#### POST /api/admin/reset/password

管理员修改自己的密码。

- **鉴权**：需管理员
- **请求 body**：`{ "old_password": "...", "new_password": "..." }`

#### POST /api/admin/add

提升用户为管理员。

- **鉴权**：需管理员
- **请求 body**：`{ "user_ids": [1, 2, 3] }`
- **响应 200**：`{ "promoted": 2, "message": "2 个用户已提升为管理员" }`

---

### 5.31 API Keys（第三方 API 密钥管理）

#### GET /api/api_keys

获取所有 API Key（不返回 key_value 明文）。

- **鉴权**：需管理员

#### POST /api/api_keys

设置或更新 API Key。

- **鉴权**：需管理员
- **请求 body**：`{ "provider": "deepseek", "key_value": "sk-...", "label": "生产环境" }`

#### DELETE /api/api_keys/:provider

删除 API Key。

- **鉴权**：需管理员

---

### 5.32 Sync（数据同步）

#### GET /api/sync/bootstrap

启动时一次性加载当前用户核心数据。

- **鉴权**：是
- **响应 200**：
```json
{
  "user": { "id": 1, "username": "...", "avatar": "...", "role": "..." },
  "exp": { "total_exp": 150, "current_exp": 150, "current_level": 2 },
  "points": { "balance": 100, "total_earned": 200 },
  "badges": [ { "badge_key": "first_rating", "displayed": true } ]
}
```

---

### 5.33 Content API Keys（内容 API 密钥）

第三方内容 API 密钥管理（管理员创建，用户申请使用）。

#### GET /api/content/keys

当前用户的内容 API Key 列表。

- **鉴权**：是

#### POST /api/content/keys

创建内容 API Key。

- **鉴权**：是

#### PATCH /api/content/keys/:id

更新 Key 状态/备注。

- **鉴权**：是

#### DELETE /api/content/keys/:id

删除 Key。

- **鉴权**：是

---

### 5.34 Content V1（内容 API）

第三方通过 API Key 访问公开内容。

#### GET /api/v1/content/posts

帖子列表（API Key 鉴权）。

#### GET /api/v1/content/posts/:id

帖子详情。

#### GET /api/v1/content/rankings

排行榜。

#### GET /api/v1/content/diapers

纸尿裤列表。

---

### 5.35 Key Split（API Key 代理）

API Key 代理与统计系统。

#### GET /api/key-split/channels

获取代理渠道列表。

- **鉴权**：是

#### POST /api/key-split/channels

创建代理渠道。

- **鉴权**：是

#### PUT /api/key-split/channels/:id

更新代理渠道。

- **鉴权**：是

#### DELETE /api/key-split/channels/:id

删除代理渠道。

- **鉴权**：是

#### POST /api/key-split/channels/:id/test

测试代理渠道连接。

- **鉴权**：是

#### GET /api/key-split/keys

获取子 Key 列表。

- **鉴权**：是

#### POST /api/key-split/keys

创建子 Key。

- **鉴权**：是

#### PUT /api/key-split/keys/:id

更新子 Key。

- **鉴权**：是

#### DELETE /api/key-split/keys/:id

删除子 Key。

- **鉴权**：是

#### POST /api/key-split/keys/:id/reset

重置子 Key 密钥。

- **鉴权**：是

#### GET /api/key-split/usage/stats

使用统计。

- **鉴权**：是

#### GET /api/key-split/usage/logs

使用日志。

- **鉴权**：是

#### GET /api/key-split/stats

Key Split 总览统计。

- **鉴权**：是

#### ALL /v1/*

代理转发到上游 API（OpenAI 兼容格式）。

---

### 5.36 Captcha V1（验证码 V1 API）

#### GET /api/v1/captcha/embed.js

验证码嵌入脚本。

#### POST /api/v1/captcha/create

创建验证码挑战。

#### POST /api/v1/captcha/check

检查验证码结果。

#### POST /api/v1/captcha/risk

风险评估。

#### POST /api/v1/captcha/turnstile/verify

Turnstile 验证。

#### GET /api/v1/captcha/types

获取支持的验证码类型。

---

### 5.37 Captcha Keys（验证码密钥管理）

管理员管理验证码服务的密钥配置。

#### GET /api/captcha/keys

获取所有验证码密钥配置。

- **鉴权**：需管理员

#### POST /api/captcha/keys

创建验证码密钥配置。

- **鉴权**：需管理员

#### PATCH /api/captcha/keys/:id

更新验证码密钥配置。

- **鉴权**：需管理员

#### DELETE /api/captcha/keys/:id

删除验证码密钥配置。

- **鉴权**：需管理员

---

## 六、综合评分计算规则

### 贝叶斯加权评分

`avg_score` 使用贝叶斯加权计算，避免评分人数少的纸尿裤评分虚高：

```
avg_score = dimensionWeightedScore(rawDimAvgs, ratingCount, globalStats, m, isBaby)
```

- `rawDimAvgs`：该纸尿裤各维度的原始平均分
- `ratingCount`：评分人数
- `globalStats`：全局各维度平均分（按成人/婴儿分别计算）
- `m`：全局平均评分人数（贝叶斯权重参数）
- `isBaby`：是否为婴儿纸尿裤（决定维度权重）

### 维度权重

**成人款**：
- absorption: 0.30, comfort: 0.35, thickness: 0.10, appearance: 0.20, value: 0.05

**婴儿款**：
- absorption: 0.07, comfort: 0.35, thickness: 0.03, appearance: 0.35, value: 0.20

### feeling_avg

分两步：

1. 每个 feeling 记录：取 5 维度均值，映射 -5..5 → 0..10（直接 +5）
2. 所有记录的得分取均值

等价 SQL 逻辑：
```sql
SELECT AVG(
  (looseness + 5 + softness + 5 + dryness + 5 + odor_control + 5 + quietness + 5) / 5.0
) FROM feelings WHERE diaper_id = ?
```

---

## 七、种子数据

纸尿裤初始数据（11 条）来源：

```
https://github.com/ZYongX09/abdl/blob/master/client/public/data/diapers.json
```

导入命令（需先将 JSON 转为 SQL INSERT）：

```bash
npx wrangler d1 execute abdl-space-db --local --file schemas/seeds/diapers.sql
```

---

## 八、Mastodon 兼容 API

为支持 Moshidon 等 Mastodon 客户端连接，新增一套 `/api/v1/*` 兼容端点。

### 架构

```
Moshidon (Mastodon Android Client)
        │
        ▼
/api/v1/*     → Mastodon 兼容层（纯转换，无独立数据库）
/api/v2/*     → Mastodon v2 端点（search、instance）
/api/*        → 现有 ABDL 自定义 API（不动）
```

兼容层读写同一个 D1 数据库，通过转换函数将 ABDL 实体映射为 Mastodon 实体。

### 认证

支持两种 Bearer Token：
- **OAuth access_token**（通过 `/api/v1/apps` 注册 + OAuth 流程获取）
- **JWT**（现有 ABDL Space 的 token）

Mastodon scope 映射：`follow`/`push` → `write`，`read`/`write`/`profile`/`email` 保留。

### Status ID 格式

帖子和评论使用前缀格式的字符串 ID：
- 帖子：`p_<id>`（如 `p_42`）
- 评论：`c_<id>`（如 `c_100`）

也兼容 legacy 数字格式（`<10000000` 为帖子，`>=10000000` 为评论）。

### 已实现端点

#### Instance & Apps

| 端点 | 说明 |
|------|------|
| `GET /api/v1/instance` | 实例信息 |
| `GET /api/v2/instance` | 实例信息（v2） |
| `POST /api/v1/apps` | 注册 OAuth 应用 |
| `GET /api/v1/apps/verify_credentials` | 验证应用 |

#### Accounts

| 端点 | 说明 |
|------|------|
| `GET /api/v1/accounts/verify_credentials` | 当前用户（含 source） |
| `PATCH /api/v1/accounts/update_credentials` | 编辑资料（支持 JSON + multipart） |
| `GET /api/v1/accounts/:id` | 用户信息 |
| `GET /api/v1/accounts/:id/statuses` | 用户帖子 |
| `GET /api/v1/accounts/:id/followers` | 粉丝 |
| `GET /api/v1/accounts/:id/following` | 关注 |
| `POST /api/v1/accounts/:id/follow` | 关注 |
| `POST /api/v1/accounts/:id/unfollow` | 取关 |
| `GET /api/v1/accounts/relationships` | 关系状态 |
| `GET /api/v1/accounts/:id/featured_tags` | 空数组 |

#### Statuses

| 端点 | 说明 |
|------|------|
| `POST /api/v1/statuses` | 发帖（支持 media_ids） |
| `GET /api/v1/statuses/:id` | 帖子/评论详情 |
| `DELETE /api/v1/statuses/:id` | 删帖/删评论 |
| `POST /api/v1/statuses/:id/favourite` | 点赞 |
| `POST /api/v1/statuses/:id/unfavourite` | 取消赞 |
| `POST /api/v1/statuses/:id/reblog` | 转发（no-op） |
| `POST /api/v1/statuses/:id/unreblog` | 取消转发 |
| `GET /api/v1/statuses/:id/context` | 评论上下文 |
| `GET /api/v1/statuses/:id/favourited_by` | 点赞用户列表 |
| `GET /api/v1/statuses/:id/reblogged_by` | 空数组 |

#### Timelines

| 端点 | 说明 |
|------|------|
| `GET /api/v1/timelines/home` | 关注时间线 |
| `GET /api/v1/timelines/public` | 公共时间线 |
| `GET /api/v1/timelines/tag/:hashtag` | 标签时间线 |

所有时间线支持 `max_id`/`since_id`/`limit` 分页，返回 `Link` header。

#### Notifications

| 端点 | 说明 |
|------|------|
| `GET /api/v1/notifications` | 通知列表 |
| `GET /api/v1/notifications/:id` | 单条通知 |
| `POST /api/v1/notifications/clear` | 全部已读 |
| `GET /api/v1/notifications/unread_count` | 未读数 |

#### Media & Search

| 端点 | 说明 |
|------|------|
| `POST /api/v1/media` | 上传图片（代理到图床） |
| `GET /api/v1/search` | 搜索（用户 + 帖子 + 标签） |
| `GET /api/v2/search` | 搜索（v2） |

#### Stub 端点

以下端点返回空数组或默认值，确保 Moshidon 启动时不报错：

| 端点 | 返回 |
|------|------|
| `GET /api/v1/filters` | `[]` |
| `GET /api/v2/filters` | `[]` |
| `GET /api/v1/markers` | 默认标记 |
| `POST /api/v1/markers` | 默认标记 |
| `GET /api/v1/custom_emojis` | `[]` |
| `GET /api/v1/announcements` | `[]` |
| `GET /api/v1/lists` | `[]` |
| `GET /api/v1/preferences` | 默认偏好 |
| `GET /api/v1/instance/peers` | `[]` |
| `GET /api/v1/conversations` | `[]` |
| `GET /api/v1/favourites` | `[]` |
| `GET /api/v1/bookmarks` | `[]` |
| `GET /api/v1/follow_requests` | `[]` |
| `GET /api/v1/mutes` | `[]` |
| `GET /api/v1/blocks` | `[]` |

### 文件结构

```
src/mastodon/
├── shared.ts      # 共享逻辑（auth、instance、resolveStatus）
├── types.ts       # Mastodon 实体类型定义
├── converter.ts   # ABDL → Mastodon 数据模型转换
├── routes.ts      # /api/v1/* 端点
└── v2.ts          # /api/v2/* 端点
```

### 已知限制

- 无 Streaming API（`configuration.urls.streaming: null`，Moshidon 回退轮询）
- 无 Push 通知
- 无 ActivityPub 联邦（纯本地实例）
- reblog 为 no-op
- conversations 返回空数组

---

## 九、变更记录

| 日期 | 变更 |
|------|------|
| 2026-06-14 | 全面重写：补充所有新增 API（Follows、Messages、Reports、Checkin、Points、Badges、Invite、OAuth、NBW、Beta、Search、Sync、Key Split、Content API、Captcha V1 等）；修正 Ratings 为 5 维度（无 fit_score）；修正评分为贝叶斯加权；补充奖励系统、图片上传、转发、公告等功能 |
| 2026-06-15 | 新增 Mastodon 兼容 API 层（/api/v1/* + /api/v2/*），支持 Moshidon 等 Mastodon 客户端连接；Status ID 使用 p_/c_ 前缀格式；支持 OAuth + JWT 双模认证；实现 28+ 端点 + 15 个 stub 端点 |
