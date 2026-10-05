# 宝宝相册后端生产交付（2026-10-05）

## 授权范围与状态

用户要求后端相册功能合入 `main` 并推送，触发现有自动部署；原文中的 `mainn` 按实际默认分支 `main` 处理。仅后端仓库，Android 与两个网页仓库不提交、不合并、不发布。

后端功能已通过 [PR #18](https://github.com/ZhX589/abdl-space/pull/18) squash 合入远端 `main`，提交 `92a15f3b435118ea3a4755d45510f964dfee3fcc`，合并时间 `2026-10-05T03:21:57Z`（北京时间11:21:57）。现有 Workers Builds 自动构建/部署成功，版本已100%启用；线上直连API和主站代理读取核验通过。功能分支已在远端删除，本地main已同步。

## 自动部署路径

- GitHub：`ZhX589/abdl-space`，默认分支 `main`。
- Cloudflare Worker：`abdl-space-api`，账号 `c5a9726ee4c59c70d9261881af33ca87`。
- 上一个 main 提交 `60a359b` 的 `Workers Builds: abdl-space-api` 检查成功，关联 build `2b5833bc-1652-4f27-bd9d-0b278c396797`，确认存在 Git 集成自动部署。
- 同一后端仓库还保留一个失败的 `Cloudflare Pages` 检查，与本次 Worker 部署区分记录；不会将其冒充 Worker 成功或擅自修改旧 Pages 配置。
- 本轮不运行本地 `wrangler deploy`，由远端 main 变更触发现有 Workers Builds。
- 功能分支预览构建成功：`7a679f5a-4eab-43b0-be9d-98f2626f1fb1`（仅上传预览版本，不激活生产）。
- main 生产构建成功：`f444aaf0-0d92-4f89-b50e-8b1653666873`，GitHub检查完成 `2026-10-05T03:22:27Z`。
- Active deployment：`aa793d01-568c-48f9-9b33-ce3d4577ed93`，创建于 `2026-10-05T03:22:19.105252Z`；版本 `374248ab-063d-4871-9b06-a27ed9a9b087`（version669），100%流量。
- 合并前生产版本 `49bd75e8-38d7-46e9-b7a7-2d33c840b294`，作为仅代码回退参考；本轮未回退。

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

## 线上核验

`api.abdl-space.top` 直连及 `abdl-space.top` 主站代理分别核验：

- `/api/v1/albums`、带尾斜线的根路径和 `/quota`：从部署前404变为正确401 `unauthenticated`，响应 `private, no-store`，无私有内容泄漏。
- `/api/v1/sponsors/catalog`：200/no-store，新增 `album_storage` 权益及容量档位说明。
- `/api/v1/timelines/public?limit=1`：200并返回既有帖子，时间线正常。

全部为无账号写入的公开/未登录读取；没有创建测试相册/用户、消耗用户原图额度或批量导入历史图片。

## 未宣称的验收

实际私有 COS 上传/下载与双账号共同相册、原图额度完整闭环尚未验证；未发布正式 App。遗留后端仓库 Cloudflare Pages 检查仍失败，本次 Worker main build检查与active deployment明确成功，未擅自修复或关闭Pages配置。
