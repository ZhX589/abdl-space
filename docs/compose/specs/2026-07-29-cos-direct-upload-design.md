# 腾讯云 COS 预签名直传设计

## [S1] 目标与范围

将 ABDL Space 的新上传主链路从第三方图床迁移到腾讯云 COS。文件字节由 Android、网页或发布脚本直接上传 COS，不经过 Cloudflare Worker 中转，以降低上传延迟并改善中国大陆访问。

首期覆盖帖子图片、头像、头图、通用图片和 APK。旧图床链路保留为用户明确选择的备用方案，不自动降级、不双写。历史图床 URL 保持可读，不迁移旧对象。

## [S2] COS 配置与安全边界

Bucket 为 `abdl-1339643562`，地域为 `ap-shanghai`，读取使用 COS 默认公有域名；Bucket 采用公有读、私有写。

长期 SecretId 和 SecretKey 只通过 Cloudflare Wrangler Secret 注入，禁止写入源码、配置、日志、规格或数据库。部署前轮换已暴露的密钥，并改用最小权限子账号：仅允许目标 Bucket 业务目录执行必要的 `PutObject`、`HeadObject` 和受控删除操作。

对象 Key 完全由后端生成，客户端不能指定任意路径。授权默认有效 5 分钟，绑定 HTTP 方法、Host、对象 Key、Content-Type 和必要校验头。普通用户只能完成自己申请的上传；APK 上传仅允许发布密钥或管理员。

## [S3] 两阶段上传协议

后端提供统一授权端点。客户端提交用途、MIME、文件大小和图片元数据；后端校验后创建 pending 上传记录，生成不可预测 Key，并返回预签名 `PUT` URL、必须发送的请求头、公开 URL、上传 ID 和过期时间。

客户端直接 `PUT` 文件到 COS。成功后调用完成端点。后端使用签名 `HEAD Object` 校验对象存在、大小和 Content-Type，再将记录标记为 complete，并返回业务所需媒体对象。未完成、已过期或所有权不匹配的上传不能用于发帖或更新资料。

## [S4] 图片原图与缩略图

图片上传采用双对象：原图存入 `media/original/{userId}/{date}/{uuid}.{ext}`，列表缩略图存入 `media/preview/{userId}/{date}/{uuid}.{ext}`。

Android 在本地生成最长边 540px、不放大的缩略图。不透明图片使用 JPEG，透明图片使用 WebP；保留方向校正。原图与缩略图分别申请授权并上传，完成端点要求两个对象都通过校验后才返回完成媒体。

后端将原图 URL、缩略图 URL、BlurHash、MIME、尺寸、大小和存储来源持久化。时间线直接返回持久化 `preview_url`，不再为新 COS 图片实时读取原图生成缩略图。历史记录没有 `preview_url` 时继续使用现有 v3 兼容回退。

## [S5] 业务分类

- 帖子图片：原图与 540px 缩略图双对象，完成后返回 Mastodon `Attachment`。
- 头像和头图：使用图片上传协议；资料更新接口只接受已完成且归当前用户所有的上传 URL。
- 通用图片：使用 `generic/` 目录和图片类型限制，替代 `/api/images/upload` 的默认代理上传。
- APK：发布脚本申请 `releases/` 对象授权，直传后用 JSON 调用版本更新接口；限制 APK MIME、扩展名和发布权限。
- NBW 同步：继续读取公开 COS 原图 URL并上传 NBW，不改变 NBW 协议。

## [S6] 旧客户端与图床备用链路

兼容期保留现有 `POST /api/v1/media` multipart 接口。旧客户端请求该接口时，Worker 先尝试将文件写入 COS并返回 COS URL；不在服务端自动回退图床。

新版 Android 默认预签名直传 COS。COS 授权、PUT 或完成校验失败时，界面提供“重试 COS”和“使用备用上传”。选择备用前必须说明：上传和访问可能更慢、依赖第三方图床、缩略图可能继续依赖实时生成。只有用户确认后才调用旧图床接口。

APK 发布脚本无交互回退：COS 失败即退出；维护者可显式执行单独的图床备用上传命令。

上传记录保存 `storage_provider = cos | imgbed`。媒体展示使用持久化 URL和 `preview_url`，不通过域名猜测存储来源。

## [S7] 数据模型与 URL 契约

新增上传记录表，至少包含上传 ID、用户、用途、对象 Key、公开 URL、preview Key/URL、MIME、声明与实测大小、状态、存储来源、创建时间和过期时间。

`post_images` 新增可空 `preview_url` 和 `storage_provider`。状态创建只接受合法 HTTPS URL，并优先要求 URL 对应当前用户已完成上传记录；历史图床 URL和既有外部媒体按兼容规则继续允许。

Mastodon `/api/v1/media` 和完成端点返回的 `Attachment.id` 保持可用于后续 `media_ids`。`url` 为原图，`preview_url` 为 COS 缩略图或历史兼容回退 URL。

## [S8] Android main 与 develop 交付

后端先部署兼容双协议版本。Android `main` 从 2.3.0 生产基线创建独立 2.4.0 补丁分支，只引入 COS 上传客户端、手动图床回退和必要版本更新，构建 Release 供用户测试。

Android `develop` 在独立 worktree 应用相同上传协议，保持开发版现有功能并构建 Debug。不得把 develop 的液态玻璃、徽章或其他未发布改动合入 2.4.0 补丁。

## [S9] 错误处理与可观测性

授权、PUT、HEAD 校验和完成阶段返回可区分错误码。后端日志记录上传 ID、用途、阶段、COS 请求 ID、HTTP 状态和耗时，但不记录签名 URL、Authorization 或密钥。

COS 失败不自动写图床。用户主动使用备用方案时记录一次 provider 切换事件，便于比较 COS 成功率、上传耗时和备用使用率。

过期 pending 记录由定时任务清理；已上传但未完成的孤儿对象延迟删除，避免客户端完成请求与清理竞争。

## [S10] 验收标准

- 新 Android 图片字节直接从设备上传 COS，Worker 不接收文件体。
- 新图片原图和 540px 缩略图均可通过 COS 默认域名公开读取。
- 时间线新帖直接返回持久化 COS `preview_url`，不命中 Worker 实时缩略图路由。
- COS 失败时不自动图床降级；用户可选择重试或确认使用备用上传。
- 旧生产 App 的 multipart `/api/v1/media` 仍可上传并返回可发帖的媒体对象。
- 头像、头图、通用图片、APK 和 NBW 同步路径均完成 COS 兼容。
- 非所有者、过期授权、错误 MIME/大小、篡改 Key 和未完成上传均被拒绝。
- 后端测试、dry-run 和生产验证通过；main 2.4.0 Release 与 develop Debug 分别构建成功并经用户测试。
