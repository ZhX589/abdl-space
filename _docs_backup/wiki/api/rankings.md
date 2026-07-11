# Rankings 排行榜

综合排行榜，支持多种排序类型。

---

## GET /api/rankings

- **鉴权**：无需

**Query 参数：**

| 参数 | 类型 | 必填 | 说明 |
|:---|:---|:---|:---|
| `type` | string | 是 | `hot` / `absorbency` / `popular` / `dimension` |
| `dimension` | string | type=dimension 时必填 | `absorption_score` / `fit_score` / `comfort_score` / `thickness_score` / `appearance_score` / `value_score` |
| `limit` | int | 否 | 默认 20，最大 50 |

**排序规则：**

| type | 排序方式 |
|:---|:---|
| `hot` | 按 `avg_score` 降序（综合热门） |
| `absorbency` | 按 `absorbency_adult` 提取 mL 数值降序（吸水量最强） |
| `popular` | 按 `rating_count` 降序（评分最多） |
| `dimension` | 按指定维度的评分均值降序（单维度最强） |

**请求示例：**

```bash
# 综合热门排行
curl "https://api.abdl-space.top/api/rankings?type=hot&limit=10"

# 吸水量排名
curl "https://api.abdl-space.top/api/rankings?type=absorbency&limit=5"

# 人气最高（评分人数最多）
curl "https://api.abdl-space.top/api/rankings?type=popular&limit=10"

# 舒适度排名
curl "https://api.abdl-space.top/api/rankings?type=dimension&dimension=comfort_score&limit=5"

# 外观排名
curl "https://api.abdl-space.top/api/rankings?type=dimension&dimension=appearance_score&limit=5"
```

**成功响应 200：**

```json
{
  "rankings": [
    {
      "id": 3,
      "brand": "Rearz",
      "model": "Mermaid Tales",
      "avg_score": 9.2,
      "rating_count": 15,
      "thickness": 5,
      "absorbency_adult": "8000ml"
    },
    {
      "id": 1,
      "brand": "ABU",
      "model": "Little Kings",
      "avg_score": 8.5,
      "rating_count": 23,
      "thickness": 4,
      "absorbency_adult": "7500ml"
    }
  ],
  "type": "hot"
}
```

**错误：**
- 400 — type 不合法或 dimension 缺失

---

## 前端使用场景

排行榜数据适用于：
- 首页「热门推荐」模块
- 侧边栏「人气排行」小部件
- 单维度「最强吸水力」「最舒适」等专题页
- 对比页面的排序下拉
