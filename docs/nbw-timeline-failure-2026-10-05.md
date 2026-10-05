# 跨站时间线 NBW 上游故障隔离（2026-10-05）

## 已复现问题

生产后端 main `6b6eb92`，原生请求 `User-Agent: MastodonAndroid/3.0.1`、`X-App-Version-Code: 32`，无账号令牌：

- API直连和主站代理的 `/api/v1/timelines/public?limit=20/40` 以及后续40条分页均返回200、合法Status数组。
- 两渠道 `/api/v1/timelines/all?limit=20/40` 均500。根因是宝宝新天地返回 Cloudflare `526` 文本，而既有S2S工具不检查响应直接JSON解析；跨站聚合Promise.all连带失败。
- 专属NBW时间线及sync-threads alias返回502，说明失效源是NBW上游，并非相册新增签名卡片转换。
- 本轮没有用户设备连接，因此不把此公开原生复现等同所有已登录home时间线错误的验收；未铸造用户token或读取用户凭据。

## 修复行为

分支 `fix/album-timeline-20261005`，仅NBW工具和跨站/专属时间线及对应测试。2026-10-05 用户授权提交、推送与部署，通过 PR squash 合入 `main` 触发现有 Workers Builds；最终 PR/build/线上结果记录于下方，不将计划等同上线成功。没有migration、数据库写入、配置变更或TLS校验绕过。

- 固定HTTPS上游，禁止跳转；对HTTP网关错误、非JSON、格式错误转为受控且脱敏的NBW不可用错误。
- 仅 `get_sync_threads` 时间线读请求采用5秒截止与2MiB JSON上限，不改变上传/其他S2S操作的处理时限。
- 跨站聚合只隔离失效的NBW源，继续返回本站和交友源的可用内容；`X-ABDL-Timeline-Degraded: nbw` 标识降级。
- 降级分页保留未消耗的NBW opaque cursor，不将暂时故障误标为永久耗尽；只按实际发出的本站/交友内容推进游标。不会仅为故障源生成空白无限续页。
- 若无任何可返回内容且NBW不可用，返回503，不伪装正常200空列表；正常所有来源空则仍200空列表。本站数据库/鉴权故障不被伪装为成功降级。
- 专属NBW路径保持安全502不可用响应，合法NBW业务401/403仍沿用原状态；日志不包含上游正文、用户内容、token或请求参数。
- 不改变原生更新提醒的首载/分页规则、相册权限、no-store、CORS和Link语义。

## 验证

- 含真实Hono+SQLite、原生20/40首载及续页、526/非JSON/超时/上限、原始opaque游标恢复及更新提醒的专项77/77通过。
- 后端全量450通过/9个既有失败；修复前438通过/9失败，新增12个通过，失败集合未变。
- 相册权限/导入/卡片46/46通过。
- scoped ESLint、diff检查与Worker dry-run通过。
- 2026-10-05 已通过 [PR #20](https://github.com/ZhX589/abdl-space/pull/20) 合入 main `8104a40151ef56054fa35516f6d761e5592e515f`；生产自动部署及下方只读核验已完成。

## 生产部署与核验

- main 合并时间：`2026-10-05T09:27:23Z`（北京时间17:27:23）。
- Workers Builds成功：`630e5acf-fb01-4a1b-84e9-cedce16a465d`，检查完成 `2026-10-05T09:27:49Z`。
- Active deployment `b112b1de-07cb-4c6a-a372-67827639850a`，创建于 `2026-10-05T09:27:43.864966Z`；版本 `bd35b25f-4003-4748-8fac-73ea834c7bf1`，100%流量。
- API直连与主站代理分别核验原生code32：all首载20条200；all首载40条200（本站39、交友1）；40条续页200（本站35、交友5），前后页ID无重复。
- 响应保持 `private, no-store` 和Link，均标记 `X-ABDL-Timeline-Degraded: nbw`。普通公开时间线20条200；相册quota未登录401/no-store。
- 专属NBW仍502安全JSON `{error: NBW 服务暂时不可用, code: nbw_unavailable}`，无内部detail；没有关闭TLS校验或伪造上游恢复。
- 一次客户端只读核验遭临时SSL EOF，原证书校验下重试成功；没有修改网络/TLS配置。
- Android源码独立 [PR #5](https://github.com/ZYongX09/ABDL-Space-APP/pull/5) 合入main `32738ebd`，不进develop、不发布正式APK/latest。
- 遗留后端仓库Cloudflare Pages检查仍失败，Workers Builds与active部署明确成功，本轮未改Pages配置。

## 边界

此修复不能修复NBW上游证书/Cloudflare526本身，只保证一个失效源不拖垮可用来源。NBW恢复后保留游标的延迟内容可能出现在后续页，非整个聚合历史的重新排序。专属NBW页面在上游失效时仍应显示可重试不可用状态。
