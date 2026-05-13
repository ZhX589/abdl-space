import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Env, JWTPayload } from './types/index.ts'
import { hashPassword, verifyPassword } from './lib/auth.ts'
import { authMiddleware, adminMiddleware } from './middleware/auth.ts'
import { queryOne, run } from './lib/db.ts'
import auth from './routes/auth.ts'
import diapers from './routes/diapers.ts'
import ratings from './routes/ratings.ts'
import feelings from './routes/feelings.ts'
import posts from './routes/posts.ts'
import likes from './routes/likes.ts'
import rankings from './routes/rankings.ts'
import users from './routes/users.ts'
import wiki from './routes/wiki.ts'
import terms from './routes/terms.ts'
import recommend from './routes/recommend.ts'
import notifications from './routes/notifications.ts'
import admin from './routes/admin.ts'
import search from './routes/search.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const app = new Hono<AppType>()

app.use('*', cors())
app.use('*', logger())

app.get('/', (c) => c.json({ message: 'ABDL Space API' }))

app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

app.get('/api/health/db', async (c) => {
  try {
    const result = await c.env.abdl_space_db.prepare('SELECT 1 AS ok').first()
    return c.json({ status: 'ok', db: result })
  } catch {
    return c.json({ error: 'Database connection failed' }, 500)
  }
})

app.route('/api/auth', auth)
app.route('/api/diapers', diapers)
app.route('/api/ratings', ratings)
app.route('/api/feelings', feelings)
app.route('/api/posts', posts)
app.route('/api/likes', likes)
app.route('/api/rankings', rankings)
app.route('/api/users', users)
app.route('/api/pages', wiki)
app.route('/api/terms', terms)
app.route('/api/recommend', recommend)
app.route('/api/notifications', notifications)
app.route('/api/admin', admin)
app.route('/api/search', search)

/**
 * POST /admin_reset/password — admin 只能改自己的密码（需鉴权）
 */
app.post('/admin_reset/password', authMiddleware, async (c) => {
  const user = c.get('user')
  if (user.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const body = await c.req.json<{ old_password: string; new_password: string }>()
  const { old_password, new_password } = body

  if (!old_password || !new_password) {
    return c.json({ error: 'old_password and new_password are required' }, 400)
  }
  if (new_password.length < 8) {
    return c.json({ error: 'New password must be at least 8 characters' }, 400)
  }

  const dbUser = await queryOne<{ password_hash: string }>(
    c.env.abdl_space_db,
    'SELECT password_hash FROM users WHERE id = ?',
    [user.sub]
  )
  if (!dbUser) return c.json({ error: 'User not found' }, 404)

  const valid = await verifyPassword(old_password, dbUser.password_hash)
  if (!valid) return c.json({ error: 'Old password is incorrect' }, 401)

  const newHash = await hashPassword(new_password)
  await run(
    c.env.abdl_space_db,
    'UPDATE users SET password_hash = ? WHERE id = ?',
    [newHash, user.sub]
  )

  return c.json({ message: '密码已修改' })
})

/**
 * POST /admin/add — admin 只能把非 admin 用户提升为 admin（需 admin 鉴权）
 */
app.post('/admin/add', adminMiddleware, async (c) => {
  const body = await c.req.json<{ user_ids: number[] }>()
  const { user_ids } = body

  if (!Array.isArray(user_ids) || user_ids.length === 0) {
    return c.json({ error: 'user_ids must be a non-empty array' }, 400)
  }

  const placeholders = user_ids.map(() => '?').join(',')
  const result = await run(
    c.env.abdl_space_db,
    `UPDATE users SET role = 'admin' WHERE id IN (${placeholders}) AND role != 'admin'`,
    user_ids
  )

  const changed = result.meta.changes ?? 0
  return c.json({
    promoted: changed,
    message: `${changed} 个用户已提升为管理员`
  })
})

export default app
