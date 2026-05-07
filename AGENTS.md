# 项目技术栈

- 前端：React 18 + TypeScript + Vite
- 后端：Hono + Cloudflare Workers
- 数据库：Cloudflare D1 (SQLite)
- 样式：TailwindCSS（如果有）

# 代码规范

## 通用

- 使用 const 而不是 let
- 函数组件优先于类组件
- 导出的函数/组件必须写 JSDoc 注释
- 不要使用 any 类型，用 unknown 替代

## API 开发（src/index.ts 或 src/routes/）

- 所有 API 返回 JSON 格式
- 错误响应格式：`{ error: string }`
- 成功响应：直接返回数据对象或数组
- API 路径以 `/api/` 开头

## 前端组件（src/components/）

- 组件文件名使用 PascalCase：`UserProfile.tsx`
- 每个组件一个文件，不要多个组件挤在一起
- 组件接受 props 必须定义 interface
- 使用命名导出：`export function UserProfile()`

## API 调用（src/lib/api.ts）

- 所有后端 API 调用必须封装在 src/lib/api.ts 中
- 不要在组件中直接写 fetch
- 每个 API 函数必须有类型定义

## 数据库（D1）

- 表名使用 snake_case：`wiki_pages`
- 查询使用参数化语句：`prepare("... WHERE id = ?").bind(id)`
- 不要拼接 SQL 字符串

# Git 工作流

- 分支从 dev 切出
- 分支命名：feat/xxx、fix/xxx、docs/xxx
- PR 合并到 dev，由他（全栈开发者）审查和合并
- 不要直接推送到 main

# 常用命令

- `npm run dev` - 启动前端开发服务器
- `npx wrangler dev` - 启动本地 Worker API
- `npm run build` - 构建生产版本
- `npx wrangler d1 execute abdl-space-db --local --file schema.sql` - 本地导入数据库表

# 项目结构

```
src/
├── components/     # 可复用 UI 组件
├── pages/          # 页面级组件（路由对应）
├── lib/            # 工具函数和 API 封装
├── hooks/          # 自定义 React Hooks
├── types/          # TypeScript 类型定义
└── index.tsx       # 入口文件
```
