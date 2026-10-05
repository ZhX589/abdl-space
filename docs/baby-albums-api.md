# 宝宝相册 API 与发布边界

实现来源：后端与 Android 的 `feat/baby-albums`。2026-10-05 用户授权仅后端合入 main 并触发自动部署；已在生产应用 `migrations/0071_baby_albums.sql`，PR/main/Workers Builds 结果见 [生产交付记录](baby-albums-production-2026-10-05.md)。没有手动部署 Worker、上传正式 APK 或修改 latest 元数据。后端上线后仍须发布支持相册的新 App。

## 权限及存储规则

- 根路径 `/api/v1/albums`，全部读取要求有效登录；公开相册向所有已登录用户开放。JWT/OAuth 会实时检查会话与封禁，OAuth 读接口要求 `read`、写接口要求 `write`。Cookie 写入另检查可信 Origin；所有写入（包括 DELETE）使用 `application/json`。
- `visibility` 为 `public`（公开）、`private`（仅主人）、`shared`（主人和已加入成员）。仅主人可上传、修改相册、删除照片及邀请/移除其他成员；有访问权的用户可给单张图片点赞和评论。成员可主动退出。
- 系统为用户幂等创建默认私有“宝宝相册”，不允许改名、公开化或删除。新帖图片与历史帖图片通过有界后台任务复制到默认相册，不改变既有帖子图片的公开 ACL。
- 相册独立使用 `albums/{owner}/…` COS 私有对象。缩略图、高清图、无损原图是独立文件；原始对象键、长效公共地址不进入读取 DTO。预览以及经授权的图片链接有效期为 60 秒，响应 `private, no-store`。退出共享相册或改为私有后，新请求立即拒绝；已发出的短效链接在有效期结束前仍有效，已由用户保存的文件不能远程撤回。
- 所有变体和未完成上传的预占字节计入容量。普通/周/月/季/年/永久分别为 3/5/10/20/50/100 GiB（UI 简写 GB）。赞助方案由当前会员状态及最新真实 grant/redeem 的期限快照推导，不信任昵称、徽章、客户端参数或剩余累计会员天数；没有方案快照的有效历史会员保守按周档 5 GiB 处理。到期降档不会删除已有照片，但超过新额度时拒绝新增上传。
- 高清与普通发帖使用相同压缩策略，单图高清文件上限 10 MiB；预览最长边 540、上限 2 MiB。无损上传要求当前有效赞助者，且每张原文件严格小于 20 MiB。无损字节不压缩，同时仍上传高清和预览。
- 无损原图只向主人提供查看/下载（身份到期也不向其他用户开放）。高清默认先显示预览；主人在当前赞助身份有效时可免费直接看/下载高清。其他高清授权复用现有每日“查看原图”额度机制。无损查看/下载即使主人是赞助者也要扣额度，使用同一操作 UUID 重试只扣一次；无损授权在额度服务未开启时失败关闭，不自动免费放行。
- 时间均为 UTC 秒；图片按 `coalesce(captured_at, uploaded_at)` 降序，再按上传时间、ID 排序。客户端按本地时区以日/秒分组，分组并不改变存储时间。

## 读取 DTO

`Album`：`id, owner_id, name, visibility, is_default, photo_count, cover_url, created_at, can_upload, is_owner, member_count`。

`Photo`：`id, album_id, batch_id, description, captured_at, uploaded_at, sort_at, preview_url, hd_url, original_available, width, height, likes_count, comments_count, liked, is_owner, owner_sponsor`。`hd_url` 仅在当前访问者为有效赞助者主人时存在；`original_available` 不向非主人暴露无损可用性。宽高为高清显示尺寸，原文件尺寸可以不同。

`StorageQuota`：`limit_bytes, used_bytes, reserved_bytes, remaining_bytes, tier, sponsor_active, original_upload_allowed`。赞助者 `/api/v1/sponsors/me` 也增补 `album_quota`；旧数据库尚无相册视图时保持原响应，额度读取故障为 `null` 而非伪造 0。catalog 增补相册权益。

## 接口

| 方法与路径 | 请求或响应 |
| --- | --- |
| GET `/` | 可选 `owner_id, limit, offset`；`{albums,has_more}`，仅返回可访问相册；两个根路径形式均兼容。 |
| POST `/` | `{name,visibility}`；201 `{album}`。 |
| GET `/quota` | 容量 DTO；处理到期批次和有界对象清理。 |
| GET `/:id` | `{album}`。 |
| PATCH `/:id` | `{name?,visibility?}`；`{album}`，仅主人。 |
| DELETE `/:id` | `{}`；`{deleted:true}`，默认相册禁止删除。 |
| GET `/:id/photos` | `limit,offset`；`{photos,has_more}`。 |
| GET `/photos/:id` | `{photo}`，免费续签预览 DTO，重新核验当前访问权；不消耗高清/无损原图额度。 |
| DELETE `/photos/:id` | `{}`；`{deleted:true}`，只删除相册副本，不删除源帖子。App 主人可长按详情图片并确认删除，以恢复容量。 |
| POST `/:id/batches/authorize` | 下述批次请求；一次性预占完整容量并签发私有 PUT。 |
| POST `/uploads/:uploadId/complete` | `{}`；`{complete:true}`，固定 COS host HEAD 核验长度/MIME/MD5；预览额外有界 GET 验证实际宽高和内容。 |
| GET `/batches/:batchId` | 当前批次 `album_id,batch_id,post_id,status`，仅主人。 |
| POST `/batches/:batchId/publish` | `{}`；`{album_id,batch_id,post_id}`；所有文件校验完成后一次事务发布，重试返回同一个帖子。 |
| POST `/batches/:batchId/cancel` | `{}`；`{cancelled:true}`；已发布批次 409，不删除已提交照片。 |
| POST `/photos/:id/authorize` | `{variant:"hd"\|"original",operation_id,notice_version?}`；`{url,expires_at,charged,quota?}`。 |
| POST `/photos/:id/like` | `{liked:boolean}`；`{liked,likes_count}`，幂等设置。 |
| GET `/photos/:id/comments` | `limit,offset`；`{comments,has_more}`。 |
| POST `/photos/:id/comments` | `{content,operation_id}`；201 `{comment}`；每条 1–2000 字符。 |
| DELETE `/comments/:id` | `{}`；`{deleted:true}`，评论作者或相册主人，仍须当前访问权。 |
| POST `/:id/invites` | `{}`；`{url,token,expires_at}`；共享相册主人生成/轮换二维码。 |
| POST `/join` | `{token}`；`{album}`，加入操作幂等。 |
| GET `/:id/members` | `{members:[{user_id,username}]}`。 |
| DELETE `/:id/members/:userId` | `{}`；`{deleted:true}`，主人移除或自己退出。 |
| POST `/import-history` | `{}`；`{imported,skipped,remaining}`；每次最多 4 张、有界且可重试。 |

邀请 URL：`https://abdl-space.top/album-invite/<64位小写十六进制token>`。256 位随机值，只保存 SHA-256；有效期 7 天，重新生成使旧邀请失效，但不会移除已加入成员。App 外部链接入口只接受该规范 HTTPS 地址。

### 上传批次

```json
{
  "operation_id": "客户端固定 UUID",
  "description": "本批图片描述，最多3000字符",
  "captured_at": null,
  "quality": "hd",
  "photos": [{
    "client_id": "0000",
    "width": 1600,
    "height": 1200,
    "variants": [
      {"kind":"preview","mime_type":"image/jpeg","size":12345,"content_md5":"标准Base64 MD5","width":540,"height":405},
      {"kind":"hd","mime_type":"image/jpeg","size":123456,"content_md5":"标准Base64 MD5"}
    ]
  }]
}
```

最多 20 张，`photos` 数组保留用户选择顺序，首张作为本批帖子卡片封面。无损质量每张还须提供 `kind:"original"`；支持 JPEG/PNG/WebP/GIF/HEIC/HEIF。高清仍使用帖子压缩后支持的 MIME；不支持的无损 MIME 在客户端提示使用高清。

返回 `{batch_id,uploads:[{photo_id,client_id,kind,upload_id,upload_url,required_headers,expires_at}]}`。PUT 必须逐项携带服务器要求的签名头，长度、MD5、MIME、私有 ACL 和禁止覆盖均受签名保护。PUT 授权最长 5 分钟，批次最长 1 小时；重授权保持同一对象/ID，签名截止时间同步写入所有被重签的文件记录（包括已完成文件），清理不能早于最后一个签名到期。

若同操作请求的批次已发布，authorize 返回 `{batch_id,uploads:[],published:true,album_id,post_id}` 而不再签发 PUT。同 UUID 改描述、时间、照片顺序或文件字节返回幂等冲突。未知 PUT 结果先尝试 complete；未知 publish 结果先尝试幂等 publish 或读取当前批次，不能重新发一个帖子。

取消/到期/删除先撤销可读性并登记物理对象清理；只有签名已到期且 COS DELETE 成功或明确 404，才释放对应字节。服务暂不可用时保留预占，不能伪装为已清理。清理由之后的容量读取、授权及导入触发，不承诺无人访问时自动定时回收。

## 相册更新帖及历史图片

公开相册每个上传批次自动创建普通帖子。标准正文固定为：

> 【宝宝相册】当前渠道不支持查看此内容，请下载最新版ABDL Space APP查看详情

没有普通 `post_images` 附件。支持的原生渠道通过可选 `album_update` 得到 `album_id,album_name,description,photo_count,cover_url,width,height`，App 显示描述及紧凑卡片，点击进入详情。网页及旧 App 仍显示标准正文。每次读取在当前数据库重新核验可见性；改为私有/共同或删除后，不向旧公开帖子返回相册名称、描述、图片。动态签名卡片不进入共享缓存。

历史导入只接受源帖子作者与同作者 `media_uploads` 已完成记录一致的 COS 文件，验证固定桶 host、规范对象键、类型、实际字节和尺寸。没有安全预览时在 Worker 内有界生成 540 像素 JPEG；先原子预占，再复制私有独立对象，最后 HEAD/MD5 校验并发布。原帖子保留，删除原帖不会删除相册副本。

非托管图床、无法证明归属、他人复制链接、已不存在源文件等不保证导入；永久跳过和暂时重试有单独 ledger，避免坏图片堵住后续批次。客户端有手动重试/分批继续入口；新帖后台单次处理有限数量，剩余图片在用户打开默认相册或手动导入时继续处理。

## 发布核验

已有生产数据库只审查并应用 `0071_baby_albums.sql`，不能重跑整个 schema 或盲目 apply 历史迁移。确认赞助者 0062 已存在及私有 COS 权限/CORS 兼容。新库使用 bootstrap manifest；完整 schema 已包含本功能及赞助依赖，但既有 bootstrap `paper_color` 缺陷仍须单独核查。

应在测试环境完成双账号共同相册邀请/撤权、公开改私有后旧帖子与签名失效、原图额度及重复授权、真实 COS 上传取消/恢复、赞助者到期降档、图片查看器评论和键盘避让的端到端验收。本轮本地测试及 APK 构建不能代替生产、真实图片/COS 或真机视觉验收。
