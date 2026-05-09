# ABDL Space — API 规格文档

> 本文档是 B 站点（API 后端 + Wiki 前端）的权威 API 参考。A 站点（评分主站）据此对接。

## 一、概述

### 两站协作关系

| | A 站点（主站） | B 站点（本站） |
|--|---------------|---------------|
| 定位 | 评分/评论平台，纯前端 | API 后端 + Wiki 前端 |
| 职责 | 展示评分、纸尿裤、论坛 | 数据存储 + 所有 API + Wiki 页面 |
| 账号 | 共享同一套用户系统（JWT） | 用户注册/登录/鉴权 |

### Base URL

```
生产: https://api.abdl.space
本地: http://localhost:8788
```

---

## 二、认证与鉴权

### JWT Bearer Token

所有需鉴权接口在请求头携带：

```
Authorization: Bearer <token>
```

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

**绝不返回** `password_hash`、`email`、`weight`、`waist`、`hip` 等敏感字段，除非是用户查看自己的资料（`/api/auth/me`、`/api/users/me`）。

---

## 四、数据库 Schema

完整 SQL 见 [`schemas/schema.sql`](./schemas/schema.sql)。共 14 张表：

### 表关系概览

```
users ─┬─ ratings (1:N, by user_id)
       ├─ feelings (1:N, by user_id)
       ├─ posts (1:N, by user_id)
       ├─ likes (1:N, by user_id)
       ├─ experience (1:1, by user_id)
       ├─ notifications (1:N, by user_id)
       └─ wiki_inline_comments (1:N, by author_id)

diapers ─┬─ diaper_sizes (1:N, CASCADE)
         ├─ ratings (1:N, by diaper_id)
         ├─ feelings (1:N, by diaper_id)
         ├─ posts (1:N, optional by diaper_id)
         └─ wiki_pages (1:1, optional by diaper_id)

posts ──── post_comments (1:N, CASCADE)
         ──── likes (by target_type='post')

post_comments ──── likes (by target_type='comment')

wiki_pages ─┬─ page_versions (1:N, CASCADE)
            └─ wiki_inline_comments (1:N, CASCADE)

terms (独立表)
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

#### POST /api/auth/register

注册新用户，返回 JWT。

- **鉴权**：否
- **请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| email | string | 是 | 合法邮箱格式，全局唯一 |
| password | string | 是 | ≥8 字符 |
| username | string | 是 | 3–30 字符，全局唯一 |

- **响应 201**：
```json
{
  "token": "eyJ...",
  "user": { "id": 1, "email": "...", "username": "...", "avatar": null, "role": "user" }
}
```
- **错误**：400（参数不合法）、409（email 或 username 已存在）

#### POST /api/auth/login

登录，支持 email 或 username。

- **鉴权**：否
- **请求 body**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| login | string | 是 | email 或 username |
| password | string | 是 | |

- **响应 200**：同 register 响应格式
- **错误**：401（账号或密码错误）

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
  "email_verified": 0, "created_at": "..."
}
```

---

### 5.2 Diapers（纸尿裤）

#### GET /api/diapers

纸尿裤列表，支持筛选/排序/分页。每条附带实时计算的综合评分。

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
      "sizes": [
        { "label": "M", "waist_min": 79, "waist_max": 92, "hip_min": 95, "hip_max": 110 }
      ],
      "avg_score": 8.5, "rating_count": 23, "feeling_count": 5
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 11, "totalPages": 1 }
}
```

`avg_score` 计算规则见 [第六节](#六综合评分计算规则)。

- **错误**：400（sort/order/page/limit 不合法）

#### GET /api/diapers/:id

纸尿裤详情，含评分记录 + Wiki。

- **鉴权**：否
- **响应 200**：
```json
{
  "diaper": { /* 同列表中单条结构 */ },
  "reviews": [
    {
      "id": 101, "user": { "id": 1, "username": "ZhX", "avatar": "..." },
      "diaper_id": 1,
      "absorption_score": 9, "fit_score": 8, "comfort_score": 9,
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
- `wiki.category` 由 `product_type + '/' + brand` 动态拼接；无 Wiki 时 `wiki` 为 `null`
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
        "fit_score": { "avg": 7.8 },
        "comfort_score": { "avg": 8.5 },
        "thickness_score": { "avg": 7.0 },
        "appearance_score": { "avg": 8.9 },
        "value_score": { "avg": 7.6 }
      },
      "avg_score": 8.5, "rating_count": 23
    }
  ]
}
```

---

### 5.3 Ratings（评分）

#### POST /api/ratings

为纸尿裤评分（6 维度 + 文字评价）。

- **鉴权**：是
- **请求 body**：

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| diaper_id | integer | 是 | 必须存在 |
| absorption_score | integer | 是 | 1–10 |
| fit_score | integer | 是 | 1–10 |
| comfort_score | integer | 是 | 1–10 |
| thickness_score | integer | 是 | 1–10 |
| appearance_score | integer | 是 | 1–10 |
| value_score | integer | 是 | 1–10 |
| review | string | 否 | 最长 500 字符 |

- **响应 200**：`{ "message": "评分成功", "review_status": "approved", "id": 101 }`
- **错误**：400（score 不在 1–10 / review 超限）、404（diaper 不存在）、409（已评过）

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
      "fit_score": { "avg": 7.8, "count": 23 },
      "comfort_score": { "avg": 8.5, "count": 23 },
      "thickness_score": { "avg": 7.0, "count": 23 },
      "appearance_score": { "avg": 8.9, "count": 23 },
      "value_score": { "avg": 7.6, "count": 23 }
    }
  }
}
```

`composite` = 6 个维度 avg 的均值，保留 1 位小数。`reviews` 按 `created_at` 降序。

#### GET /api/ratings/me/:diaperId

当前用户对某纸尿裤的评分。

- **鉴权**：是
- **响应 200**：`{ "rating": { /* 评分对象 */ } }` 或 `{ "rating": null }`

#### DELETE /api/ratings/:id

删除评分。

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
- **错误**：409（同一用户+diaper+size 已存在）

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
      "diaper_id": 1, "pinned": false,
      "like_count": 5, "has_liked": true,
      "comment_count": 3, "created_at": "..."
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 42, "totalPages": 3 }
}
```

排序：置顶优先 → `created_at` 降序。

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
      "like_count": 0, "has_liked": false, "created_at": "..."
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

- **响应 201**：`{ "id": 1, "message": "发布成功" }`
- **错误**：400（content 为空或超限）

#### DELETE /api/posts/:id

删除帖子。

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

- **响应 201**：`{ "message": "评论成功", "id": 1 }`
- **错误**：404（帖子不存在）、400（content 空/超限/parent_id 不合法）

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
- **错误**：400（target_type 不合法）、404（target 不存在）

---

### 5.8 Rankings（排行榜）

#### GET /api/rankings

- **鉴权**：否
- **请求 query**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| type | string | 是 | `hot` / `absorbency` / `popular` / `dimension` |
| dimension | string | 否 | type=dimension 时必填：`absorption_score` / `fit_score` / `comfort_score` / `thickness_score` / `appearance_score` / `value_score` |
| limit | integer | 否 | 默认 20，最大 50 |

- **排序规则**：
  - `hot`：按 avg_score 降序
  - `absorbency`：按 absorbency_adult 提取 mL 数值降序
  - `popular`：按 rating_count 降序
  - `dimension`：按指定维度所有评分均值降序

- **响应 200**：
```json
{
  "rankings": [
    {
      "id": 1, "brand": "ABU", "model": "Little Kings",
      "avg_score": 8.5, "rating_count": 23,
      "thickness": 4, "absorbency_adult": "7500ml"
    }
  ],
  "type": "hot"
}
```

- **错误**：400（type 不合法 / dimension 缺失）

---

### 5.9 Wiki Pages（Wiki 页面）

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
| diaper_id | integer | 否 | 关联纸尿裤 id（设则自动生成 slug 的参考）|

- **响应 201**：`{ "id": 1, "slug": "little-kings", "message": "创建成功" }`
- **错误**：409（slug 已存在）、400（diaper_id 已绑定其他 Wiki）

#### PUT /api/pages/:slug

编辑 Wiki 页面。

- **鉴权**：是
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

### 5.10 Wiki Inline Comments（Wiki 段评）

段评是段落级评论，类似 oi-wiki 风格。每条评论关联一个 Wiki 页面的具体段落。

`paragraph_hash` 由前端根据段落文本内容计算（如取前 50 字符 + 段落长度做简单 hash），用于定位段落。

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

### 5.11 Users & Experience（用户与等级）

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
    "created_at": "..."
  }
}
```

不返回 weight/waist/hip/email。

#### PATCH /api/users/me

修改当前用户信息。

- **鉴权**：是
- **请求 body**（所有字段可选，未传不修改）：

| 字段 | 类型 | 约束 |
|------|------|------|
| avatar | string/null | URL, ≤2048 |
| age | integer/null | 1–150 |
| region | string/null | ≤50 |
| weight | number/null | kg, >0, ≤500, 1 位小数 |
| waist | number/null | cm, >0, ≤300, 1 位小数 |
| hip | number/null | cm, >0, ≤300, 1 位小数 |
| style_preference | string/null | ≤100 |
| bio | string/null | ≤500 |

- **响应 200**：`{ "user": { /* 完整用户对象，无 password_hash */ } }`

#### GET /api/users/:id/level

用户等级/经验值。

- **鉴权**：否
- **经验值获取**：

| 行为 | 经验值 |
|------|-------|
| 发表评分 | +10 |
| 发表感受 | +5 |
| 发表帖子 | +15 |
| 发表评论 | +3 |
| 被点赞 | +1（每条最多 1 次）|

- **等级表**：

| 等级 | 累计经验 | 徽章 | 图标 |
|------|---------|------|------|
| 1 | 0 | 婴儿奶瓶 | 🍼 |
| 2 | 100 | 安抚奶嘴 | 👶 |
| 3 | 300 | 婴儿围兜 | 🧣 |
| 4 | 600 | 毛绒玩偶 | 🧸 |
| 5 | 1000 | 学步车 | 🦽 |
| 6 | 1500 | 小童床 | 🛏️ |
| 7 | 2100 | 儿童王座 | 👑 |

- **响应 200**：
```json
{
  "level": {
    "level": 2, "exp": 150, "total_exp": 150,
    "badge_name": "安抚奶嘴", "badge_icon": "👶",
    "next_level": 3, "next_exp_required": 300,
    "progress": 50
  }
}
```

`progress = (exp / next_exp_required) × 100`，取整。

#### GET /api/users/:id/posts

用户发的帖子。

- **鉴权**：否
- **响应**：同 `GET /api/posts` 格式

#### GET /api/users/:id/ratings

用户的评分记录。

- **鉴权**：否
- **响应**：`{ "reviews": [ /* ... */ ] }`

#### GET /api/users/:id/feelings

用户的感受记录。

- **鉴权**：否
- **响应**：`{ "feelings": [ /* ... */ ] }`

---

### 5.12 Terms（术语百科）

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

### 5.13 Recommend（推荐）

#### POST /api/recommend

AI 推荐，根据用户信息 + 纸尿裤数据库返回推荐。

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
  "summary": "根据您的数据，推荐以上 4 款"
}
```

3–5 条推荐，matchScore 1–100。

#### GET /api/recommend/guess

"猜你喜欢"，纯数据驱动（不需要 AI）。

- **鉴权**：否
- **规则**：取 avg_score 最高的 5 款，附推荐理由
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

### 5.14 Notifications（通知）

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

触发事件：帖子被赞(`like`)、帖子被评论(`comment`)、评论被回复(`reply`)

#### POST /api/notifications/read-all

全部标记已读。

- **鉴权**：是
- **响应 200**：`{ "message": "已全部标为已读" }`

---

### 5.15 Admin（管理后台）

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

删除用户。

#### POST /api/admin/users/:id/ban

封禁/解封（toggle）。

- **响应 200**：`{ "banned": true }`

> 注：ban 功能需在 users 表加 `banned` 字段，暂为 P2 预留。

#### POST /api/admin/posts/:id/pin

置顶/取消置顶（toggle）。

- **响应 200**：`{ "pinned": true }`

#### DELETE /api/admin/posts/:id

删除帖子。

#### DELETE /api/admin/comments/:id

删除评论。

#### DELETE /api/admin/diapers/:id

删除纸尿裤。

---

## 六、综合评分计算规则

`avg_score` 出现在纸尿裤列表、详情、排行榜中，实时计算：

### 公式

```
IF feeling_count > 0:
  avg_score = round(rating_avg × 0.9 + feeling_avg × 0.1, 1)
ELSE:
  avg_score = round(rating_avg, 1)
```

### rating_avg

该纸尿裤所有 ratings 记录的 6 维度平均值的均值，范围 0–10。

等价 SQL 逻辑：
```sql
SELECT AVG(
  (absorption_score + fit_score + comfort_score + thickness_score + appearance_score + value_score) / 6.0
) FROM ratings WHERE diaper_id = ?
```

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

> **注意**：原 spec 中 feelings 维度定义为 NOT NULL，但计算中提到"null 跳过"。当前实现按 NOT NULL 处理。如需支持部分填写，需改为 nullable 并调整计算逻辑。

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

## 八、与原始 Spec 的差异

以下是我们实现与 [原始 API Spec](https://github.com/ZYongX09/abdl/blob/master/API-SPEC.md) 的差异，A 站点对接时需注意：

| 项目 | 原始 Spec | 我们的实现 | 原因 |
|------|----------|----------|------|
| 登录字段 | `email` + `password` | `login`(email 或 username) + `password` | 需支持 username 登录 |
| users 表 | 无 email 字段 | 保留 email | 邮箱验证、密码找回必需 |
| users.avatar_url | 字段名 `avatar_url` | 字段名 `avatar` | 简化，与 spec 统一 |
| comments 表 | 统一 comments | 拆为 `post_comments`(论坛) + `wiki_inline_comments`(段评) | 两种评论交互模式不同 |
| wiki_pages | 独立 diaper_wiki 表 | wiki_pages 加可选 `diaper_id` | 通用 Wiki + 纸尿裤 Wiki 复用一张表 |
| page_versions | 不存在 | 保留 | ROADMAP v0.6.0 规划版本回滚 |
| wiki 内嵌 | diaper detail 中 wiki.category | 动态拼接 `product_type + '/' + brand` | 减少数据冗余 |
