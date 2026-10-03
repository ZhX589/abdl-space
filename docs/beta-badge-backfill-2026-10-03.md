# 创始用户 beta 徽章补发

用户要求给数据库标记为创始用户的账号发放其已创建的 `beta` 徽章。2026-10-03 已在生产 D1 `abdl-space-db` 完成补发；没有部署 Worker 或修改徽章定义。

## 生产核验

- 显式指定 Cloudflare 账号 `c5a9726ee4c59c70d9261881af33ca87`，数据库来自本仓 `wrangler.jsonc`。
- 已存在定义：key `beta`，名称“创始用户”。未新建或覆盖定义。
- 资格只使用 `users.is_beta_user = 1`，不推算注册时间、用户编号或客户端标记。
- 发放前：符合资格 65 人，持有 0 人，缺失 65 人。
- 参数绑定补发新增 65 条 `user_badges` 记录。
- 发放后及独立只读复核：符合资格 65 人，持有 65 人，缺失 0 人。
- 新增记录 `displayed = 0`、`acknowledged_at = NULL`，采用实际补发时间。不替换用户佩戴徽章，不改创始资格。
- 未导出用户资料，未增加用户角色、权限或认证状态。

## 可复核工具

```sh
CLOUDFLARE_ACCOUNT_ID=c5a9726ee4c59c70d9261881af33ca87 node scripts/grant-beta-badges.mjs --dry-run
CLOUDFLARE_ACCOUNT_ID=c5a9726ee4c59c70d9261881af33ca87 node scripts/grant-beta-badges.mjs --apply
node --test scripts/grant-beta-badges.test.mjs
```

默认仅只读预检；`--apply` 才发放。所有外部 SQL 值通过 D1 REST `params` 绑定；不使用字符串插值 SQL。由于 Wrangler `d1 execute` 没有参数绑定入口，本工具使用 D1 查询 API，凭据仅从当前环境或 Wrangler 实际登录配置读取，不打印或提交密钥。OAuth 过期时先运行 `wrangler whoami` 刷新，工具不自行轮换凭据。

发放语句只补缺失持有记录并使用 `ON CONFLICT(user_id, badge_key) DO NOTHING`，重复或并发执行不会重复发放；现有记录的时间、确认及佩戴状态不改。定义缺失或统计不完整会报错；网络不确定不会自动重试写入，应先再次只读预检。

本地严格 SQLite 测试 3/3 通过，覆盖资格隔离、已有状态保留、重复零新增、定义缺失拒绝、查询失败及发放后仍缺失不报告成功。未使用生产用户会话验证 App 新徽章提示或用户主动佩戴界面；生产数据库持有记录已复核，不将其描述为客户端端到端验收。
