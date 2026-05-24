# ABDL Space API — 开发路线图

> 开始前请告诉我你是什么角色，我会引导你进入对应的任务线。

> **⚠️ 文档维护纪律：** 本文件是项目进度的**唯一权威来源**。每完成一个任务、每合并一个 PR、每发现一处代码与文档不一致，**必须同步更新本文件**。Git 提交不代表任务完成——文档里的 ✅ 才代表任务完成。严禁"代码合了但文档没改"。

## 项目定位

本仓库 = **纯后端 API**，为 ABDL 社区提供数据存储和 API 支持。

- 前端 Wiki 页面已拆分到独立仓库
- A 站点（朋友的功能站）通过 API 获取数据并提交评分、感受、帖子等

## 当前里程碑：v0.5.0 — 前后端分离 + 后续规划

## 版本规划

| 版本 | 目标 | 核心端点 | 状态 |
| :--- | :--- | :--- | :--- |
| **v0.1.0** | Schema 重构 + Auth 更新 + 纸尿裤数据 | auth (改) + diapers + seeds | ✅ 完成 |
| **v0.2.0** | Wiki CRUD + 评分展示 + 条目底部评论区 | wiki + wiki_inline_comments + ratings + post_comments | ✅ 完成 |
| **v0.3.0** | 排行榜 + 对比 + 搜索 + 术语 | rankings + compare + search + terms | ✅ 完成 |
| **v0.4.0** | 猜你喜欢 + 版本历史 + AI推荐 + 安全加固 | guess + page_versions + DeepSeek AI + captcha + oauth + rate-limit | ✅ 完成 |
| **v0.5.0** | 前后端分离 + 文档精简 | 删除前端代码，纯后端仓库 | ✅ 完成 |

---

## v0.1.0 ~ v0.4.0 已完成任务

所有 v0.1.0 ~ v0.4.0 的任务均已完成。详细列表见 DEPLOYMENT.md 部署日志。

---

## v0.5.0 — 前后端分离

### 任务列表

| # | 内容 | 状态 |
|:-:|:---|:---:|
| 1 | 删除所有前端源码（components/, pages/, hooks/, lib/api.ts, lib/utils.ts 等） | ✅ |
| 2 | 删除前端构建配置（vite.config.ts, index.html, wrangler-pages.jsonc 等） | ✅ |
| 3 | 清理 package.json（移除前端依赖和 scripts） | ✅ |
| 4 | 简化 tsconfig | ✅ |
| 5 | 简化 wrangler.jsonc（移除前端相关变量） | ✅ |
| 6 | 简化 eslint.config.js（移除 React 插件） | ✅ |
| 7 | 更新 AGENTS.md（去除前端相关内容） | ✅ |
| 8 | 更新 API.md | ✅ |
| 9 | 更新 README.md | ✅ |
| 10 | 更新 ROADMAP.md | ✅ |
| 11 | 更新 DEPLOYMENT.md（移除 Pages 相关） | ✅ |
| 12 | 删除 STYLE_GUIDE.md 和 CONTRIBUTING.md | ✅ |
| 13 | 清理 .opencode.json（移除前端配置组） | ✅ |
| 14 | 移除前端依赖 + .env.production | ✅ |
| 15 | 验证：npm run dev 正常启动 | ✅ |

---

## Bug 修复 & 新增端点

### v0.1.0 ~ v0.4.0 补丁（全部已合并到 dev）

| 日期 | 分支 | 修改 | 状态 |
|:---:|:---|:---|:---:|
| 2026-05-14 | `fix/admin-and-bugs` | P1: `sort=rating_count` 500 错误 + avg_score 公式修正 + admin 端点 + 输入校验 | ✅ |
| 2026-05-14 | `feat/wiki-versions-api` | A13: Wiki 版本历史 + 回滚 API | ✅ |
| 2026-05-14 | `feat/rankings-compare-ui` | B6: 排行榜页面 UI | ✅ |
| 2026-05-14 | `feat/search-api` | A10: 统一搜索 API | ✅ |
| 2026-05-14 | `feat/compare-ui` | B7: 纸尿裤对比页面 UI | ✅ |
| 2026-05-14 | `feat/search-terms-ui` | B8+B9: 搜索结果页 + 术语百科页 | ✅ |
| 2026-05-16 | `fix/security-hardening` | 安全加固：JWT httpOnly Cookie + CORS + 密码复杂度 | ✅ |
| 2026-05-16 | `feat/ai-recommend` | DeepSeek AI 推荐 + api_keys 表 | ✅ |
| 2026-05-16 | `fix/ratelimit-error` | 频率限制 + 错误信息脱敏 | ✅ |
| 2026-05-17 | `fix/prod-bugs` | fix: SQL语法错误 + computeAvgScore统一 + terms验证 | ✅ |

### 默认管理员账号

```
username: admin
email: admin@abdl.space
password: admin@ZhX&ZYongX
role: admin

导入命令: npx wrangler d1 execute abdl-space-db --local --file schemas/seeds/admin.sql
```
