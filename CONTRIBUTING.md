# 贡献指南

## 环境准备（一次性的）

1. 安装 Node.js（>=18）
2. 克隆仓库：`git clone <仓库地址>`
3. 安装依赖：`npm install`

## 日常开发流程

### 1. 开始新功能前

打开终端，进入项目目录：

```bash
git checkout dev
git pull origin dev
git checkout -b feat/你的功能名
```

功能名用英文，短横线连接，例如：`feat/comments-list`

### 2. 开发中

- 打开 OpenCode，在对话框描述你要写的组件
- 生成的代码放在对应目录：
  - 页面组件 → `src/pages/`
  - 通用组件 → `src/components/`
  - API 调用 → 先在 `src/lib/api.ts` 里写函数，再在组件里调用
- 类型定义写在 `src/types/` 里

### 3. 提交代码

```bash
git add .
git commit -m "feat(模块): 简短描述"
git push origin feat/你的功能名
```

### 4. 发起 Pull Request

- 打开 GitHub 网页
- 点击 Compare & pull request
- 标题格式：`feat(模块): 描述`
- 粘贴 PR 模板内容（会自动带出来）
- 提交 PR，然后通知他（ZhX）来 Review

## 目录说明

| 目录 | 放什么 |
| :--- | :--- |
| `src/pages/` | 页面组件（如 HomePage, WikiPage） |
| `src/components/` | 通用组件（如 Button, CommentList） |
| `src/lib/` | api.ts（API 调用封装）、utils.ts |
| `src/hooks/` | 自定义 Hook（如 useAuth, usePage） |
| `src/types/` | TypeScript 类型定义 |

## 常见问题

### 前端怎么调 API？

已经在 `src/lib/api.ts` 中写好了函数，直接 import 用：

```typescript
import { getPages, getPage } from '../lib/api'

const pages = await getPages()
const page = await getPage('getting-started')
```

### 我怎么知道 API 返回什么格式？

看 `src/types/` 里的类型定义，或者问他。

## 不要做的事

- ❌ 不要直接推送到 `main` 或 `dev`
- ❌ 不要在组件里直接写 `fetch`
- ❌ 不要用 `any` 类型
- ❌ 不要一个文件写多个组件
