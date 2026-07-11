# Users 用户

用户公开资料查看 + 个人信息修改 + 等级系统。

---

## GET /api/users/:id

查看用户公开信息。

- **鉴权**：无需

```bash
curl https://api.abdl-space.top/api/users/1
```

**响应 200：**

```json
{
  "user": {
    "id": 1,
    "username": "ZhX",
    "role": "admin",
    "avatar": null,
    "age": 25,
    "region": "北京",
    "style_preference": "日系",
    "bio": "纸尿裤爱好者",
    "created_at": "2026-05-10T08:00:00.000Z"
  }
}
```

> 不返回 `email`、`password_hash`、`weight`、`waist`、`hip`。

---

## PATCH /api/users/me

修改当前用户信息。

- **鉴权**：需要

**请求体（所有字段可选）：**

| 字段 | 类型 | 约束 |
|:---|:---|:---|
| `avatar` | string / null | URL，≤ 2048 |
| `age` | int / null | 1–150 |
| `region` | string / null | ≤ 50 |
| `weight` | float / null | > 0，≤ 500，1 位小数 |
| `waist` | float / null | > 0，≤ 300，1 位小数 |
| `hip` | float / null | > 0，≤ 300，1 位小数 |
| `style_preference` | string / null | ≤ 100 |
| `bio` | string / null | ≤ 500 |

```bash
curl -X PATCH https://api.abdl-space.top/api/users/me \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "age": 26,
    "weight": 66.0,
    "bio": "纸尿裤测评达人"
  }'
```

**响应 200：**

```json
{ "user": { /* 完整用户对象，无 password_hash */ } }
```

---

## GET /api/users/:id/level

获取用户等级/经验值。

- **鉴权**：无需

```bash
curl https://api.abdl-space.top/api/users/1/level
```

**响应 200：**

```json
{
  "level": {
    "level": 2,
    "exp": 150,
    "total_exp": 150,
    "badge_name": "安抚奶嘴",
    "badge_icon": "👶",
    "next_level": 3,
    "next_exp_required": 300,
    "progress": 50
  }
}
```

**经验获取规则：**

| 行为 | 经验 |
|:---|:---|
| 发表评分 | +10 |
| 发表感受 | +5 |
| 发表帖子 | +15 |
| 发表评论 | +3 |
| 被点赞 | +1（每条最多 1 次）|

**等级表：**

| 等级 | 累计经验 | 徽章 | 图标 |
|:---|:---|:---|:---|
| 1 | 0 | 婴儿奶瓶 | 🍼 |
| 2 | 100 | 安抚奶嘴 | 👶 |
| 3 | 300 | 婴儿围兜 | 🧣 |
| 4 | 600 | 毛绒玩偶 | 🧸 |
| 5 | 1000 | 学步车 | 🦽 |
| 6 | 1500 | 小童床 | 🛏️ |
| 7 | 2100 | 儿童王座 | 👑 |

---

## GET /api/users/:id/posts

用户的帖子列表。返回格式同 `GET /api/posts`。

```bash
curl https://api.abdl-space.top/api/users/1/posts
```

---

## GET /api/users/:id/ratings

用户的评分记录。

```bash
curl https://api.abdl-space.top/api/users/1/ratings
```

**响应 200：**

```json
{ "reviews": [ /* ... */ ] }
```

---

## GET /api/users/:id/feelings

用户的感受记录。

```bash
curl https://api.abdl-space.top/api/users/1/feelings
```

**响应 200：**

```json
{ "feelings": [ /* ... */ ] }
```
