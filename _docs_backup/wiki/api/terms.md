# Terms 术语百科

ABDL 社区术语词典。管理员维护。

---

## GET /api/terms

术语列表。支持搜索和分类筛选。

- **鉴权**：无需

**Query 参数：**

| 参数 | 类型 | 说明 |
|:---|:---|:---|
| `search` | string | 模糊搜索 term + definition |
| `category` | string | 精确筛选分类 |

```bash
curl "https://api.abdl-space.top/api/terms"
curl "https://api.abdl-space.top/api/terms?search=ABDL"
curl "https://api.abdl-space.top/api/terms?category=基本概念"
```

**响应 200：**

```json
{
  "terms": [
    {
      "id": 1,
      "term": "ABDL",
      "abbreviation": "Adult Baby / Diaper Lover",
      "definition": "成人宝宝/纸尿裤爱好者社群。AB 侧重回归婴儿的心理需求，DL 侧重纸尿裤本身的使用体验。",
      "category": "基本概念",
      "created_by": 1,
      "created_at": "2026-05-20T10:00:00.000Z"
    }
  ]
}
```

---

## GET /api/terms/categories

分类列表（去重）。

```bash
curl https://api.abdl-space.top/api/terms/categories
```

**响应 200：**

```json
{ "categories": ["基本概念", "品牌", "产品类型", "材质"] }
```

---

## GET /api/terms/:id

单个术语详情。

```bash
curl https://api.abdl-space.top/api/terms/1
```

---

## POST /api/terms

创建术语。

- **鉴权**：需管理员

| 字段 | 类型 | 必填 | 约束 |
|:---|:---|:---|:---|
| `term` | string | 是 | 1–50 |
| `abbreviation` | string | 否 | ≤ 100 |
| `definition` | string | 是 | 10–2000 |
| `category` | string | 否 | ≤ 30 |

```bash
curl -X POST https://api.abdl-space.top/api/terms \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "term": "SAP",
    "abbreviation": "Super Absorbent Polymer",
    "definition": "高吸水性聚合物，纸尿裤的核心吸水材料。能吸收自身重量数百倍的水分。",
    "category": "材质"
  }'
```

---

## PATCH /api/terms/:id

编辑术语。

- **鉴权**：需管理员

```bash
curl -X PATCH https://api.abdl-space.top/api/terms/1 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"definition": "更新后的定义内容..."}'
```

---

## DELETE /api/terms/:id

删除术语。

- **鉴权**：需管理员

```bash
curl -X DELETE https://api.abdl-space.top/api/terms/1 \
  -H "Authorization: Bearer $TOKEN"
```
