# ABDL Space API

为 ABDL 社区平台提供数据存储与 API 支持的后端服务。A 站点通过此 API 获取纸尿裤数据、提交评分/感受/帖子，以及 Wiki 页面管理。

---

## 快速开始

```bash
# 注册新用户
curl -X POST https://api.abdl-space.top/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"12345678","username":"testuser"}'

# 登录获取 Token
curl -X POST https://api.abdl-space.top/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"login":"testuser","password":"12345678"}'

# 使用 Token 请求数据
curl https://api.abdl-space.top/api/diapers?sort=avg_score&order=DESC \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## 基本信息

| 项目 | 说明 |
|:---|:---|
| **生产环境** | `https://api.abdl-space.top` |
| **本地开发** | `http://localhost:8787` |
| **认证方式** | Bearer Token (JWT, HS256) |
| **数据格式** | JSON |
| **数据库** | Cloudflare D1 (SQLite) |
| **字符编码** | UTF-8 |

## 通用约定

### 认证

所有需鉴权的接口在请求头中携带 Token：

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### 错误响应

```json
{ "error": "用户名或密码错误" }
```

| HTTP 状态码 | 含义 |
|:---|:---|
| `400` | 请求参数不合法 |
| `401` | 未登录或 Token 过期 |
| `403` | 无权限（非管理员） |
| `404` | 资源不存在 |
| `409` | 冲突（如重复评分） |
| `500` | 服务器内部错误 |

### 分页

```http
GET /api/diapers?page=1&limit=20
```

响应中包含分页元数据：

```json
{
  "pagination": { "page": 1, "limit": 20, "total": 42, "totalPages": 3 }
}
```

- `page` ≥ 1，`limit` 1–100

### 用户信息脱敏

公开接口中用户信息统一为：

```json
{ "id": 1, "username": "ZhX", "avatar": null }
```

不含 `email`、`password_hash`、`weight` 等私密字段。只有用户查看自己的信息时才返回完整数据。

### 时间格式

所有时间字段使用 ISO 8601：

```
2026-05-08T15:10:35.472Z
```

---

## API 模块总览

| 模块 | 说明 | 鉴权 |
|:---|:---|:---|
| [Auth](./api/auth) | 注册、登录、用户信息 | 部分 |
| [Diapers](./api/diapers) | 纸尿裤数据库 | 无 |
| [Ratings](./api/ratings) | 6 维度评分 | 需鉴权 |
| [Feelings](./api/feelings) | 5 维度使用感受 | 需鉴权 |
| [Posts](./api/posts) | 论坛帖子 + 评论 | 需鉴权 |
| [Wiki Pages](./api/pages) | Wiki 百科 + 段评 | 部分 |
| [Rankings](./api/rankings) | 综合排行榜 | 无 |
| [Recommend](./api/recommend) | AI 推荐 + 猜你喜欢 | 需鉴权 |
| [Terms](./api/terms) | 术语百科 | 部分 |
| [Users](./api/users) | 用户资料 + 等级 | 部分 |
| [Admin](./api/admin) | 管理后台 | 管理员 |
| [OAuth 2.0](./api/oauth) | 第三方登录 | 无 |
| [Captcha](./api/captcha) | 人机验证 | 部分 |
| [Content API v1](./api/content-v1) | 开放平台内容 API | API Key |

---

## 评分系统说明

本项目使用 **6 维度 1–10 分** 评分制，而非传统的 1-5 星：

| 维度 | 字段名 | 说明 |
|:---|:---|:---|
| 吸水性 | `absorption_score` | 吸收液体的能力 |
| 贴合度 | `fit_score` | 与身体的贴合程度 |
| 舒适度 | `comfort_score` | 穿戴舒适感 |
| 厚度 | `thickness_score` | 厚薄程度 |
| 外观 | `appearance_score` | 印花/设计美观度 |
| 性价比 | `value_score` | 价格与质量比 |

综合评分 `avg_score` 由 6 维度均值 × 90% + 感受均值 × 10% 计算得出。

---

## 两种评论系统

| 表 | 用途 | 定位方式 |
|:---|:---|:---|
| `post_comments` | 条目底部讨论区（帖子/纸尿裤详情页） | `post_id` + `diaper_id` |
| `wiki_inline_comments` | Wiki 段落评论（划段批注） | `page_id` + `paragraph_hash` |

两者互不干扰，**不要混用**。

---

## 本地开发

```bash
npm install
npm run dev              # 启动 wrangler dev，端口 8787
```

需要更多帮助？查看 [入门指南](./Getting-Started) 或 [GitHub 仓库](https://github.com/ZhX589/abdl-space)。
