# 种子数据

## diapers.sql

纸尿裤初始数据（11 条），JSON 数据来源：

https://github.com/ZYongX09/abdl/blob/master/client/public/data/diapers.json

导入命令：

```bash
npx wrangler d1 execute abdl-space-db --local --file schemas/seeds/diapers.sql
npx wrangler d1 execute abdl-space-db --remote --file schemas/seeds/diapers.sql
```