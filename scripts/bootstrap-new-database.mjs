import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { databaseBootstrapFiles } from './database-bootstrap-files.mjs'

const args = process.argv.slice(2)
if (!args.includes('--local') && !args.includes('--remote')) {
  console.error('必须显式指定 --local 或 --remote；新库初始化不会猜测目标环境。')
  process.exit(2)
}

for (const file of databaseBootstrapFiles) {
  console.log(`Applying ${file}`)
  const result = spawnSync('npx', ['wrangler', 'd1', 'execute', 'abdl-space-db', ...args, '--file', resolve(file)], {
    cwd: resolve(import.meta.dirname, '..'),
    stdio: 'inherit',
    shell: false,
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
