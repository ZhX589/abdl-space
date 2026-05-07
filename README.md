# ABDL Space Wiki 🍼

一个专注于 ABDL 用品（纸尿裤、玩具、服饰等）的维基百科式社区平台。支持多用户协作编辑、产品评分与评论。

## ✨ 功能特性

- 📖 **Wiki 页面** — 多用户协作编辑，版本历史支持回滚
- ⭐ **评分系统** — 1-5 星评分，聚合展示平均分
- 💬 **评论系统** — 支持嵌套回复，评论区可直接引用 Wiki 内容
- 🔐 **用户认证** — 邮箱注册登录，JWT 会话管理
- 🌓 **暗亮色切换** — 跟随系统或手动切换
- 📱 **响应式设计** — 完美适配桌面端与移动端
- 🎨 **毛玻璃 UI** — 简约可爱的视觉风格

## 🛠️ 技术栈

| 层级 | 技术选型 |
| :--- | :--- |
| **前端框架** | React 18 + TypeScript + Vite |
| **后端框架** | Hono (Cloudflare Workers) |
| **数据库** | Cloudflare D1 (SQLite) |
| **认证** | 自定义 JWT (WebCrypto API) |
| **文件存储** | Cloudflare R2 |
| **部署** | Cloudflare Pages + Workers |

## 🚀 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动前端开发服务器
npm run dev

# 3. 启动本地 Worker API（另一个终端）
npx wrangler dev

# 4. 本地初始化数据库
npx wrangler d1 execute abdl-space-db --local --file schemas/schema.sql
```

## 📁 项目结构

```
src/
├── components/       # 可复用 UI 组件
├── pages/            # 页面级组件（路由对应）
├── lib/              # 工具函数和 API 封装
│   ├── api.ts        # 后端 API 调用封装
│   └── utils.ts      # 通用工具函数
├── hooks/            # 自定义 React Hooks
├── types/            # TypeScript 类型定义
└── index.tsx         # 入口文件

schemas/
└── schema.sql        # D1 数据库表结构
```

## 🤝 贡献

见 [CONTRIBUTING.md](./CONTRIBUTING.md) 和 [AGENTS.md](./AGENTS.md)

## 📄 License

MIT
