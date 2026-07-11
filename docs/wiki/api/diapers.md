# Diapers 纸尿裤

纸尿裤数据库查询、筛选与对比。

---

## GET /api/diapers

纸尿裤列表，支持搜索、筛选、排序、分页。每条附带实时计算的 `avg_score`（综合评分）。

- **鉴权**：无需

**Query 参数：**

| 参数 | 类型 | 默认 | 说明 |
|:---|:---|:---|:---|
| `search` | string | — | 模糊搜索 brand + model（不区分大小写） |
| `brand` | string | — | 精确筛选品牌 |
| `size` | string | — | 筛选支持的尺码（如 `M`、`L`） |
| `sort` | string | `id` | `id` / `avg_score` / `rating_count` / `thickness` |
| `order` | string | `ASC` | `ASC` / `DESC` |
| `page` | int | 1 | ≥ 1 |
| `limit` | int | 20 | 1–100 |

**请求示例：**

```bash
# 查询评分最高的 10 款
curl "https://api.abdl-space.top/api/diapers?sort=avg_score&order=DESC&limit=10"

# 搜索 "little"
curl "https://api.abdl-space.top/api/diapers?search=little"

# 筛选 ABU 品牌
curl "https://api.abdl-space.top/api/diapers?brand=ABU"

# 筛选支持 M 码的纸尿裤
curl "https://api.abdl-space.top/api/diapers?size=M"

# 组合查询：ABU 品牌 + M 码 + 评分降序
curl "https://api.abdl-space.top/api/diapers?brand=ABU&size=M&sort=avg_score&order=DESC"
```

**成功响应 200：**

```json
{
  "diapers": [
    {
      "id": 1,
      "brand": "ABU",
      "model": "Little Kings",
      "product_type": "纸尿裤",
      "thickness": 4,
      "absorbency_mfr": "7500ml",
      "absorbency_adult": "7500ml",
      "is_baby_diaper": 0,
      "comfort": 4.5,
      "popularity": 8,
      "material": "布感面料、四钩环魔术贴",
      "features": "日本风格印花，高吸水性 SAP 芯体，柔软透气底膜",
      "avg_price": "25-30元/片",
      "sizes": [
        { "label": "M", "waist_min": 79, "waist_max": 92, "hip_min": 95, "hip_max": 110 },
        { "label": "L", "waist_min": 90, "waist_max": 105, "hip_min": 105, "hip_max": 120 }
      ],
      "avg_score": 8.5,
      "rating_count": 23,
      "feeling_count": 5
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 11,
    "totalPages": 1
  }
}
```

> `avg_score` 计算规则：6 维度评分均值 × 0.9 + 感受维度均值 × 0.1。详见 [评分系统说明](../Home#评分系统说明)。

---

## GET /api/diapers/:id

纸尿裤详情，含评分记录 + 关联 Wiki。

- **鉴权**：无需

**请求示例：**

```bash
curl https://api.abdl-space.top/api/diapers/1
```

**成功响应 200：**

```json
{
  "diaper": {
    "id": 1,
    "brand": "ABU",
    "model": "Little Kings",
    "product_type": "纸尿裤",
    "thickness": 4,
    "absorbency_mfr": "7500ml",
    "absorbency_adult": "7500ml",
    "is_baby_diaper": 0,
    "comfort": 4.5,
    "popularity": 8,
    "material": "布感面料、四钩环魔术贴",
    "features": "日本风格印花…",
    "avg_price": "25-30元/片",
    "sizes": [
      { "label": "M", "waist_min": 79, "waist_max": 92, "hip_min": 95, "hip_max": 110 }
    ],
    "avg_score": 8.5,
    "rating_count": 23,
    "feeling_count": 5
  },
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
      "review": "非常舒服，吸水量惊人",
      "review_status": "approved",
      "created_at": "2026-05-20T10:30:00.000Z"
    }
  ],
  "wiki": {
    "diaper_id": 1,
    "category": "纸尿裤/ABU",
    "title": "Little Kings",
    "content": "ABU 的旗舰产品…",
    "updated_at": "2026-05-20T10:30:00.000Z"
  }
}
```

- `reviews` 按时间降序排列
- `wiki` 无关联 Wiki 时为 `null`
- `wiki.category` 由 `product_type + '/' + brand` 动态拼接

---

## GET /api/diapers/brands

品牌列表（去重），用于筛选下拉。

- **鉴权**：无需

```bash
curl https://api.abdl-space.top/api/diapers/brands
```

**响应 200：**

```json
{ "brands": ["ABU", "咔哆拉", "Rearz", "Tykables", "Bambino"] }
```

---

## GET /api/diapers/sizes

尺码标签列表（去重）。

- **鉴权**：无需

```bash
curl https://api.abdl-space.top/api/diapers/sizes
```

**响应 200：**

```json
{ "sizes": ["S", "M", "L", "XL", "XXL"] }
```

---

## GET /api/diapers/compare

多款纸尿裤对比，最多 5 款。返回 6 维度评分均值和尺码信息。

- **鉴权**：无需

**Query 参数：**

| 参数 | 类型 | 说明 |
|:---|:---|:---|
| `ids` | string | 逗号分隔的纸尿裤 ID，最多 5 个，超出截断 |

**请求示例：**

```bash
curl "https://api.abdl-space.top/api/diapers/compare?ids=1,2,3"
```

**成功响应 200：**

```json
{
  "diapers": [
    {
      "id": 1,
      "brand": "ABU",
      "model": "Little Kings",
      "thickness": 4,
      "absorbency_adult": "7500ml",
      "avg_price": "25-30元/片",
      "sizes": [
        { "label": "M", "waist_min": 79, "waist_max": 92 }
      ],
      "dimensions": {
        "absorption_score": { "avg": 8.2 },
        "fit_score": { "avg": 7.8 },
        "comfort_score": { "avg": 8.5 },
        "thickness_score": { "avg": 7.0 },
        "appearance_score": { "avg": 8.9 },
        "value_score": { "avg": 7.6 }
      },
      "avg_score": 8.5,
      "rating_count": 23
    }
  ]
}
```

> 不存在的 ID 会被静默跳过。
