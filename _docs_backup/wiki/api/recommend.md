# Recommend 推荐

AI 智能推荐（DeepSeek 驱动）和纯数据驱动的「猜你喜欢」。

---

## POST /api/recommend

AI 推荐。根据用户个人信息 + 纸尿裤数据库，使用 DeepSeek AI 模型生成个性化推荐。

- **鉴权**：需要
- **前提**：管理员已在后台配置 DeepSeek API Key

**请求体：**

```json
{
  "selected": {
    "basic": true,
    "body": true,
    "prefs": true,
    "bio": true,
    "feelings": true
  }
}
```

`selected` 控制用户授权哪些数据用于推荐：

| 字段 | 包含的数据 |
|:---|:---|
| `basic` | 年龄、地区 |
| `body` | 体重、腰围、臀围 |
| `prefs` | 风格偏好 (style_preference) |
| `bio` | 个人简介 (bio) |
| `feelings` | 历史使用感受 |

> 建议：客户端展示一个选择界面，让用户勾选愿意分享的数据类别。

**请求示例：**

```bash
curl -X POST https://api.abdl-space.top/api/recommend \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "selected": {
      "basic": true,
      "body": true,
      "prefs": true,
      "bio": false,
      "feelings": true
    }
  }'
```

**成功响应 200：**

```json
{
  "recommendations": [
    {
      "diaper_id": 1,
      "brand": "ABU",
      "model": "Little Kings",
      "reason": "根据你的体重（65kg）和腰围（75cm），M 码非常合适。你偏好日系风格，Little Kings 的日本印花设计正符合你的审美。而且它的柔软度评分 8.5，适合你喜欢的柔软舒适感。",
      "matchScore": 92
    },
    {
      "diaper_id": 3,
      "brand": "Rearz",
      "model": "Mermaid Tales",
      "reason": "超强吸水力 8000ml，适合长时间使用。…",
      "matchScore": 85
    }
  ],
  "summary": "根据你的体型、偏好和历史数据，为你推荐以上 3 款纸尿裤"
}
```

- 返回 3–5 条推荐
- `matchScore` 范围 1–100
- `reason` 由 AI 生成，说明推荐理由

**错误：**
- 503 — API Key 未配置
- 502 — DeepSeek 调用失败

---

## GET /api/recommend/guess

「猜你喜欢」——纯数据驱动，无需 AI。按综合评分取最高的 5 款，附带自动生成的理由标签。

- **鉴权**：无需

```bash
curl https://api.abdl-space.top/api/recommend/guess
```

**成功响应 200：**

```json
{
  "recommendations": [
    {
      "id": 3,
      "brand": "Rearz",
      "model": "Mermaid Tales",
      "avg_score": 9.2,
      "rating_count": 15,
      "thickness": 5,
      "reason": "综合评分超高，社区力荐"
    },
    {
      "id": 5,
      "brand": "Tykables",
      "model": "Galactic",
      "avg_score": 8.9,
      "rating_count": 10,
      "thickness": 2,
      "reason": "超薄设计，适合日常穿着"
    },
    {
      "id": 1,
      "brand": "ABU",
      "model": "Little Kings",
      "avg_score": 8.5,
      "rating_count": 23,
      "thickness": 4,
      "reason": "热门之选"
    }
  ]
}
```

**理由生成规则：**

| 条件 | 标签 |
|:---|:---|
| `avg_score` ≥ 8.0 | "综合评分超高，社区力荐" |
| `thickness` ≤ 2 | "超薄设计，适合日常穿着" |
| 其他 | "热门之选" |

---

## 使用场景对比

| 场景 | 接口 | 适用情况 |
|:---|:---|:---|
| 新用户（无历史数据） | `GET /recommend/guess` | 快速展示热门推荐 |
| 已登录、有个人信息 | `POST /recommend` | 个性化 AI 推荐 |
| 首页默认推荐 | `GET /recommend/guess` | 无需认证，加载快 |
