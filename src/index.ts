import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Env, JWTPayload } from './types/index.ts'
import type { Context, Next } from 'hono'
import { hashPassword, verifyPassword } from './lib/auth.ts'
import { authMiddleware, adminMiddleware } from './middleware/auth.ts'
import { queryOne, run } from './lib/db.ts'
import auth from './routes/auth.ts'
import beta from './routes/beta.ts'
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
import messages from './routes/messages.ts'
import images from './routes/images.ts'
import follows from './routes/follows.ts'
import admin from './routes/admin.ts'
import search from './routes/search.ts'
import apiKeys from './routes/api_keys.ts'
import reports from './routes/reports.ts'
import captcha from './routes/captcha.ts'
import captchaKeys from './routes/captcha_keys.ts'
import captchaV1 from './routes/captcha_v1.ts'
import oauth from './routes/oauth.ts'
import oauthClients from './routes/oauth_clients.ts'
import contentKeys from './routes/content_keys.ts'
import version from './routes/version.ts'
import contentV1 from './routes/content_v1.ts'
import nbw from './routes/nbw.ts'
import keySplit from './routes/key_split.ts'
import keySplitProxy from './routes/key_split_proxy.ts'
import checkin from './routes/checkin.ts'
import points from './routes/points.ts'
import invite from './routes/invite.ts'
import badges from './routes/badges.ts'
import sync from './routes/sync.ts'
import jpush from './routes/jpush.ts'
import lan from './routes/lan.ts'
import mastodon from './mastodon/routes.ts'
import mastodonV2 from './mastodon/v2.ts'
import mastodonPush from './mastodon/push.ts'
import mastodonAbdl from './mastodon/abdl.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const app = new Hono<AppType>()

app.use('*', async (c, next) => {
  // Handle /@username routes before CORS
  if (c.req.method === 'GET' && c.req.path.startsWith('/@') && c.req.path.length > 2) {
    const username = decodeURIComponent(c.req.path.substring(2))
    if (username) {
      const user = await queryOne<{ id: number }>(
        c.env.abdl_space_db, 'SELECT id FROM users WHERE username = ?', [username]
      )
      if (user) {
        const accept = c.req.header('Accept') || ''
        if (accept.includes('application/activity+json') || accept.includes('application/ld+json')) {
          return c.json({
            '@context': 'https://www.w3.org/ns/activitystreams',
            type: 'Person',
            id: `https://abdl-space.top/users/${username}`,
            preferredUsername: username,
            inbox: `https://abdl-space.top/users/${username}/inbox`,
            outbox: `https://abdl-space.top/users/${username}/outbox`,
          })
        }
        return c.redirect(`https://abdl-space.top/profile/${user.id}`, 302)
      }
      return c.text('User not found', 404)
    }
  }
  // /api/v1/* 路由由各自处理 CORS（允许所有来源）
  if (c.req.path.startsWith('/api/v1/') || c.req.path.startsWith('/v1/')) return next()
  return corsWithOrigin(c, next)
})

// Security headers (BUG-193)
app.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('X-XSS-Protection', '0')
})

app.use('*', logger())

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'https://wiki.abdl-space.top',
  'https://www.abdl-space.top',
  'https://abdl-space.top',
  'https://img.abdl-space.top',
  'https://open.abdl-space.top',
  'https://abdl-space-mobile.pages.dev',
]

async function corsWithOrigin(c: Context<AppType>, next: Next) {
  const incomingOrigin = c.req.header('origin') || ''
  const allowed = ALLOWED_ORIGINS.includes(incomingOrigin)
    || incomingOrigin.endsWith('.abdl-space.top')
    ? incomingOrigin
    : ALLOWED_ORIGINS[0]
  return cors({
    origin: allowed,
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Captcha-Token'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })(c, next)
}

app.get('/', (c) => c.json({ message: 'ABDL Space API' }))

app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

// ============================================================
// GET /@username — User profile page redirect
// ============================================================
app.get(/^\/@(.+)$/, async (c) => {
  const rawPath = c.req.path
  if (!rawPath.startsWith('/@') || rawPath.length <= 2) return c.text('Not found', 404)
  const username = decodeURIComponent(rawPath.substring(2))
  if (!username) return c.text('Not found', 404)

  const user = await queryOne<{ id: number }>(
    c.env.abdl_space_db, 'SELECT id FROM users WHERE username = ?', [username]
  )
  if (!user) return c.text('User not found', 404)

  const accept = c.req.header('Accept') || ''
  if (accept.includes('application/activity+json') || accept.includes('application/ld+json')) {
    return c.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'Person',
      id: `https://abdl-space.top/users/${username}`,
      preferredUsername: username,
      inbox: `https://abdl-space.top/users/${username}/inbox`,
      outbox: `https://abdl-space.top/users/${username}/outbox`,
    })
  }
  return c.redirect(`https://abdl-space.top/profile/${user.id}`, 302)
})

// ============================================================
// GET /.well-known/webfinger — Federation discovery
// ============================================================
app.get('/.well-known/webfinger', async (c) => {
  const resource = c.req.query('resource')
  if (!resource) return c.json({ error: 'resource parameter required' }, 400)

  const match = resource.match(/^acct:([^@]+)@(.+)$/)
  if (!match) return c.json({ error: 'Invalid resource format' }, 400)

  const [, username, domain] = match
  if (domain !== 'abdl-space.top') return c.json({ error: 'Unknown domain' }, 404)

  const user = await queryOne<{ id: number; username: string }>(
    c.env.abdl_space_db, 'SELECT id, username FROM users WHERE username = ?', [username]
  )
  if (!user) return c.json({ error: 'User not found' }, 404)

  return c.json({
    subject: `acct:${username}@abdl-space.top`,
    aliases: [`https://abdl-space.top/@${username}`, `https://abdl-space.top/users/${username}`],
    links: [
      { rel: 'self', type: 'application/activity+json', href: `https://abdl-space.top/users/${username}` },
      { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: `https://abdl-space.top/@${username}` },
    ],
  })
})

// ============================================================
// GET /@username — handled in CORS middleware above

// ============================================================
// GET /nodeinfo/2.1
// ============================================================
app.get('/nodeinfo/2.1', async (c) => {
  const userCount = await queryOne<{ cnt: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as cnt FROM users')
  const postCount = await queryOne<{ cnt: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as cnt FROM posts')
  return c.json({
    version: '2.1',
    software: { name: 'abdl-space', version: '1.0.0', repository: 'https://github.com/ZYongX09/ABDL-Space-V2', homepage: 'https://abdl-space.top' },
    protocols: ['activitypub'],
    services: { outbound: [], inbound: [] },
    usage: { users: { total: userCount?.cnt ?? 0 }, posts: { total: postCount?.cnt ?? 0 } },
    openRegistrations: true,
  })
})

// ============================================================
// GET /.well-known/host-meta
// ============================================================
app.get('/.well-known/host-meta', (c) => {
  return c.text(
    '<?xml version="1.0" encoding="UTF-8"?>\n<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">\n  <Link rel="lrdd" type="application/xrd+xml" template="https://abdl-space.top/.well-known/webfinger?resource={uri}"/>\n</XRD>',
    200, { 'Content-Type': 'application/xrd+xml' }
  )
})

app.get('/api/health/db', async (c) => {
  try {
    const result = await c.env.abdl_space_db.prepare('SELECT 1 AS ok').first()
    return c.json({ status: 'ok', db: result })
  } catch {
    return c.json({ error: 'Database connection failed' }, 500)
  }
})

app.route('/api/auth', auth)
app.route('/api/beta', beta)
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
app.route('/api/messages', messages)
app.route('/api/images', images)
app.route('/api/follows', follows)
app.route('/api/admin', admin)
app.route('/api/search', search)
app.route('/api/api_keys', apiKeys)
app.route('/api/reports', reports)
app.route('/api/captcha', captcha)
app.route('/api/captcha/keys', captchaKeys)
app.route('/api/v1/captcha', captchaV1)
app.route('/api/v1', mastodon)
app.route('/api/v1/push', mastodonPush)
app.route('/api/v1/abdl', mastodonAbdl)
app.route('/api/v1/version', version)
app.route('/api/v2', mastodonV2)
app.route('/api/oauth', oauth)
app.route('/api/oauth/clients', oauthClients)
app.route('/api/content/keys', contentKeys)
app.route('/api/v1/content', contentV1)
app.route('/api/auth/nbw', nbw)

// Mastodon OAuth compatibility: mount /oauth/* on same router
app.route('/oauth', oauth)

// Key Split — API Key 代理与统计
app.route('/api/key-split', keySplit)
app.route('/v1', keySplitProxy)
app.route('/api/checkin', checkin)
app.route('/api/users', points)
app.route('/api/invite', invite)
app.route('/api/jpush', jpush)
app.route('/api/auth/lan', lan)
// badges: 用户徽章路由挂载到 /api/users（/:id/badges 等）
app.route('/api/users', badges)
// 公开端点：所有徽章定义
app.get('/api/badges', async (c) => {
  const rows = await c.env.abdl_space_db.prepare(
    'SELECT key, name, icon, description, condition_type, condition_value FROM badges ORDER BY condition_value ASC'
  ).all()
  return c.json({ badges: rows.results || [] })
})
app.route('/api/sync', sync)

/**
 * POST /api/admin/reset/password — admin 只能改自己的密码（需鉴权）
 */
app.post('/api/admin/reset/password', authMiddleware, async (c) => {
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
 * POST /api/admin/add — admin 只能把非 admin 用户提升为 admin（需 admin 鉴权）
 */
app.post('/api/admin/add', adminMiddleware, async (c) => {
  try {
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
      message: `${changed} 个用户已提升为管理员`,
    })
  } catch (e) {
    console.error('Promote user error:', e)
    return c.json({ error: '操作失败' }, 500)
  }
})

// Fallback: return JSON 404 for any unmatched /api/v1/* or /api/v2/* routes
// Prevents Moshidon from crashing on plain-text 404 responses
app.all('/api/v1/*', (c) => c.json({ error: 'Not found' }, 404))
app.all('/api/v2/*', (c) => c.json({ error: 'Not found' }, 404))

export default app
