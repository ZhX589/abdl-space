import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Env } from './types/index.ts'

const app = new Hono<{ Bindings: Env }>()

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

export default app
