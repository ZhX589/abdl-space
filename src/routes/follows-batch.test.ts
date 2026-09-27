import test from 'node:test'
import assert from 'node:assert/strict'
import { signJWT } from '../lib/auth.ts'
import follows from './follows.ts'

function mockDb(results: Record<string, unknown>[][]) {
  const sqlLog: string[] = []
  const db = {
    prepare(sql: string) {
      sqlLog.push(sql)
      const all = async () => ({ success: true, results: results.shift() ?? [] })
      return { all, bind() { return { all } } }
    },
  }
  return { db, sqlLog }
}

const SECRET = 'test-secret'
const AUTH_QUERY_COUNT = 1 // authMiddleware 合并后的 users 单条查询

test('GET /batch-status returns per-author follow states with exactly two follows queries', async () => {
  const token = await signJWT({ sub: 1, username: 'alice', email: 'alice@example.com', role: 'user' }, SECRET)
  const { db, sqlLog } = mockDb([
    [{ role: 'user', password_changed_at: null }],
    [{ following_id: 2 }],
    [{ follower_id: 3 }],
  ])

  const res = await follows.request(
    '/batch-status?ids=2,3,2',
    { headers: { Authorization: `Bearer ${token}` } },
    { abdl_space_db: db, JWT_SECRET: SECRET } as never
  )

  assert.equal(res.status, 200)
  const body = await res.json() as { statuses: Record<string, { following: boolean; follower: boolean; mutual: boolean }> }
  assert.deepEqual(body.statuses['2'], { following: true, follower: false, mutual: false })
  assert.deepEqual(body.statuses['3'], { following: false, follower: true, mutual: false })

  // 去重后 2 个目标：鉴权 1 条 + follows 批量 2 条，与目标数量无关
  assert.equal(sqlLog.length, AUTH_QUERY_COUNT + 2)
  assert.ok(sqlLog[AUTH_QUERY_COUNT].includes('IN'))
  assert.ok(sqlLog[AUTH_QUERY_COUNT + 1].includes('IN'))
})

test('GET /batch-status rejects unauthenticated requests and caps ids at 100', async () => {
  const { db } = mockDb([])
  const noAuth = await follows.request(
    '/batch-status?ids=2',
    {},
    { abdl_space_db: db, JWT_SECRET: SECRET } as never
  )
  assert.equal(noAuth.status, 401)

  const token = await signJWT({ sub: 1, username: 'alice', email: 'alice@example.com', role: 'user' }, SECRET)
  const { db: db2, sqlLog } = mockDb([
    [{ role: 'user', password_changed_at: null }],
    [],
    [],
  ])
  const ids = Array.from({ length: 150 }, (_, i) => i + 1).join(',')
  const capped = await follows.request(
    `/batch-status?ids=${ids}`,
    { headers: { Authorization: `Bearer ${token}` } },
    { abdl_space_db: db2, JWT_SECRET: SECRET } as never
  )

  assert.equal(capped.status, 200)
  const body = await capped.json() as { statuses: Record<string, unknown> }
  assert.equal(Object.keys(body.statuses).length, 100)
  // IN 列表内的占位符数量与去重上限后的 id 数一致（不含前导 follower_id = ?）
  const inPlaceholders = sqlLog[AUTH_QUERY_COUNT].match(/IN \(([^)]*)\)/)?.[1].split(',').length ?? 0
  assert.equal(inPlaceholders, 100)
})
