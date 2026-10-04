# Admin 管理后台

管理员专用接口。鉴权使用当前数据库 `role === 'admin'` 且未封禁，不信任旧 JWT role 或 OAuth 用户缓存。降权后旧 token 只保留普通用户权限。

2026-10-04 后端源码已实现、未部署：唯一超级管理员由 `id=1 && role='admin' && !banned` 派生；role仍为admin/user。普通管理员可继续其他后台操作，但不能增加或取消管理员。无数据库migration，未执行生产SQL。

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

用户列表（含 email、role、boolean `is_super_admin`、`qq_bound` 等管理字段）；`GET /api/admin/users/:id/detail` 的 user 也返回 `is_super_admin`。均为当前用户行派生，banned的id1返回false，响应private/no-store。

- **鉴权**：需管理员

---

## DELETE /api/admin/users/:id

删除普通用户。id1、admin和未知role受保护，必须先由超级管理员降权；不能删除自己。清理及批内当前权限guard在同一个D1 batch，失败全部回滚，缓存只在成功后失效。保留既有普通用户嵌套评论/交友举报清理与私密对象监控任务。

```bash
curl -X DELETE https://api.abdl-space.top/api/admin/users/42 \
  -H "Authorization: Bearer $TOKEN"
```

---

## POST /api/admin/users/:id/ban

封禁/解封普通用户（toggle）。id1/admin/未知role禁止，必须先降权；SQL写入时再检查操作者和目标。缺少既有banned列失败关闭，不动态建列。

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

## PATCH /api/admin/posts/:id/nsfw

显式设置帖子敏感状态，并同步该帖全部图片的敏感标记。该操作是幂等的，不会修改帖子的 `edited_at`。

```bash
curl -X PATCH https://api.abdl-space.top/api/admin/posts/1/nsfw \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"has_nsfw":true}'
```

**响应 200：**

```json
{ "has_nsfw": true }
```

`has_nsfw` 必须是 JSON boolean。帖子不存在返回 404。

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

`adminMiddleware` 每请求读取当前数据库用户行、检查封禁及JWT会话边界，并刷新ctx role；数据库失败不会回退JWT权限。角色非admin返回403。

## POST /api/admin/add 与 PATCH /api/admin/users/:id/role

仅唯一当前超级管理员可调用，id1不能降权。POST JSON `{ "user_ids": [2,3] }`，1–100个不同正安全整数，保留响应 `{ "promoted": 2, "message": "2 个用户已提升为管理员" }`，已admin/不存在目标不计数。PATCH JSON `{ "role": "admin" }` 或 `{ "role": "user" }`，响应 `{ "id": 2, "role": "user", "is_super_admin": false }`。

仅application/json且禁止额外body字段；cookie写要求可信Origin（主站/www/移动站/wiki/localhost5173/5174），cross-site拒绝；无Origin必须独立有效bearer，无效bearer回退cookie不能绕过。OAuth要求admin+write scopes。400参数非法、401会话失效、403权限/id1降权、404目标不存在、409并发角色变化、415非JSON、500数据库失败。SQL写入再次检查权限；角色变更结构化日志包含actor/target/from/to/result，不新增审计表。响应private/no-store。

## 账户破坏性操作保护

`POST /api/admin/security/users/:id/track-and-ban`、`POST /api/admin/blocked-emails` 和 `POST /api/friend-request/admin/reports/:id/accept` 同样禁止id1/admin/未知role目标，须先降权。邮箱按trim/lowercase比较；track规则及IP写入、friendaccept的快照/删除状态/ban/举报处理均使用批内强制权限guard，同一D1batch回滚全部效果，失败不安排邮件或更新缓存。仅内容moderation不改变此账户管理边界。完整端点约束见仓库API.md；本说明不是已部署或生产验收记录。
