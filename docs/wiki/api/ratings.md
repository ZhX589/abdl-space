# Ratings 评分

6 维度 1–10 分制的纸尿裤评分系统。每人每款只能评一次。

---

## POST /api/ratings

为纸尿裤提交评分（6 维度 + 可选文字评价）。

- **鉴权**：需要
- **限制**：每人每款只能评一次（409 重复）

**请求体：**

| 字段 | 类型 | 必填 | 约束 |
|:---|:---|:---|:---|
| `diaper_id` | int | 是 | 必须存在 |
| `absorption_score` | int | 是 | 1–10 |
| `fit_score` | int | 是 | 1–10 |
| `comfort_score` | int | 是 | 1–10 |
| `thickness_score` | int | 是 | 1–10 |
| `appearance_score` | int | 是 | 1–10 |
| `value_score` | int | 是 | 1–10 |
| `review` | string | 否 | 最长 500 字符 |

**请求示例：**

```bash
curl -X POST https://api.abdl-space.top/api/ratings \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "diaper_id": 1,
    "absorption_score": 9,
    "fit_score": 8,
    "comfort_score": 9,
    "thickness_score": 7,
    "appearance_score": 10,
    "value_score": 8,
    "review": "吸水性极好，穿着也很舒服，印花很可爱！"
  }'
```

**成功响应 200：**

```json
{
  "message": "评分成功",
  "review_status": "approved",
  "id": 101
}
```

**错误响应：**

```json
{ "error": "score 必须在 1-10 之间" }
```

```json
{ "error": "你已经给这款纸尿裤评过分了" }
```

```json
{ "error": "纸尿裤不存在" }
```

---

## GET /api/diapers/:id/ratings

获取某纸尿裤的所有评分 + 分维度统计。

- **鉴权**：无需

**请求示例：**

```bash
curl https://api.abdl-space.top/api/diapers/1/ratings
```

**成功响应 200：**

```json
{
  "reviews": [
    {
      "id": 101,
      "user": { "id": 1, "username": "ZhX", "avatar": null },
      "diaper_id": 1,
      "absorption_score": 9,
      "fit_score": 8,
      "comfort_score": 9,
      "thickness_score": 7,
      "appearance_score": 10,
      "value_score": 8,
      "review": "非常舒服，吸水量惊人！",
      "review_status": "approved",
      "created_at": "2026-05-20T10:30:00.000Z"
    }
  ],
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

- `composite` = 6 维度 `avg` 的均值，保留 1 位小数
- `reviews` 按时间降序

---

## GET /api/ratings/me/:diaperId

查询当前用户对某款纸尿裤的评分（用于判断是否已评）。

- **鉴权**：需要

```bash
curl https://api.abdl-space.top/api/ratings/me/1 \
  -H "Authorization: Bearer $TOKEN"
```

**响应 200（已评）：**

```json
{
  "rating": {
    "id": 101,
    "diaper_id": 1,
    "absorption_score": 9,
    "fit_score": 8,
    "comfort_score": 9,
    "thickness_score": 7,
    "appearance_score": 10,
    "value_score": 8,
    "review": "非常舒服",
    "created_at": "2026-05-20T10:30:00.000Z"
  }
}
```

**响应 200（未评）：**

```json
{ "rating": null }
```

---

## DELETE /api/ratings/:id

删除自己的评分（或管理员删任意评分）。

- **鉴权**：需要（仅本人或管理员）
- **403**：非本人且非管理员

```bash
curl -X DELETE https://api.abdl-space.top/api/ratings/101 \
  -H "Authorization: Bearer $TOKEN"
```

**成功响应 200：**

```json
{ "message": "删除成功" }
```
