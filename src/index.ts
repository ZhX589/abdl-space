import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Env, JWTPayload } from './types/index.ts'
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

export default app
