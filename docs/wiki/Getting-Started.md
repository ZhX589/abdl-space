# 入门指南

从零开始使用 ABDL Space API。

---

## 1. 获取 Token

### 注册

```bash
curl -X POST https://api.abdl-space.top/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alice@example.com",
    "password": "mysecret123",
    "username": "alice"
  }'
```

成功响应（201）：

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": 42,
    "email": "alice@example.com",
    "username": "alice",
    "avatar": null,
    "role": "user"
  }
}
```

约束：
- `email` 合法邮箱，全局唯一
- `password` 至少 8 个字符
- `username` 3–30 字符，全局唯一

### 登录

支持用 **email** 或 **username** 登录，统一使用 `login` 字段：

```bash
# 用 username 登录
curl -X POST https://api.abdl-space.top/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"login": "alice", "password": "mysecret123"}'

# 用 email 登录也一样
curl -X POST https://api.abdl-space.top/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"login": "alice@example.com", "password": "mysecret123"}'
```

成功响应（200）格式与注册相同，返回 `token` + `user`。

---

## 2. 携带 Token 请求

在所有需要鉴权的接口中，设置 `Authorization` 头：

```bash
TOKEN="eyJhbGciOiJIUzI1NiIs..."

# 获取自己的完整信息
curl https://api.abdl-space.top/api/auth/me \
  -H "Authorization: Bearer $TOKEN"

# 提交评分
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
    "value_score": 8
  }'
```

---

## 3. 获取自己的资料

```bash
curl https://api.abdl-space.top/api/auth/me \
  -H "Authorization: Bearer $TOKEN"
```

响应：

```json
{
  "id": 42,
  "email": "alice@example.com",
  "username": "alice",
  "role": "user",
  "avatar": null,
  "age": null,
  "region": null,
  "weight": null,
  "waist": null,
  "hip": null,
  "style_preference": null,
  "bio": null,
  "email_verified": 0,
  "created_at": "2026-05-20T10:30:00.000Z"
}
```

### 更新自己的身体数据（用于推荐）

```bash
curl -X PATCH https://api.abdl-space.top/api/users/me \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "age": 25,
    "region": "北京",
    "weight": 65.5,
    "waist": 75.0,
    "hip": 95.0,
    "style_preference": "日系",
    "bio": "喜欢柔软舒适的纸尿裤"
  }'
```

所有字段可选，未传的不作修改。

---

## 4. 第一个完整示例

注册 → 获取 Token → 查询纸尿裤 → 提交评分：

```bash
#!/bin/bash
BASE="https://api.abdl-space.top"

# 1. 注册
RESP=$(curl -s -X POST "$BASE/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"bob@test.com","password":"pass1234","username":"bob"}')
TOKEN=$(echo $RESP | grep -o '"token":"[^"]*' | cut -d'"' -f4)
echo "Token: ${TOKEN:0:30}..."

# 2. 查询评分最高的 5 款纸尿裤
curl -s "$BASE/api/diapers?sort=avg_score&order=DESC&limit=5" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# 3. 给 id=1 的纸尿裤评分
curl -s -X POST "$BASE/api/ratings" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "diaper_id": 1,
    "absorption_score": 9,
    "fit_score": 8,
    "comfort_score": 9,
    "thickness_score": 7,
    "appearance_score": 10,
    "value_score": 8
  }'
```

---

## 5. Token 过期处理

JWT Token 默认有效期为 **7 天**。过期后返回 401，需要重新登录。

```bash
# 检测 Token 是否有效
curl -s -o /dev/null -w "%{http_code}" \
  "$BASE/api/auth/me" \
  -H "Authorization: Bearer $TOKEN"
# 返回 200 = 有效，401 = 需重新登录
```

前端建议：
- 将 Token 存储在 `localStorage` 或 `httpOnly` Cookie 中
- 在 401 响应时自动跳转登录页
- 页面加载时检查 Token 有效性

---

## 下一步

- 查看 [Auth API](./api/auth) 了解完整的认证接口
- 查看 [Diapers API](./api/diapers) 了解纸尿裤数据查询
- 查看 [Ratings API](./api/ratings) 了解评分提交
