/**
 * 管理员种子脚本 — 创建默认 admin 用户
 *
 * 用法: npx tsx scripts/seed-admin.ts
 *
 * 默认账号:
 *   username: admin
 *   email: admin@abdl.space
 *   password: admin@ZhX&ZYongX
 *   role: admin
 *
 * 注意: 此脚本直接写入数据库，请仅在本地开发或首次部署时使用。
 */

import { hashPassword } from '../src/lib/auth.ts'

async function main() {
  const username = 'admin'
  const email = 'admin@abdl.space'
  const password = 'admin@ZhX&ZYongX'
  const role = 'admin'

  console.log(`Hashing password for ${username}...`)
  const passwordHash = await hashPassword(password)
  console.log('Password hashed.')

  const sql = `INSERT INTO users (email, password_hash, username, role) VALUES ('${email}', '${passwordHash}', '${username}', '${role}');`
  console.log('\n执行以下 SQL 插入 admin 用户:\n')
  console.log(sql)
  console.log('\n或使用 wrangler d1 execute:')
  console.log(`npx wrangler d1 execute abdl-space-db --local --command "${sql.replace(/"/g, '\\"')}"`)
}

main().catch(console.error)