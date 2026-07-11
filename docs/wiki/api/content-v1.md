# Content API v1

开放平台内容 API，供第三方应用通过 API Key 获取纸尿裤和排行榜数据。

---

## 鉴权方式

使用 API Key 鉴权（非 JWT）：

```
Authorization: Bearer <content_api_key>
```

---

## GET /api/v1/content/diapers

获取纸尿裤数据。

```bash
curl "https://api.abdl-space.top/api/v1/content/diapers?page=1&limit=20" \
  -H "Authorization: Bearer YOUR_CONTENT_API_KEY"
```

**Query 参数：**

| 参数 | 类型 | 默认 | 说明 |
|:---|:---|:---|:---|
| `page` | int | 1 | |
| `limit` | int | 20 | ≤ 100 |
| `search` | string | — | 搜索 brand + model |
| `sort` | string | `id` | `id` / `avg_score` / `rating_count` |
| `order` | string | `ASC` | |

**响应 200：**

```json
{
  "diapers": [
    {
      "id": 1,
      "brand": "ABU",
      "model": "Little Kings",
      "thickness": 4,
      "absorbency_adult": "7500ml",
      "avg_score": 8.5,
      "rating_count": 23
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 11, "totalPages": 1 }
}
```

---

## GET /api/v1/content/rankings

获取排行榜数据。

```bash
curl "https://api.abdl-space.top/api/v1/content/rankings?type=hot&limit=10" \
  -H "Authorization: Bearer YOUR_CONTENT_API_KEY"
```

参数和响应格式同 `/api/rankings`。

---

## GET /api/v1/content/posts

获取论坛帖子。

```bash
curl "https://api.abdl-space.top/api/v1/content/posts?page=1" \
  -H "Authorization: Bearer YOUR_CONTENT_API_KEY"
```

---

## API Key 管理

管理员接口 `GET/POST/DELETE /api/content/keys`。

```bash
# 创建 content API key
curl -X POST https://api.abdl-space.top/api/content/keys \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "Partner App", "permissions": ["read:diapers", "read:rankings"]}'

# 响应
{ "key": "ck_abc123...", "label": "Partner App", "created_at": "..." }
```

---

## 错误处理

| 状态码 | 含义 |
|:---|:---|
| 401 | API Key 无效或缺失 |
| 403 | API Key 权限不足 |
