# Admin 管理后台

管理员专用接口。所有接口需要 `role === 'admin'`。

---

## GET /api/admin/stats

站点统计数据。

- **鉴权**：需管理员

```bash
curl https://api.abdl-space.top/api/admin/stats \
  -H "Authorization: Bearer $TOKEN"
```

**响应 200：**

```json
{
  "users": 120,
  "posts": 340,
  "comments": 890,
  "diapers": 11,
  "ratings": 450
}
```

---

## GET /api/admin/users

用户列表（含 email、role 等管理字段）。

- **鉴权**：需管理员

---

## DELETE /api/admin/users/:id

删除用户。

```bash
curl -X DELETE https://api.abdl-space.top/api/admin/users/42 \
  -H "Authorization: Bearer $TOKEN"
```

---

## POST /api/admin/users/:id/ban

封禁/解封用户（toggle）。

```bash
curl -X POST https://api.abdl-space.top/api/admin/users/42/ban \
  -H "Authorization: Bearer $TOKEN"
```

**响应 200：**

```json
{ "banned": true }
```

---

## POST /api/admin/posts/:id/pin

置顶/取消置顶帖子（toggle）。

```bash
curl -X POST https://api.abdl-space.top/api/admin/posts/1/pin \
  -H "Authorization: Bearer $TOKEN"
```

**响应 200：**

```json
{ "pinned": true }
```

---

## DELETE /api/admin/posts/:id

删除任意帖子。

```bash
curl -X DELETE https://api.abdl-space.top/api/admin/posts/1 \
  -H "Authorization: Bearer $TOKEN"
```

---

## DELETE /api/admin/comments/:id

删除任意评论。

---

## DELETE /api/admin/diapers/:id

删除纸尿裤。

---

## 管理员鉴别

JWT payload 中的 `role` 字段为 `"admin"` 时，`adminMiddleware` 放行。否则返回 403：

```json
{ "error": "需要管理员权限" }
```
