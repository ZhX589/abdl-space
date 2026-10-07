# ABDL Space API — 开发路线图

> 开始前请告诉我你是什么角色，我会引导你进入对应的任务线。

> **⚠️ 文档维护纪律：** 本文件是项目进度的**唯一权威来源**。每完成一个任务、每合并一个 PR、每发现一处代码与文档不一致，**必须同步更新本文件**。Git 提交不代表任务完成——文档里的 ✅ 才代表任务完成。严禁"代码合了但文档没改"。

## 项目定位

本仓库 = **纯后端 API**，为 ABDL 社区提供数据存储和 API 支持。

- 前端 Wiki 页面已拆分到独立仓库
- A 站点（朋友的功能站）通过 API 获取数据并提交评分、感受、帖子等

## 防盗图保护与相册举报（2026-10-05，后端+管理端+App 本地实现待发布）

基于相册功能分支新增；未生产 SQL/部署/commit/push，正式 App 未发布。

| 内容 | 状态 |
|:---|:---:|
| 防盗图：主人设置开关、默认相册允许仅改保护、非主人 HD/原图 403、扣额前后/签名后复检、事务内切换回滚 | ✅ 本地实现，专项通过 |
| 受保护封面/原生卡片隐藏、Photo `can_download`/`admin_blocked`、migration 0072 侧表默认关闭 | ✅ 本地实现 |
| 相册举报：登录用户提交（reason/detail/operation_id 幂等、同相册同举报人一条 open、10/小时）、独立管理 Tab、详情仅 60 秒预览 | ✅ 本地实现 |
| 管理员单图/批量屏蔽（期望状态替换）、屏蔽图对所有人显示"违规"占位、blocked 图互动 404、migration 0073 | ✅ 本地实现 |
| 后端全量 468 pass / 9 既有 fail（防盗图前 461/9 → 新增 7 通过）；Android 149 项中 14 项测试夹具/边界修复中 | ⏳ 收尾 |
| 生产发布（0072/0073 SQL、Worker、App） | ⏳ 未执行；明确不承诺绝对防盗 |

## 跨站时间线 NBW 上游故障隔离（2026-10-05，main 已合并并自动部署）

分支 `fix/album-timeline-20261005`，基于生产 main `6b6eb92`。已复现 API直连和主站代理原生20/40跨站请求500：NBW上游526文本被直接JSON解析，拖垮三源聚合；普通公开时间线及续页200，不是相册转换错误。

| 内容 | 状态 |
|:---|:---:|
| 固定HTTPS、不跟随跳转；NBW时间线读5秒/2MiB上限及脱敏错误，其他S2S操作不强加同样时限 | ✅ |
| 仅NBW故障降级、本站/交友可用内容保留、opaque cursor不误耗尽、降级header；无可用内容503、本站D1故障仍失败 | ✅ |
| 专属NBW/alias安全502，合法业务401/403保留，原提醒/相册权限/no-store/CORS/Link回归 | ✅ |
| 真实Hono/SQLite故障首载/续页、20/40、游标恢复/提醒不重复与虚拟超时/流量上限回归 | ✅ 专项77/77；全量450pass/9既有fail，新增12pass；类型317→315无新增 |
| 生产上线及真实降级/分页核验 | ✅ PR #20/main8104a40，Worker bd35b25f100%启用；直连/主站all20/40及续页200无重复，无migration |
| NBW上游证书故障本身的恢复 | ⏳ 服务方负责，本轮不关闭TLS校验、不改NBW配置 |

详见 [故障与修复记录](docs/nbw-timeline-failure-2026-10-05.md)。

## 宝宝相册（2026-10-05，后端 main 已合并并自动部署，App 未正式发布）

功能实现来自后端与 Android 的 `feat/baby-albums`；网页保留标准文字提示，不新增网页相册界面。2026-10-05 用户授权仅后端提交并通过 PR 合入 `main`、推送触发 Workers Builds。本轮先执行生产增量 migration 0071，再通过 PR #18 squash 合入 main `92a15f3`，Workers Builds成功并100%启用版本 `374248ab-063d-4871-9b06-a27ed9a9b087`；线上相册401/no-store、容量权益200、原时间线200均已核验。详见 [生产交付记录](docs/baby-albums-production-2026-10-05.md)。未手动部署 Worker，Android/网页不提交或发布，未更新 latest。接口见 [宝宝相册 API](docs/baby-albums-api.md)。

| 内容 | 状态 |
|:---|:---:|
| 公开/私有/共同权限、默认不可公开“宝宝相册”、共享邀请轮换/退出/撤权、逐图互动及主人删除 | ✅ 本地实现 |
| 独立私有 COS 三变体、完整性/禁止覆盖、原子容量预占、发布幂等/事务回滚、取消/删除确认清理后才释放字节 | ✅ 本地实现 |
| 当前真实方案容量 3/5/10/20/50/100 GiB、过期降档保留内容、主人赞助高清免费/无损原图仅主人按额度授权 | ✅ 本地实现 |
| 原生 `album_update` 描述和紧凑封面卡片、标准旧渠道文字、实时可见性及缓存剥离；普通编辑不能改写系统相册更新帖 | ✅ 本地实现 |
| 新帖与历史图分批可重试私有复制、明确归属/固定 COS host/实际字节尺寸、540预览及 VP8L/VP8、先预占后复制 | ✅ 本地实现 |
| 秒级自定义时间/默认上传时间；免费预览续签、删除照片恢复容量；Android个人主页Tab、上传/详情/选择页、液态入口、原查看器评论/键盘避让 | ✅ 本地实现与专项验证；Android综合101/101、debug APK构建通过 |
| 生产增量0071与容量视图（874名当前用户，未批量导入/创建相册） | ✅ 已执行并只读核验 |
| 后端 PR/main 推送与 Workers Builds 自动部署、直连/主站代理鉴权和旧时间线核验 | ✅ PR #18/main92a15f3，生产Worker版本669已启用 |
| 真实 COS/双账号额度闭环、真机主题/评论视觉及正式 App 发布 | ⏳ 未执行 |

后端验证：未修改源码快照基线 **392 pass / 9 fail**；最终全量 **438 pass / 9 fail**，新增46项通过，失败集合仍为既有 bootstrap1、admin-identities strip-only1、QQ4、uploads3。一次并行负载重跑出现既有 novel-authoring 72h 时间边界失败，独立及完整重跑均恢复，未修改该业务。`tsc --allowImportingTsExtensions --types node` 基线321、最终317个既有诊断，按文件与诊断码对比无新增；不是全量类型检查通过。相册 scoped ESLint、`git diff --check` 和 Worker dry-run 打包通过，未执行部署。

实施约束：有效历史赞助者无真实方案快照时保守按周档 5 GiB；永久跳过不可证明归属的链接，不承诺全部历史外部图片导入。读链接 60 秒，已发短效链接及已保存文件不能即时撤回。物理清理失败保留额度，后续主人容量读取/上传/导入触发有界重试；本轮没有增加无人访问时自动清理的定时任务。

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

## Native App 独立非阻断更新提醒（2026-10-04，后端实现未部署）

分支 `feat/app-update-reminder`，基于 main `365e275`；仅修改后端及 API/路线图文档。本轮无 commit/push/deploy、无生产 SQL、无 migration、无管理员前端或 main-CDN/代理改动。

| 内容 | 状态 |
|:---|:---:|
| 独立 `AppClientReminder`（首版三字段；下述扩展后四字段且兼容旧三字段）、reserved `site_settings.app_client_reminder`、GET/PUT `/api/admin/app-clients/reminder`、严格校验、空白消息使用默认、缺行安全默认与原子 upsert（不依赖观测 epoch） | ✅ |
| 退役优先且旧四字段合约不变；严格 native UA/指定合法内部版本；真实时间线完成后仅变换 200/JSON/≤2MiB 非空数组；保留全部真实状态及真实分页/CORS/代理头 | ✅ |
| 复用 account `-1` / status `app-update-required` guards，纯文本转义/换行/固定下载页；reserved ID 替换；no-store/Vary、失败 fail-open 日志及快照隔离 | ✅ |
| SQLite 实际 admin/auth/public/home/geo/NBW/alias、禁用/非命中/缺版本/浏览器冒充、限流/观测/退役优先/headers/body-bound/read-failure 回归及文档 | ✅ |

分页兼容约束：Android 普通分页未可靠去重稳定 synthetic ID，gap filling 还会以相同 ID 判断交集；因此仅非空无游标首载注入。含 `max_id/min_id/since_id/cursor` 或非零 offset 的续页/增量刷新保持真实数组，空页保持 `[]`；不生成 Link，不改真实 next/prev/opaque cursor。native `max_id=app-update-required` 在鉴权/退役之后返回终止空数组、不读取真实内容，即使提醒已关闭。带旧游标的刷新不新增提醒，须无游标新载；不是全页持续置顶能力或客户端真机验收。

验证：提醒新增 12/12；与既有 retirement/auth/admin/NBW 合并专项 **44/44**。本轮源码基线全量 349 pass / 10 fail；最终 **362 pass / 9 fail**（新增 12 pass，另修复已触碰的旧观测测试硬编码 2026-10-03 导致随日期失效的 fixture 为相对时间，增加 1 pass/减少 1 fail）。其余 9 个失败集合未变：bootstrap 1、admin-identities Node strip-only 加载 1、QQ 4、uploads 3；不声称全量通过。带 `--allowImportingTsExtensions --types node` 的 typecheck 仍有项目既有诊断，app-clients 类型/实现/测试与 admin-app-clients 无诊断；不是生产验证。

## Native App 未上报有效版本号的非阻断提醒（2026-10-04，后端实现未部署）

分支 `feat/app-reminder-unversioned`，基于 main `a7dd390`；仅后端及 API/路线图，未改管理员前端。无 migration/生产 SQL、平台配置/依赖、代理/CDN、deploy、commit 或 push；既有退役四字段及认证/限流/观测不变。

| 内容 | 状态 |
|:---|:---:|
| `AppClientReminder` 四字段新增 boolean `include_unversioned`，默认 **true**；master `enabled` 仍默认 **false**；严格仅接受旧三字段或新四字段，显式 null/string/number 非 boolean 拒绝 | ✅ |
| 旧三字段存量配置及旧 PUT 缺此字段归一化 true（已启用的旧提醒也覆盖缺失/格式错误版本）；GET/PUT 返回四字段、保存四字段，读取不改存量行 | ✅ |
| 仅 anchored native UA 的 parser null 桶按此开关匹配，文案含义“未上报有效版本号”；合法版本仍按 `version_codes`，普通网页缺 header/桌面与 Android 浏览器/header-only/OAuth 身份不扩展匹配 | ✅ |
| 仅非空首载注入 fake + 全部真实状态；续页/增量刷新/空页/reserved 终止游标、移动下载链接、退役 null-block 优先、失败 fail-open/no-store/Vary 全保留 | ✅ |
| SQLite 回归含旧配置读写、新字段严格校验、缺失/非法 native 版本、分组及 master 开关、浏览器/鉴权隔离、真实 public/home/geo/NBW/alias、快照/分页/终止/退役、OAuth/限流；API 文档同步 | ✅ |

验证：新增回归 **5/5**，app-clients（含既有提醒/退役）**34/34**；结合 auth/admin/NBW 的专项 **55/55**。修改前全量 **362 pass / 9 fail**，最终独立重跑 **367 pass / 9 fail**，失败集合完全相同（bootstrap 1、admin-identities Node strip-only 加载 1、QQ 4、uploads 3）。并行负载下第一次全量 366 pass / 10 fail，额外 novel-private live parsing lease 时间敏感用例独立重跑恢复，不修改无关业务/测试。`tsc --noEmit --allowImportingTsExtensions --types node` 前后均 **327** 个既有诊断，输出逐字一致，app-clients 类型/实现/测试及 admin-app-clients 无诊断；故障注入产生既有 structured observation/policy/reminder/read/write/body fail-open 日志，无本功能失败。`git diff --check` 通过；不声称全量/typecheck 全绿、生产部署或真机验收。

## 唯一超级管理员与后台权限边界（2026-10-04，后端实现未部署）

开发分支 `feat/super-admin-console-20261004`，接续已有后端实现。本节只记录后端；移动站与主站后台一致、后台仅深/浅色属于独立前端任务，不以本后端回归替代UI验收。2026-10-05 用户授权提交、推送并通过 PR 交付到 `main`；合并结果以 GitHub PR 状态为准，与 Worker 部署独立。本轮不执行 Worker 部署、生产 SQL、migration、平台配置或依赖变更，未触碰 `.mimosa`。

| 内容 | 状态 |
|:---|:---:|
| 当前用户行派生唯一 `is_super_admin = id1 && roleadmin && !banned`；role保持admin/user兼容App；auth/me、管理员用户列表/detail新增boolean及private/no-store | ✅ |
| POST `/api/admin/add`仅super、保留promoted/message；PATCH `/api/admin/users/:id/role`仅super、id1禁止降权；严格JSON/ID/body、Origin及独立有效bearer检查、OAuth admin+write scopes、写时实时权限/CAS与结构化角色变更日志 | ✅ |
| admin/auth中间件ctx role实时刷新，Mastodon共享JWT/OAuth鉴权移除用户权限缓存并检查当前用户、封禁与JWT新鲜度；旧token降权后不得继续admin，普通会话可保留 | ✅ |
| id1/admin/未知role禁止delete/ban/track/friend举报accept/blocked-email破坏，需super先demote；SQL内再检查目标/操作者，DB不可用不放行、无请求时ALTER | ✅ |
| delete/track/friendaccept以批内 `SELECT CASE ... ELSE abs(-9223372036854775808)` 强制权限断言，D1 batch回滚全部写入；失败无缓存/邮件副作用；保留普通用户嵌套评论/交友举报清理及永久私密对象监控任务 | ✅ |
| 25个新增实际路由/真实SQLite回归：权限/角色兼容/实时撤权/OAuth缓存/封禁派生/CSRF JSON、目标并发提升与操作者降权/ban、后续写失败和unsuccessful批回滚；API及既有wiki admin/auth文档同步 | ✅ |

验证：从同一HEAD归档到仓库外本地重新执行基线 **367 pass / 9 fail**，最终全量 **392 pass / 9 fail**，新增25个通过项；9个既有失败名称一致（bootstrap1、admin-identities strip-only1、QQ4、uploads3），未扩大或修复无关业务。结合admin/auth/app-clients/IP/NBW专项 **79/79**。既有delete测试fixture补原子batch；uploads wrong-owner fixture补实际存在user7，以保留实时会话检查下原403测试含义。`tsc --noEmit --allowImportingTsExtensions --types node` 基线327、最终321诊断：触碰的auth文件显式D1类型/确定ctx role/准确AuthMe字段消除6个既有诊断，无新增（对比规范化路径和行号），并非全量/typecheck全绿。最新Workers类型与官方best-practices已核验，未改绑定/迁移。仅本地内存SQLite及测试验证，非生产部署、真机或最终前端验收。

## Android 3.0.0 正式版发布（2026-10-03）

| 内容 | 状态 |
|:---|:---:|
| 四仓 recovery 合入 main；不单独合并废弃 develop | ✅ |
| 指定签名 code31 APK 改名、上传既有 R2、完整回下载哈希核验 | ✅ |
| latest 元数据与用户提供的14条正式版日志上线，API/主站/移动站核验 | ✅ |

发布时间 `2026-10-03T13:14:08.755Z`；版本 `3.0.0 / 31`。未修改管理员鉴权或旧版退役策略；本轮后端全量340 pass / 11 fail，版本/缓存专项17/17通过，不声称全量或真机验收通过。详见 [正式版发布记录](docs/app-release-3.0.0-31-2026-10-03.md)。

## Android 3.0.1 正式版发布（2026-10-04）

| 内容 | 状态 |
|:---|:---:|
| 四仓源码提交/远端同步核对，Android三轮修复经PR #3完整合入main；其它功能分支已集成/squash实质代码核验 | ✅ |
| 指定最终code32签名APK仅改名为ABDL-Space-3.0.1.apk，上传既有R2并完整回下载核验大小/SHA-256 | ✅ |
| latest更新为3.0.1/32及用户原文两条日志，API/主站/移动站代理与浏览器下载页核验 | ✅ |

发布时间 `2026-10-04T07:30:41.333Z`。本轮不重建APK、不部署业务代码、不改鉴权/代理或退役策略；原签名不变，旧包保留。不是修复后真机GPU/真实评论端到端验收；已安装本地code32的设备需手动安装正式包。详见 [3.0.1发布记录](docs/app-release-3.0.1-2026-10-04.md)。

## Android 3.1.0 正式版发布（2026-10-07）

| 内容 | 状态 |
|:---|:---:|
| 版本号迭代 3.1.0 / code33（Android `3fcc3cc6`），recovery/20260925 已并入 main，四仓提交推送核对 | ✅ |
| 指定包改名 `ABDL-Space-3.0.0-31.apk`（内容仍为3.0.1/code32，与真实3.0.0-31构建区分）；另基于 main 重建正式签名 3.1.0 包 | ✅ |
| 上传 R2 `apk/ABDL-Space-3.1.0.apk`（88,848,965字节）并完整回下载核验 SHA-256；latest 更新为 3.1.0/33 及用户三条原文日志 | ✅ |
| API/主站/移动站代理与浏览器下载页核验均返回 3.1.0 | ✅ |

发布时间 `2026-10-07T06:49:57.333Z`；版本 `3.1.0 / 33`。本轮正式签名 release 重建（非调试），v2 签名证书与历史同源；不修改鉴权、代理、密钥、数据库或旧版退役策略。Android 真机 GPU 双账号与管理端举报闭环等仍为既有验收边界；不把构建成功或接口契约视作生产验收 PASS。详见 [3.1.0发布记录](docs/app-release-3.1.0-2026-10-07.md)。

## 管理员 QQ 绑定状态与存量 beta 徽章（2026-10-03）

修复分支 `fix/admin-qq-beta-20261003`，从 main 切出；QQ 源码修复尚未部署，不将本地验证等同生产验收。

| 内容 | 状态 |
|:---|:---:|
| 管理员用户列表及 `/api/admin/users/:id/detail` 从 `qq_identities` 返回准确 boolean `qq_bound`；不依赖 app subject、不输出身份标识、不可用不伪装 false、响应 private/no-store | ✅ |
| `qq_bound=bound\|unbound` 与搜索/角色/total 同步；静态参数化筛选、分页/筛选/详情 id 非法参数校验，仅覆盖这两个查询接口 | ✅ |
| 严格内存 SQLite 回归：identity-only、多 subject、筛选分页与 total、非法参数、解绑后刷新、失败/未知状态、敏感字段排除；API/types 同步 | ✅ |
| 主代理参数化生产补发 `beta`（名称“创始用户”）存量徽章：eligible=65，owned 0→65，missing 65→0，changes=65；未更改新用户发放机制 | ✅ |

验证：新增管理员 QQ 回归 5/5，含既有管理员用例 7/7 通过；admin/qq/auth 专项 25 pass / 5 fail；全量 349 pass / 10 fail，相比修复前 341 pass / 10 fail 新增 8 个通过项（QQ 5 + 主代理徽章脚本 3），失败集合未变化。`admin-identities` 测试已有 TypeScript parameter-property 在 Node strip-only 模式加载失败；QQ 的 4 个既有失败未扩大到本任务修复范围。原样 `tsc --noEmit` 744 个诊断（基线 745，复用测试 SQL 读取函数减少 1 个重复诊断），补齐现有测试所需 `--allowImportingTsExtensions --types node` 后 327 个诊断与原分支快照一致；两种配置均无新增诊断，不声称全量或 typecheck 通过。生产补发记录见 [beta 徽章补发记录](docs/beta-badge-backfill-2026-10-03.md)。

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
