# ABDL Space 3.1.0 正式发布记录

## 发布结果

- 服务端发布时间：`2026-10-07T06:49:57.333Z`（北京时间2026-10-07 14:49:57）。
- versionName：`3.1.0`；versionCode：`33`；包名：`top.abdl_space.app`；minSdk26、targetSdk35。
- 文件名：`ABDL-Space-3.1.0.apk`。
- 正式下载：<https://r2.abdl-space.top/apk/ABDL-Space-3.1.0.apk>。
- 主站下载页：<https://abdl-space.top/app>；移动下载页：<https://m.abdl-space.top/app>。
- 大小88,848,965字节（84.73 MiB）。SHA-256：`bad6aea07e80cb482fd22021c9b28b86464bce8cc53fb04432cb23f0002e0107`。
- APK v2签名重新验证通过，原证书SHA-256：`fd2098a3d3493222c247a7ba2787ec48fd8f62d38e9432ed4d6290a057dea475`（各历史发布同源证书）。

## 指定 APK、改名与重新构建

用户指定 `/home/ZYongX/projects/dist/sponsor-guide-release-evidence/ABDL-Space-3.0.1-code32-album-protection-report.apk` 重命名为 `ABDL-Space-3.0.0-31.apk` 并以其为基础推动新版本安装包上线。

改名已完成：该文件现为 `ABDL-Space-3.0.0-31.apk`（SHA-256 `98877d9ce427812b9999d86120b325ab958d0c562dbb48eb1b76487cf41e7ebe`），注意其内容仍是 3.0.1/code32 相册保护正式包，**不是** 2026-10-03 生产的真实 `ABDL-Space-3.0.0-31.apk`（3.0.0/code31）构建，两文件不能混用。

因版本号必须迭代到 3.1.0/code33（用户第 0 步），本轮实际发布对象为：基于 main 最新完整代码树重新构建的正式签名 release 包（`mastodon-release.apk` → 发布件 `ABDL-Space-3.1.0.apk`，build.gradle 已提交 `versionCode 33` / `versionName "3.1.0"`，正式签名重建，v2 签名证书与历史发布同一把）。全程只发布正式签名 release 测试形态，不生成调试 APK，构建成功不等同官方交付验收。

## 发布操作与证据

发布前新R2对象返回404；随后向既有桶 `abdl-space-img` 的 `apk/ABDL-Space-3.1.0.apk` 上传上述正式重建包，设置APK MIME、attachment文件名及immutable缓存。完整下载返回200，字节数与SHA-256均匹配，再调用既有JSON版本发布入口一次（body 含 `versionCode:33`、`apkUrl`、用户三条原文日志），返回HTTP200/success=true。

没有采用上轮失败的multipart图床发布分支；发布前的新对象404、R2回下载、JSON发布、四个查询入口均验证通过；线上回下载副本、旧元数据、payload与四个入口返回体保存在 `publication-3.1.0/`（含 `online-ABDL-Space-3.1.0.apk`，88,848,965字节）。发布后未修改鉴权、代理、域名、密钥、数据库结构或旧版退役策略。

## 更新日志（用户原文，逐字）

1.【新增】新增宝宝相册新功能，单次可上传20张照片！
2.【修复】进一步修复液态玻璃功能的bug
3.【优化】优化赞助者购买引导

## 四仓提交与主线整合

- Android main 现为 `3fcc3cc6`（recovery/20260925 已并入 main，`073e7046` 为合并提交），版本号提升提交（3fcc3cc6）在 main 上已推送；工作树无未提交源码（根目录旧 APK 保留不提交）。
- 后端 main 现为 `c20caa1`：相册保护/举报/重试修复均在 main（PR #22 已部署为 `abdl-space-api`），线上 `GET /api/v1/version` 已确认返回本发布信息。
- 主站 V2 main `4288d18`（PR #8）、移动站 main `77b12eb`：与远端同步，无未提交改动；`/app` 下载页已确认展示 3.1.0 下载链接与三条日志。
- `.mimosa/` 为扫描缓存不提交；本发布记录与 ROADMAP经独立发布记录分支进入 main，不直接 push 后端 main。

## 验证

- 发布后 4 个查询入口（api / 主站 proxy / 移动 proxy / pages.dev）均精确返回 3.1.0、code 33、下载 URL 与用户三条日志；4 个返回体 JSON 已存档。
- `abdl-space-img` 桶 `apk/ABDL-Space-3.1.0.apk` 为唯一本轮新对象，未覆盖旧对象；旧版退役策略与既有 3.0.x 下载链接保持原样。
- 版本缓存失效机制按既有逻辑执行，线上 `GET /api/v1/version` 即时返回新版本体（发布后已复核）。

## 验收边界

本轮没有覆盖、保留账号权限、真实赞助购买/宝宝认证/20张相册端到端真机验证；Android 真机 GPU（液态玻璃/图形）与真实 COS 双账号、管理端举报闭环仍为既有边界。不把本地构建成功与契约视作真机或生产验收通过。已安装同签名低版本的设备会正常收到升级提示。

Android 侧详细记录见 `ABDL-Space-APP` 仓 `docs/release-3.1.0-2026-10-07.md`。