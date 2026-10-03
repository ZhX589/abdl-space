# ABDL Space API — 开发路线图

> 开始前请告诉我你是什么角色，我会引导你进入对应的任务线。

> **⚠️ 文档维护纪律：** 本文件是项目进度的**唯一权威来源**。每完成一个任务、每合并一个 PR、每发现一处代码与文档不一致，**必须同步更新本文件**。Git 提交不代表任务完成——文档里的 ✅ 才代表任务完成。严禁"代码合了但文档没改"。

## 项目定位

本仓库 = **纯后端 API**，为 ABDL 社区提供数据存储和 API 支持。

- 前端 Wiki 页面已拆分到独立仓库
- A 站点（朋友的功能站）通过 API 获取数据并提交评分、感受、帖子等

## 当前里程碑：v0.6.0 — 宝宝认证

### 宝宝认证后端首版（`feat/baby-verification`）

| # | 内容 | 状态 |
|:-:|:---|:---:|
| 1 | 成年声明、认证拍摄会话、私密申请与月额度 | ✅ |
| 2 | 私有 COS 照片授权、完整性校验与禁止覆盖 | ✅ |
| 3 | 管理员领取/释放/审核、证据查看授权与审计 | ✅ |
| 4 | 证书、256-bit 凭证、公开验证、吊销与补发 | ✅ |
| 5 | `verified` 徽章名称更新、通知跳转与 admin `unlocked_at` 修复 | ✅ |
| 6 | migration 0065、完整 schema、API/部署说明与 node:test | ✅ |
| 7 | COS 对象缺失返回 `409 evidence_object_missing`、上传重授权状态修复与真实函数/路由恢复链路回归（2026-10-03 随后端部署） | ✅ |

产品约束：不读取 `users.age`；仅接受并记录 `adult_declaration=true`、声明版本及时间。普通用户每自然月 2 次，有效赞助者 3 次，仅成功 submit 计入额度。

## Native App 版本退役与精确观测（2026-10-03，已生产部署、策略关闭）

| 内容 | 状态 |
|:---|:---:|
| anchored native UA + strict versionCode；所有 timeline 与 NBW alias 提前门禁；web 隔离、默认关闭、单条 synthetic 更新提醒及 no-store/Vary | ✅ |
| 新鲜 JWT/OAuth 账号会话观测，D1 account/version 唯一性、latest 降级、原子 await 写、无 has_app 回填 | ✅ |
| admin policy/stats/users 合约、reserved settings 校验、精确 appUsers/null unavailable、overview cache schema 升级 | ✅ |
| migration 0070、schema/bootstrap manifest、实际 middleware/routes SQLite 回归、API/部署顺序及指标边界 | ✅ |

范围仅 native GET timeline 退役 UX；客户端 metadata 自报，不能视为安装证明或完整 API 禁用。2026-10-03 已先执行生产 migration 0070，再部署 Worker与管理员界面；现有代理代码未改。统计起点 `2026-10-03T11:47:04.922Z`，策略仍 off，需真实会话观测并检查失败日志后再配置退役。真实主站链路native时间线200/no-store、未登录home401已检查；无管理员登录/旧APK真机闭环，详见 docs/app-clients-production-deployment-2026-10-03.md。

验证结果：新增 feature 回归 17/17 通过；结合 auth/admin/NBW 的 targeted 回归 27/27 通过；完整 npm test 342 pass / 9 fail，相比既有 baseline 325 pass / 9 fail，失败项未变化。保留已有无关 TypeScript 与 bootstrap paper_color 等 baseline 缺陷。

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

### 管理员初始化

管理员凭据属于本地/部署配置，不应记录在仓库文档中。请通过受保护的初始化流程设置，并在首次登录后轮换密码。
