# ABDL Space API

ABDL 主题社区平台后端 API 服务，为 ABDL 主题社区平台提供数据存储和 API 支持。

## 技术栈

| 层级 | 技术选型 |
| :--- | :--- |
| **后端框架** | Hono (Cloudflare Workers) |
| **数据库** | Cloudflare D1 (SQLite)，14 张表 |
| **认证** | 自定义 JWT (WebCrypto API, HS256) + OAuth 2.0 |
| **部署** | Cloudflare Workers |

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动本地开发服务器
npm run dev

# 3. 本地初始化数据库
npx wrangler d1 execute abdl-space-db --local --file schemas/schema.sql

# 4. 导入纸尿裤种子数据
npx wrangler d1 execute abdl-space-db --local --file schemas/seeds/diapers.sql
```

## 项目结构

```
src/
├── routes/           # 后端路由（按模块拆分）
├── middleware/       # Hono 中间件（认证/Captcha）
├── lib/              # 工具函数（auth/db/captcha/oauth/rate-limit）
├── types/            # TypeScript 类型定义
├── static/           # 静态资源（captcha embed SDK）
├── index.ts          # Hono 入口
└── api-worker.ts     # Cloudflare Workers fetch handler

schemas/
├── schema.sql        # 数据库表结构（14 张表）
└── seeds/            # 种子数据

migrations/           # D1 数据库迁移
scripts/              # 实用脚本
```

## 文档索引

| 文档 | 说明 |
| :--- | :--- |
| [API.md](./API.md) | 完整 API 规格文档（端点/请求/响应/Schema） |
| [AGENTS.md](./AGENTS.md) | AI 辅助开发指南（代码规范/项目结构） |
| [ROADMAP.md](./ROADMAP.md) | 开发路线图（版本规划/任务线） |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | 部署指南 |

## License

MIT
