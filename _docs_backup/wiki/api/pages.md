# Wiki Pages 百科页面

Wiki 百科页面系统。支持页面 CRUD、版本历史、回滚、段落评论（段评）。

---

## 端点总览

| 方法 | 路径 | 说明 | 鉴权 |
|:---|:---|:---|:---|
| GET | `/api/pages` | Wiki 列表 | 无 |
| GET | `/api/pages/:slug` | 页面详情 | 无 |
| POST | `/api/pages` | 创建 Wiki | 是 |
| PUT | `/api/pages/:slug` | 编辑 Wiki | 是 |
| DELETE | `/api/pages/:slug` | 删除 Wiki | 是 |
| GET | `/api/pages/:slug/versions` | 版本历史 | 无 |
| GET | `/api/pages/:slug/versions/:v` | 版本详情 | 无 |
| POST | `/api/pages/:slug/rollback/:v` | 回滚到某版本 | 是 |
| GET | `/api/pages/:slug/inline-comments` | 段评列表 | 无 |
| POST | `/api/pages/:slug/inline-comments` | 发表段评 | 是 |
| DELETE | `/api/pages/:slug/inline-comments/:id` | 删除段评 | 是 |

---

## GET /api/pages

Wiki 页面列表。支持按关联纸尿裤筛选。

- **鉴权**：无需

**Query 参数：**

| 参数 | 类型 | 说明 |
|:---|:---|:---|
| `diaper_id` | int | 筛选关联特定纸尿裤的 Wiki |
| `page` | int | 默认 1 |
| `limit` | int | 默认 20 |

```bash
curl "https://api.abdl-space.top/api/pages?diaper_id=1"
```

**响应 200：**

```json
{
  "pages": [
    {
      "id": 1,
      "slug": "little-kings",
      "title": "Little Kings",
      "diaper_id": 1,
      "version": 3,
      "is_published": 1,
      "author_id": 1,
      "created_at": "2026-05-20T10:00:00.000Z",
      "updated_at": "2026-05-20T14:00:00.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 5, "totalPages": 1 }
}
```

---

## GET /api/pages/:slug

Wiki 页面详情（含 Markdown 正文）。

```bash
curl https://api.abdl-space.top/api/pages/little-kings
```

**响应 200：**

```json
{
  "id": 1,
  "slug": "little-kings",
  "title": "Little Kings",
  "content": "# Little Kings\n\nABU 的旗舰产品，日本风格印花…\n\n## 特点\n\n- 高吸水性 SAP 芯体\n- 布感面料\n- 四钩环魔术贴\n\n## 尺码\n\n| 尺码 | 腰围 | 臀围 |\n|:---|:---|:---|\n| M | 79-92cm | 95-110cm |\n| L | 90-105cm | 105-120cm |",
  "diaper_id": 1,
  "version": 3,
  "is_published": 1,
  "author_id": 1,
  "created_at": "2026-05-20T10:00:00.000Z",
  "updated_at": "2026-05-20T14:00:00.000Z"
}
```

---

## POST /api/pages

创建 Wiki 页面。

- **鉴权**：需要

**请求体：**

| 字段 | 类型 | 必填 | 约束 |
|:---|:---|:---|:---|
| `slug` | string | 是 | URL 友好标识，全局唯一 |
| `title` | string | 是 | |
| `content` | string | 是 | Markdown 格式 |
| `diaper_id` | int | 否 | 关联纸尿裤 ID |

```bash
curl -X POST https://api.abdl-space.top/api/pages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "my-first-page",
    "title": "我的第一篇 Wiki",
    "content": "# Hello World\n\n这是一篇 Wiki 页面。支持 **Markdown** 语法。",
    "diaper_id": null
  }'
```

**成功响应 201：**

```json
{ "id": 10, "slug": "my-first-page", "message": "创建成功" }
```

**错误：**
- 409 — slug 已存在
- 400 — diaper_id 已绑定其他 Wiki

---

## PUT /api/pages/:slug

编辑 Wiki 页面。每次编辑自动创建新版本。

```bash
curl -X PUT https://api.abdl-space.top/api/pages/my-first-page \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "更新后的标题",
    "content": "# 更新后的内容\n\n这是版本 2。"
  }'
```

**成功响应 200：**

```json
{ "message": "更新成功", "version": 2 }
```

所有字段可选，未传的保持不变。每次更新 `version` 自增。

---

## GET /api/pages/:slug/versions

查看版本历史。

```bash
curl https://api.abdl-space.top/api/pages/little-kings/versions
```

**响应 200：**

```json
{
  "versions": [
    {
      "id": 10,
      "version": 3,
      "content": "# Little Kings\n\n...(version 3 content)...",
      "author": { "id": 1, "username": "ZhX", "avatar": null },
      "created_at": "2026-05-20T14:00:00.000Z"
    },
    {
      "id": 9,
      "version": 2,
      "content": "# Little Kings\n\n...(version 2 content)...",
      "author": { "id": 2, "username": "userB", "avatar": null },
      "created_at": "2026-05-20T12:00:00.000Z"
    }
  ]
}
```

---

## GET /api/pages/:slug/versions/:version

查看特定版本的完整内容。

```bash
curl https://api.abdl-space.top/api/pages/little-kings/versions/2
```

---

## POST /api/pages/:slug/rollback/:version

回滚到某个历史版本。实际上创建新版本，内容替换为旧版本内容。

```bash
curl -X POST https://api.abdl-space.top/api/pages/little-kings/rollback/2 \
  -H "Authorization: Bearer $TOKEN"
```

**响应 200：**

```json
{ "message": "已回滚", "version": 4 }
```

---

## 段评（Inline Comments）

段评是段落级别的评论，类似 oi-wiki 风格。每条评论关联一个 Wiki 页面的特定段落，通过 `paragraph_hash` 定位。

> `paragraph_hash` 由前端根据段落内容计算（如取前 50 字符 + 长度做 hash）。

### GET /api/pages/:slug/inline-comments

获取段评列表。

```bash
# 全部段评
curl https://api.abdl-space.top/api/pages/little-kings/inline-comments

# 筛选某段落的评论
curl "https://api.abdl-space.top/api/pages/little-kings/inline-comments?paragraph_hash=abc123"
```

**响应 200：**

```json
{
  "comments": [
    {
      "id": 1,
      "paragraph_hash": "abc123",
      "author": { "id": 1, "username": "ZhX", "avatar": null },
      "content": "这一段写得不错，但可以补充尺码表",
      "created_at": "2026-05-20T10:30:00.000Z"
    }
  ]
}
```

### POST /api/pages/:slug/inline-comments

发表段评。

```bash
curl -X POST https://api.abdl-space.top/api/pages/little-kings/inline-comments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paragraph_hash": "abc123", "content": "这里可能需要更新一下数据"}'
```

**响应 201：**

```json
{ "id": 5, "message": "评论成功" }
```

| 字段 | 说明 |
|:---|:---|
| `paragraph_hash` | 段落定位标识 |
| `content` | 1–1000 字符 |

### DELETE /api/pages/:slug/inline-comments/:id

删除段评（仅作者或管理员）。

```bash
curl -X DELETE https://api.abdl-space.top/api/pages/little-kings/inline-comments/5 \
  -H "Authorization: Bearer $TOKEN"
```
