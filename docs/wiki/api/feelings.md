# Feelings 使用感受

5 维度 -5 ~ +5 的使用感受评分系统。每人每款每尺码一条记录。

---

## 维度说明

| 维度 | 字段名 | 负数含义 | 正数含义 | 0 |
|:---|:---|:---|:---|:---|
| 松紧度 | `looseness` | 太紧 | 太松 | 刚好 |
| 柔软度 | `softness` | 粗糙 | 柔软 | 一般 |
| 干爽度 | `dryness` | 潮湿 | 干爽 | 一般 |
| 锁味 | `odor_control` | 异味明显 | 锁味好 | 一般 |
| 静音 | `quietness` | 沙沙声大 | 静音 | 一般 |

---

## POST /api/feelings

创建使用感受。

- **鉴权**：需要
- **限制**：同一 user + diaper + size 只能一条（409 重复）

**请求体：**

| 字段 | 类型 | 必填 | 约束 |
|:---|:---|:---|:---|
| `diaper_id` | int | 是 | 必须存在 |
| `size` | string | 是 | 尺码标签（如 `M`、`L`），最长 10 字符 |
| `looseness` | int | 是 | -5 ~ 5 |
| `softness` | int | 是 | -5 ~ 5 |
| `dryness` | int | 是 | -5 ~ 5 |
| `odor_control` | int | 是 | -5 ~ 5 |
| `quietness` | int | 是 | -5 ~ 5 |

**请求示例：**

```bash
curl -X POST https://api.abdl-space.top/api/feelings \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "diaper_id": 1,
    "size": "M",
    "looseness": 0,
    "softness": 4,
    "dryness": 3,
    "odor_control": 1,
    "quietness": -1
  }'
```

**成功响应 200：**

```json
{ "message": "提交成功", "id": 42 }
```

---

## GET /api/diapers/:id/feelings

获取某纸尿裤的所有使用感受 + 分维度统计。

- **鉴权**：无需

```bash
curl https://api.abdl-space.top/api/diapers/1/feelings
```

**成功响应 200：**

```json
{
  "feelings": [
    {
      "id": 42,
      "user": { "id": 1, "username": "ZhX", "avatar": null },
      "diaper_id": 1,
      "size": "M",
      "looseness": 0,
      "softness": 4,
      "dryness": 3,
      "odor_control": 1,
      "quietness": -1,
      "created_at": "2026-05-20T10:30:00.000Z"
    }
  ],
  "stats": {
    "looseness": 0.5,
    "softness": 3.2,
    "dryness": 2.6,
    "odor_control": 0.8,
    "quietness": -0.3
  },
  "count": 12
}
```

- `stats` 每维度取所有记录均值，保留 1 位小数

---

## GET /api/feelings/me/:diaperId/:size

查询当前用户对某纸尿裤某尺码的感受。

- **鉴权**：需要

```bash
curl https://api.abdl-space.top/api/feelings/me/1/M \
  -H "Authorization: Bearer $TOKEN"
```

**响应 200：**

```json
{
  "feeling": {
    "id": 42,
    "diaper_id": 1,
    "size": "M",
    "looseness": 0,
    "softness": 4,
    "dryness": 3,
    "odor_control": 1,
    "quietness": -1,
    "created_at": "2026-05-20T10:30:00.000Z"
  }
}
```

---

## DELETE /api/feelings/:id

删除感受（仅本人或管理员）。

- **鉴权**：需要

```bash
curl -X DELETE https://api.abdl-space.top/api/feelings/42 \
  -H "Authorization: Bearer $TOKEN"
```

**成功响应 200：**

```json
{ "message": "删除成功" }
```
