# 贡献指南

> 💡 **新加入项目？** 先看 [ROADMAP.md](./ROADMAP.md) 确认你的角色和当前任务。

## 环境准备（一次性的）

1. 安装 Node.js（>=18）
2. 克隆仓库：`git clone <仓库地址>`
3. 安装依赖：`npm install`
4. 本地初始化数据库：`npx wrangler d1 execute abdl-space-db --local --file schemas/schema.sql`

## 日常开发流程

### 1. 开始新功能前

```bash
git checkout dev
git pull origin dev
git checkout -b feat/你的功能名
```

分支命名规则：
- `feat/xxx` — 新功能（如 `feat/comments-list`）
- `fix/xxx` — Bug 修复
- `docs/xxx` — 文档变更
- `refactor/xxx` — 重构
- `style/xxx` — 样式/UI 调整

### 2. 开发中

- AI 辅助开发时参考 `AGENTS.md` 的代码规范
- 生成的代码放在对应目录：
  - 页面组件 → `src/pages/`
  - 通用组件 → `src/components/`
  - API 调用 → 先在 `src/lib/api.ts` 里写函数，再在组件里调用
  - 类型定义写在 `src/types/` 里
- 样式优先使用 TailwindCSS 类 + CSS 变量
- 遵循主题风格规范（见 `AGENTS.md` 主题风格章节）

### 3. 提交代码

```bash
git add .
git commit -m "feat(模块): 简短描述"
git push origin feat/你的功能名
```

提交信息格式：`类型(范围): 描述`
- 类型：feat / fix / docs / refactor / style / chore
- 范围：component / page / api / db / config 等

### 4. 发起 Pull Request

- PR 标题格式：`feat(模块): 描述`
- PR 模板会自动加载，按模板填写
- 如果有 UI 变更，附上截图
- 提交 PR 后通知全栈开发者 Review 和合并

## 目录说明

| 目录 | 放什么 |
| :--- | :--- |
| `src/pages/` | 页面组件（如 HomePage, WikiPage） |
| `src/components/` | 通用组件（如 Button, CommentList, RatingStars） |
| `src/lib/` | api.ts（API 调用封装）、utils.ts |
| `src/hooks/` | 自定义 Hook（如 useAuth, usePage, useTheme） |
| `src/types/` | TypeScript 类型定义 |
| `schemas/` | 数据库表结构定义 |

## 样式贡献指南

- 主色调：浅蓝/天蓝色系
- 组件优先使用毛玻璃效果
- 所有颜色通过 CSS 变量引用，方便暗亮色切换
- 响应式断点：`sm:640px` `md:768px` `lg:1024px` `xl:1280px`
- 新增组件时参考 `STYLE_GUIDE.md`

## 数据库变更流程

1. 修改 `schemas/schema.sql`
2. 本地测试：`npx wrangler d1 execute abdl-space-db --local --file schemas/schema.sql`
3. 提交包含 schema 变更的 PR
4. 部署时同步执行远程数据库迁移

## 程序员B专属：Git 实操指南（GitHub Desktop）

> 以下步骤专门为使用 GitHub Desktop 的开发者准备，一步一步照着做就行。

### 1. 克隆仓库
- 打开 GitHub Desktop → `File` → `Clone Repository`
- 选择 `GitHub.com` → 找到 `abdl-space` → `Clone`

### 2. 开始新功能
- 确保当前在 `dev` 分支（看左上角分支选择器）
- 先点 `Fetch origin` 获取最新代码
- 点 `Current branch` → `New branch` → 输入分支名（如 `feat/frontend-auth`）
- 确保基于 `dev` → `Create branch`

### 3. 开发中保持最新
> 如果你的开发周期超过一天，**每天开始前**这样做：
1. 点 `Fetch origin`
2. `Current branch` → `Choose a branch to merge into 你的分支名` → 选 `dev`
3. 如果有冲突，GitHub Desktop 会提示，按「常见问题」里的冲突解决步骤处理

### 4. 提交代码
- 在编辑器里改完代码后切回 GitHub Desktop
- 左侧会显示改动的文件列表
- 勾选要提交的文件 → 底部写 commit 信息
- 格式：`feat(模块): 简短描述`（如 `feat(auth): 添加登录页面`）
- 点 `Commit to feat/xxx`

### 5. 推送并创建 PR
- 点 `Push origin`
- 点 `Create Pull Request on GitHub`（会自动打开浏览器）
- 按模板填写 → `Create Pull Request`
- 通知 A 来 Review

### 6. PR 合并后清理
- 回到 GitHub Desktop → `Fetch origin`
- 左上角切回 `dev`
- `Current branch` → 选旧的 `feat/xxx` → `Delete`（删除本地旧分支）

## 常见问题

### Git 操作

#### 提交错了怎么办？

```bash
# 撤回最近一次提交（改动保留在工作区，可以重新提交）
git reset --soft HEAD~1

# 撤回最近一次提交（彻底丢弃改动，慎用！）
git reset --hard HEAD~1

# 改最近一次 commit 的消息
git commit --amend -m "新的提交信息"
```

> ⚠️ 只有**还没 push** 的提交才能用 `reset`。已经 push 的不要用，会出问题。

#### 你的分支落后于 dev 了怎么办？

```bash
# 在你的分支上执行：
git fetch origin
git merge origin/dev
```

或者在 GitHub Desktop 里：`Current branch` → `Choose a branch to merge...` → `dev`

#### 冲突了怎么办？

冲突文件里会有这样的标记：
```
<<<<<<< HEAD
你分支上的代码
=======
dev 分支上的代码
>>>>>>> dev
```

1. 手动编辑文件，**保留想要的内容**，删掉 `<<<<<<<`、`=======`、`>>>>>>>`
2. 保存文件
3. `git add . && git commit`
4. 或者 GitHub Desktop 会显示冲突文件，解决后点 Continue

#### 不小心在 dev 上写代码了怎么办？

```bash
# 还没 commit：
git stash
git checkout feat/xxx
git stash pop

# 已经 commit 了：
git checkout feat/xxx
git merge dev           # 把 dev 的提交带到你的分支
git checkout dev
git reset --hard HEAD~1  # dev 回退一个提交
```

### 前端怎么调 API？

```typescript
import { getPages, getPage } from '../lib/api'

const pages = await getPages()
const page = await getPage('getting-started')
```

所有 API 函数都在 `src/lib/api.ts` 中，类型定义在 `src/types/index.ts`。

### 毛玻璃效果怎么用？

```tsx
<div className="glass">
  {/* 内容 */}
</div>
```

`glass` 类定义了标准的毛玻璃样式，见全局 CSS 变量。

### 暗亮色切换？

使用 `useTheme` hook，返回 `{ theme, toggleTheme }`。主题值存储在 `localStorage` 中。

## 不要做的事

- ❌ 不要直接推送到 `main` 或 `dev`
- ❌ 不要在组件里直接写 `fetch`
- ❌ 不要用 `any` 类型
- ❌ 不要一个文件写多个组件
- ❌ 不要提交敏感信息（密钥、密码等）
