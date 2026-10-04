# ABDL Space 3.0.1 正式发布记录

## 发布结果

- 服务端发布时间：`2026-10-04T07:30:41.333Z`（北京时间2026-10-04 15:30:41）。
- versionName：`3.0.1`；versionCode：`32`；包名：`top.abdl_space.app`；minSdk26、targetSdk35。
- 文件名：`ABDL-Space-3.0.1.apk`。
- 正式下载：<https://r2.abdl-space.top/apk/ABDL-Space-3.0.1.apk>。
- 主站下载页：<https://abdl-space.top/app>；移动下载页：<https://m.abdl-space.top/app>。
- 大小86,621,157字节（82.61 MiB）。SHA-256：`364069587871a31930efb24cbc443e4ea6e21b993ab28af55ce9021e07ed63b4`。
- APK v2签名重新验证通过，原证书SHA-256：`fd2098a3d3493222c247a7ba2787ec48fd8f62d38e9432ed4d6290a057dea475`。

## 指定 APK 与操作

用户指定 `/home/ZYongX/projects/assets/releases/3.0.1-32-backdrop/ABDL-Space-3.0.1-32-backdrop.apk`。本轮只改名、不重建、不重新签名，文件现位于同目录 `ABDL-Space-3.0.1.apk`。改名前原文件名备份保存在 `publication-3.0.1/original-ABDL-Space-3.0.1-32-backdrop.apk`；完整线上回下载副本、旧元数据、请求/成功响应及验证header均在该publication目录。

发布前新R2对象返回404；随后向既有桶 `abdl-space-img` 的 `apk/ABDL-Space-3.0.1.apk` 上传指定文件，设置APK MIME、attachment文件名及immutable缓存。完整下载返回200，大小与SHA-256均匹配，再调用既有JSON版本发布入口一次，返回HTTP200/success=true。

请求使用数值32、字段 `apkUrl` 及用户提供的原文两条日志。没有采用上轮失败的multipart图床分支，没有修改鉴权、代理、域名、密钥、旧版退役策略或数据库结构。

## 四仓提交与主线整合

- Android recovery `1667c81e` 通过PR #3完整进入main `0cbd5a9a`，合并后的代码树与recovery完全一致，包括液态玻璃真实节点链、关于背景、私信标题与评论修复。不单独合并废弃develop。
- 后端 main 发布前为 `87c148f`，所有recovery、sponsors及管理员修复已整合。宝宝认证分支此前通过PR #8/#9 squash：`6f82106`与`125c0eb`整棵tree相同，`dbd6751`与`88f7bdc`整棵tree相同，不能因旧分支tip非ancestor而重复覆盖当前main。
- 主站main `f8e89a8`：recovery/sponsors已整合，管理员主题/QQ分支与main代码树相同；法律记录工作树无未提交改动。
- 移动站main `85b2b99`：recovery/法律记录代码均在main，工作树无未提交改动。
- 四仓未发现遗漏源码。`.mimosa/`为扫描缓存不提交；Android根目录旧 `mastodon-release.apk`按既有保护保留且不提交（SHA-256 `0c711549b92e4dd3e1617fcca3858fd542bf12fce988415f1bd7cdb76b63b30a`）。其余源码提交均已推送。
- 本发布记录与ROADMAP通过独立记录分支/PR进入main，不直接推送后端main。本轮不新增业务代码或部署Worker/Pages。

## 验证

- API、主站代理、移动站代理与主站pages.dev代理的 `/api/v1/version` 均返回3.0.1/数字32、相同发布时间、下载地址、大小及原文两条日志。
- 主站和移动站浏览器下载页均实际显示v3.0.1、2026年10月4日、最新APK链接及两条日志。
- 本轮不重新构建Android或重跑全仓测试。发布APK此前294项focused回归及最终34项安全边界复验通过；既有QQ静态图标契约失败仍如实记录，不能宣称全仓测试全绿。
- 已读取设备原始液态玻璃失败日志，但没有覆盖安装新包；真机GPU/视觉、升级数据保留、真实评论/QQ/付款/宝宝认证端到端仍非本轮完成项。
- 发布版本从线上code31升为code32，旧code31客户端可发现升级；已经安装任何本地code32测试包的设备不会因版本号相同自动识别为更高版本，需手动安装此最新正式包。

## 更新日志（用户原文）

1.【修复】修复部分情况下无法评论的bug
2.【修复】修复无法显示液态玻璃效果的bug

## 回滚边界

旧latest元数据（3.0.0/code31）已保存，旧下载包仍保留。元数据可通过既有JSON入口回切，但会重置服务端releasedAt；已安装code32的设备不能靠元数据自动降级。没有删除旧对象或覆盖同名不同字节。
