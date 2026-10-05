# 宝宝相册后端生产交付（2026-10-05）

## 授权范围与状态

用户要求后端相册功能合入 `main` 并推送，触发现有自动部署；原文中的 `mainn` 按实际默认分支 `main` 处理。仅后端仓库，Android 与两个网页仓库不提交、不合并、不发布。

截至本记录首个提交：相册数据库迁移已在生产完成；后端 `feat/baby-albums` 正准备通过 PR squash 合入 `main`，Workers Builds 结果尚待核验。本记录不将准备合并等同已部署。

## 自动部署路径

- GitHub：`ZhX589/abdl-space`，默认分支 `main`。
- Cloudflare Worker：`abdl-space-api`，账号 `c5a9726ee4c59c70d9261881af33ca87`。
- 上一个 main 提交 `60a359b` 的 `Workers Builds: abdl-space-api` 检查成功，关联 build `2b5833bc-1652-4f27-bd9d-0b278c396797`，确认存在 Git 集成自动部署。
- 同一后端仓库还保留一个失败的 `Cloudflare Pages` 检查，与本次 Worker 部署区分记录；不会将其冒充 Worker 成功或擅自修改旧 Pages 配置。
- 本轮不运行本地 `wrangler deploy`，由远端 main 变更触发现有 Workers Builds。

## 生产数据库前置

执行前只读确认 `users/posts/post_images/media_uploads/sponsor_settings/sponsor_memberships/sponsor_operations` 已存在且需要的字段齐备；所有 `album*` 对象均不存在。

- 数据库：`abdl-space-db`，ID `159f81ba-ea32-4667-a3ce-d72cb1659d93`。
- 迁移前 D1 Time Travel bookmark：`00000efe-000002e2-000050fb-c7cb410a49354fa02bd1b59ed7ad219f`。
- 仅执行 `migrations/0071_baby_albums.sql`，没有重放完整 schema 或其他历史迁移。
- 执行成功：37 条查询；最终 bookmark `00000efe-00000300-000050fb-a95bfc3b22648329945b0624fe7a7e4a`。
- 核验 13 张相册表、8 个索引、15 个触发器、1 个容量视图已创建；容量视图覆盖当前874名用户。
- 迁移后 `albums=0`、`album_photos=0`、`album_storage=0`；未批量导入历史图片、创建测试相册/用户或修改既有帖子/会员状态。

代码回退时保留增量表；不要全库 Time Travel 回退以覆盖迁移后其他业务写入。只有出现确认的数据库故障且经授权时，才评估数据库恢复。

## 验证基线

- 前轮后端全量：438通过 / 9个既有失败；未改源码基线392通过 / 9失败，新增46通过。
- 本轮发布前相册权限、历史导入、原生兼容及赞助额度专项：69/69通过。
- 两仓上一轮 Android 综合101/101与debug APK构建通过，但本轮不发布 Android。
- 后端类型仍有317个既有诊断（基线321），按文件/诊断码无新增；不宣称类型检查全绿。
- `git diff --check` 和上轮 scoped ESLint、Worker dry-run通过。

## 未宣称的验收

实际私有 COS 上传/下载与双账号共同相册、原图额度完整闭环尚未验证；未发布正式 App。生产核验先采用无写入公开 catalog、未登录鉴权及现有时间线响应，并对照 GitHub build 与 Worker 版本确认代码上线。
