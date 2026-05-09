# ABDL Space

ABDL 主题社区平台，包含纸尿裤数据库、多维度评分系统、论坛、Wiki 百科和 AI 推荐功能。

本项目（B 站点）负责 **API 后端** 和 **Wiki 前端**，与 A 站点（评分主站）共享同一套用户系统。

## 功能特性

- **纸尿裤数据库** — 品牌/型号/尺码/材质等完整信息，支持搜索筛选
- **6 维度评分** — 吸收/贴合/舒适/厚度/外观/性价比，1–10 分制 + 文字评价
- **使用感受** — 5 维度 -5~5 对称评分（松紧/柔软/干爽/锁味/静音）
- **论坛** — 帖子/评论/点赞，支持置顶和关联纸尿裤
- **Wiki 百科** — 通用 Wiki + 纸尿裤条目关联，段评（段落级评论）
- **综合排行榜** — 热门/吸水量/人气/单维度等多类型排行
- **AI 推荐** — 根据身材和偏好智能推荐纸尿裤
- **术语百科** — ABDL 术语条目，管理员维护
- **经验等级** — 7 级徽章体系，活跃行为获经验
- **通知系统** — 点赞/评论/回复实时通知
- **管理后台** — 用户管理/内容审核/站点统计
- **用户认证** — 邮箱注册，支持 email 或 username 登录，JWT 会话
- **暗亮色切换** — 跟随系统或手动切换
- **响应式设计** — 桌面端与移动端
- **毛玻璃 UI** — 简约可爱的视觉风格

## 技术栈

| 层级 | 技术选型 |
| :--- | :--- |
| **前端框架** | React 19 + TypeScript + Vite |
| **后端框架** | Hono (Cloudflare Workers) |
| **数据库** | Cloudflare D1 (SQLite)，14 张表 |
| **认证** | 自定义 JWT (WebCrypto API, HS256) |
| **样式** | TailwindCSS v4 |
| **文件存储** | Cloudflare R2（规划中） |
| **部署** | Cloudflare Pages + Workers |

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动前端开发服务器
npm run dev

# 3. 启动本地 Worker API（另一个终端）
npx wrangler dev

# 4. 本地初始化数据库
npx wrangler d1 execute abdl-space-db --local --file schemas/schema.sql

# 5. 导入纸尿裤种子数据
npx wrangler d1 execute abdl-space-db --local --file schemas/seeds/diapers.sql
```

## 项目结构

```
src/
├── components/       # 可复用 UI 组件
├── pages/            # 页面级组件（路由对应）
├── routes/           # 后端路由（按模块拆分）
│   ├── auth.ts       # 认证
│   ├── diapers.ts    # 纸尿裤
│   ├── ratings.ts    # 评分
│   ├── feelings.ts   # 感受
│   ├── posts.ts      # 论坛
│   ├── wiki.ts       # Wiki
│   ├── rankings.ts   # 排行榜
│   ├── users.ts      # 用户
│   ├── terms.ts      # 术语
│   ├── recommend.ts  # 推荐
│   ├── notifications.ts
│   └── admin.ts      # 管理
├── middleware/       # Hono 中间件
│   └── auth.ts       # JWT 认证 + 管理员鉴权
├── lib/              # 工具函数和 API 封装
│   ├── api.ts        # 前端 API 调用封装
│   ├── auth.ts       # JWT + 密码哈希
│   ├── db.ts         # D1 工具函数
│   └── utils.ts      # 通用工具
├── hooks/            # 自定义 React Hooks
├── types/            # TypeScript 类型定义
│   └── index.ts      # 14 个核心模型接口
└── index.tsx         # 前端入口

src/index.ts          # 后端 Hono 入口

schemas/
├── schema.sql        # 数据库表结构（14 张表）
└── seeds/            # 种子数据
    └── diapers.sql
```

## 文档索引

| 文档 | 说明 |
| :--- | :--- |
| [API.md](./API.md) | 完整 API 规格文档（端点/请求/响应/Schema） |
| [AGENTS.md](./AGENTS.md) | AI 辅助开发指南（代码规范/分工/项目结构） |
| [ROADMAP.md](./ROADMAP.md) | 开发路线图（版本规划/任务线） |
| [STYLE_GUIDE.md](./STYLE_GUIDE.md) | 样式指南（配色/毛玻璃/暗亮色） |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 贡献指南（环境/流程/Git） |

## 贡献

见 [CONTRIBUTING.md](./CONTRIBUTING.md) 和 [AGENTS.md](./AGENTS.md)

## License

MIT
