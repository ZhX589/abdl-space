# Auth 认证

用户注册、登录与身份验证。

---

## POST /api/auth/register

注册新用户，成功后返回 JWT Token。

- **鉴权**：无需

**请求体：**

| 字段 | 类型 | 必填 | 约束 |
|:---|:---|:---|:---|
| `email` | string | 是 | 合法邮箱格式，全局唯一 |
| `password` | string | 是 | ≥ 8 字符 |
| `username` | string | 是 | 3–30 字符，全局唯一 |

**请求示例：**

```bash
curl -X POST https://api.abdl-space.top/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "newuser@example.com",
    "password": "securepass123",
    "username": "newuser"
  }'
```

**成功响应 201：**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 42,
    "email": "newuser@example.com",
    "username": "newuser",
    "avatar": null,
    "role": "user"
  }
}
```

**错误响应：**

```json
{ "error": "邮箱已注册" }
```

```json
{ "error": "用户名已存在" }
```

---

## POST /api/auth/login

登录。`login` 字段同时支持 **email** 和 **username**，后端自动判断。

- **鉴权**：无需

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|:---|:---|:---|:---|
| `login` | string | 是 | email 或 username |
| `password` | string | 是 | |

**请求示例：**

```bash
# 用 username 登录
curl -X POST https://api.abdl-space.top/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"login": "newuser", "password": "securepass123"}'

# 用 email 登录（效果相同）
curl -X POST https://api.abdl-space.top/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"login": "newuser@example.com", "password": "securepass123"}'
```

**成功响应 200：**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 42,
    "email": "newuser@example.com",
    "username": "newuser",
    "avatar": null,
    "role": "user"
  }
}
```

**错误响应 401：**

```json
{ "error": "用户名或密码错误" }
```

---

## GET /api/auth/me

获取当前登录用户的完整信息（含身体数据、邮箱等私密字段）。2026-10-04源码新增boolean `is_super_admin`，仅当前id1/admin/未封禁为true；role继续admin/user，字段不是JWT授权声明。响应private/no-store；旧token每请求刷新当前角色，封禁/删除/过期会话拒绝。该新增后端功能未部署。

- **鉴权**：需要

**请求示例：**

```bash
curl https://api.abdl-space.top/api/auth/me \
  -H "Authorization: Bearer $TOKEN"
```

**成功响应 200：**

```json
{
  "id": 42,
  "email": "newuser@example.com",
  "username": "newuser",
  "role": "user",
  "is_super_admin": false,
  "avatar": null,
  "age": 25,
  "region": "北京",
  "weight": 65.5,
  "waist": 75.0,
  "hip": 95.0,
  "style_preference": "日系",
  "bio": "喜欢柔软的纸尿裤",
  "email_verified": 0,
  "created_at": "2026-05-20T10:30:00.000Z"
}
```

**错误响应 401：**

```json
{ "error": "未登录" }
```

> 此接口返回完整的 `email` 和个人身体数据。其他公开接口中用户信息仅含 `id`/`username`/`avatar`。

---

## 鉴权方式总结

```
Authorization: Bearer <token>
```

| 接口 | 鉴权要求 |
|:---|:---|
| `POST /api/auth/register` | 无 |
| `POST /api/auth/login` | 无 |
| `GET /api/auth/me` | Bearer Token |
| `PATCH /api/users/me` | Bearer Token |
| 评分/感受/帖子提交 | Bearer Token |
| 管理员接口 | 有效会话 + 当前数据库 `role: "admin"` 且未封禁；角色管理另需唯一当前超级管理员 |
