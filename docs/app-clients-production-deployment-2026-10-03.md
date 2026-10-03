# App 版本策略与精确观测生产部署

日期：2026-10-03。用户明确要求完整部署并执行数据库迁移。

## 已完成

- Cloudflare 账号：`c5a9726ee4c59c70d9261881af33ca87`。
- 生产 D1：`abdl-space-db`，ID `159f81ba-ea32-4667-a3ce-d72cb1659d93`。
- 执行且仅执行 `migrations/0070_app_clients.sql`。迁移前确认三张 App 表不存在，site_settings 已存在；历史迁移账本不完整，未批量 apply 历史迁移。
- 统计起点：`2026-10-03T11:47:04.922Z`（UTC；北京时间19:47:04）。新增表和索引创建成功，`PRAGMA foreign_key_check` 无结果。
- 后端部署源码：`46d88d6`，Worker `abdl-space-api` 新版本 `1ee067d7-728e-4428-9f2d-5237fce3f4a0`，部署时间约11:48 UTC。
- 使用 `wrangler deploy --keep-vars`，确认现有 Secret 名称、D1/KV/Queue/Durable Object 绑定及兼容日期均保留；无密钥轮换。
- 前端通过 GitHub PR [#3](https://github.com/ZYongX09/ABDL-Space-V2/pull/3) 合并到生产 main，合并提交 `96c1021ca18c119c65e66dd0633913c11dfcb98b`。
- 生产 Pages 部署 `8ebd6f4f-1618-42a5-9653-52cb1c4ac8b7`，11:51:20 UTC 完成，Git 集成部署状态 success。没有 direct upload，没有修改 production_branch。
- 唯一合并冲突是前端 package.json 的测试脚本；保留法律文档测试和 App 测试。合并后95/95测试通过。
- `main-cdn` 当前脚本确认使用 `new Headers(request.headers)` 且转发到 `abdl-space-v2.pages.dev`；无显式 caches.default 操作。代理代码和 Worker 路由未改动。

## 线上检查

实际检查 Worker直连、api域名、Pages域名和主站main-cdn域名：

- 原生 UA + versionCode30 的公开时间线返回200、JSON数组，`Cache-Control: private, no-store`，Vary保留原生请求头维度。
- 原生 UA 的未登录 home时间线返回401，保持鉴权要求。
- 网页UA的公开时间线返回真实帖子，没有更新假帖。
- 主站 native UA 的 `/api/health` 返回200和 `{status:"ok"}`。
- 主站 native UA 的 `/api/admin/app-clients/stats` 无认证返回401，确认新接口鉴权。
- 线上浏览器访问 `/admin/app-clients` 加载正确 App管理标题；当前浏览器无管理员会话，正确显示“仅管理员可访问”，没有绕过登录。
- 某些非原生匿名探测的health/admin路径被边缘规则403；native健康检查正常。不调整现有WAF策略。
- 当前OAuth令牌不能读取 zone rulesets/pagerules（403），因此未确认所有Cache Rules配置，也未改缓存规则。真实native响应未看到共享缓存命中。

部署后复核：总开关 `enabled=false`，`block_unversioned=false`，废弃列表为空。统计表已就绪但核验时0个已认证观测账号；没有伪造账号/令牌或写入测试统计。没有在生产启用策略来测试假帖，没有修改真实用户状态。真实登录账号的计数写入、管理员页面数据显示及旧APK更新提示仍需正常真实会话验证，不能宣称已完成这部分端到端验收。

## 恢复点与边界

迁移前 Time Travel bookmark和schema导出存于仓库外权限受限目录：
`/home/ZYongX/.zcode/deployment-backups/abdl-app-20261003/`。
仅保存schema导出，不是完整离线用户数据备份；Time Travel为数据库回滚依据。

后端部署前版本：`be938603-53c7-470a-b8ff-b4758da59ef2`。如需回滚Worker，可回到该版本；新增App表应保留，不删除统计历史。总开关保持off，不以回滚或清空统计方式掩盖问题。

本次只发布本需求的后端与主站管理界面。移动网页没有新增本需求代码，不重复部署；Android签名APK的公开版本渠道、应用市场发布或安装不是本轮数据库/服务部署动作，未修改版本发布元数据。

生产users仍没有历史可选字段auth_invalid_before，现有代码按明确缺列回退password_changed_at；本次0070不偷偷增加无关字段。生产0069管理员身份表尚未存在，但当前部署入口没有挂载该独立身份管理模块，未将它混入本次迁移。
