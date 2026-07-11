# Posts 论坛帖子

论坛帖子系统。包含帖子创建、查看、评论和点赞功能。

## 帖子与评论的关系

```
Post (帖子)
  ├── Comment (顶级评论)
  │     └── Comment (回复，通过 parent_id 关联)
  ├── Comment
  └── ...
```

评论仅支持一层嵌套（`parent_id` 非空表示回复）。

---

## GET /api/posts

帖子列表，支持搜索和分页。排序：置顶优先 → 时间降序。

- **鉴权**：无需（已登录时 `has_liked` 返回实际值）

**Query 参数：**

| 参数 | 类型 | 默认 | 说明 |
|:---|:---|:---|:---|
| `page` | int | 1 | |
| `limit` | int | 20 | ≤ 100 |
| `search` | string | — | 搜索 content |

**请求示例：**

```bash
curl "https://api.abdl-space.top/api/posts?page=1&limit=10"

# 搜索包含 "吸水量" 的帖子
curl "https://api.abdl-space.top/api/posts?search=吸水量"
```

**成功响应 200：**

```json
{
  "posts": [
    {
      "id": 1,
      "user": { "id": 1, "username": "ZhX", "avatar": null, "role": "admin" },
      "content": "今天试了 Little Kings，吸水量惊人！推荐给大家",
      "diaper_id": 1,
      "pinned": false,
      "like_count": 5,
      "has_liked": true,
      "comment_count": 3,
      "created_at": "2026-05-20T10:30:00.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 42, "totalPages": 3 }
}
```

---

## GET /api/posts/:id

帖子详情 + 所有评论。

- **鉴权**：无需

```bash
curl https://api.abdl-space.top/api/posts/1
```

**成功响应 200：**

```json
{
  "post": {
    "id": 1,
    "user": { "id": 1, "username": "ZhX", "avatar": null, "role": "admin" },
    "content": "今天试了 Little Kings，吸水量惊人！",
    "diaper_id": 1,
    "pinned": false,
    "like_count": 5,
    "has_liked": true,
    "comment_count": 3,
    "created_at": "2026-05-20T10:30:00.000Z"
  },
  "comments": [
    {
      "id": 1,
      "post_id": 1,
      "user": { "id": 2, "username": "userB", "avatar": null, "role": "user" },
      "parent_id": null,
      "content": "同感！我也用这款很久了",
      "like_count": 2,
      "has_liked": false,
      "created_at": "2026-05-20T11:00:00.000Z"
    },
    {
      "id": 2,
      "post_id": 1,
      "user": { "id": 3, "username": "userC", "avatar": null, "role": "user" },
      "parent_id": 1,
      "content": "我也觉得！尤其是 M 码很合身",
      "like_count": 0,
      "has_liked": false,
      "created_at": "2026-05-20T11:30:00.000Z"
    }
  ]
}
```

- `parent_id: null` = 顶级评论
- `parent_id: 1` = 回复 id=1 的评论
- 评论按时间升序排列

---

## POST /api/posts

发表新帖。

- **鉴权**：需要

**请求体：**

| 字段 | 类型 | 必填 | 约束 |
|:---|:---|:---|:---|
| `content` | string | 是 | 1–5000 字符，不能纯空格 |
| `diaper_id` | int | 否 | 关联纸尿裤 ID |

**请求示例：**

```bash
curl -X POST https://api.abdl-space.top/api/posts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "刚试了 XXX 的新款纸尿裤，感觉比旧版软了很多！",
    "diaper_id": 1
  }'
```

**成功响应 201：**

```json
{ "id": 42, "message": "发布成功" }
```

---

## POST /api/posts/:id/comments

在帖子下发表评论。

- **鉴权**：需要

**请求体：**

| 字段 | 类型 | 必填 | 约束 |
|:---|:---|:---|:---|
| `content` | string | 是 | 1–2000 字符 |
| `parent_id` | int | 否 | 回复的评论 ID（null = 顶级评论） |

```bash
curl -X POST https://api.abdl-space.top/api/posts/1/comments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "写得很详细，感谢分享！"}'

# 回复某条评论
curl -X POST https://api.abdl-space.top/api/posts/1/comments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "同意你的看法", "parent_id": 5}'
```

**成功响应 201：**

```json
{ "message": "评论成功", "id": 88 }
```

---

## DELETE /api/posts/:id

删除帖子（仅本人或管理员）。

```bash
curl -X DELETE https://api.abdl-space.top/api/posts/42 \
  -H "Authorization: Bearer $TOKEN"
```

---

## 点赞

见 [Likes API](./posts#点赞)。点赞通过 `POST /api/likes` 实现，target_type 为 `post` 或 `comment`。

```bash
# 点赞帖子
curl -X POST https://api.abdl-space.top/api/likes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"target_type": "post", "target_id": 1}'

# 点赞评论
curl -X POST https://api.abdl-space.top/api/likes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"target_type": "comment", "target_id": 5}'
```

响应：`{ "liked": true }`（点赞）或 `{ "liked": false }`（取消点赞）。同一用户对同一目标为 toggle 模式。
