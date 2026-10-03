import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { adminMiddleware } from '../middleware/auth.ts'
import { appClientStats, appClientUsers, parseAppVersionCode, readAppClientPolicy, validateAppClientPolicy, writeAppClientPolicy } from '../lib/app-clients.ts'

const appClients = new Hono<{ Bindings: Env; Variables: { user: JWTPayload } }>()
appClients.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store')
  await next()
})
appClients.use('*', adminMiddleware)
appClients.get('/policy', async c => {
  const { policy, available } = await readAppClientPolicy(c.env.abdl_space_db)
  if (!available) return c.json({ error: 'App client policy unavailable' }, 503)
  return c.json(policy)
})
appClients.put('/policy', async c => {
  const policy = validateAppClientPolicy(await c.req.json().catch(() => null))
  if (!policy) return c.json({ error: 'Invalid app client policy: exactly four fields, boolean flags, up to 200 distinct positive int32 codes, and a nonempty message up to 2000 characters required' }, 422)
  try {
    await writeAppClientPolicy(c.env.abdl_space_db, policy)
    return c.json(policy)
  } catch (error) {
    console.error(JSON.stringify({ event: 'app_client_policy_write_failed', error: String(error) }))
    return c.json({ error: 'App client policy unavailable' }, 503)
  }
})
appClients.get('/stats', async c => c.json(await appClientStats(c.env.abdl_space_db)))
appClients.get('/users', async c => {
  const rawVersion = c.req.query('version_code') || 'all'
  const version = rawVersion === 'all' ? 'all' : rawVersion === 'missing' ? null : parseAppVersionCode(rawVersion)
  const rawPage = c.req.query('page') || '1'
  const rawLimit = c.req.query('limit') || '20'
  const page = Number(rawPage)
  const limit = Number(rawLimit)
  const q = (c.req.query('q') || '').trim()
  if ((version === null && rawVersion !== 'missing') || !/^[1-9][0-9]*$/.test(rawPage) || !/^[1-9][0-9]*$/.test(rawLimit)
    || !Number.isSafeInteger(page) || page > 1000000 || !Number.isSafeInteger(limit) || limit > 100 || q.length > 200) {
    return c.json({ error: 'Invalid version_code, pagination or search' }, 422)
  }
  try { return c.json(await appClientUsers(c.env.abdl_space_db, version, page, limit, q)) } catch (error) {
    console.error(JSON.stringify({ event: 'app_client_users_unavailable', error: String(error) }))
    return c.json({ error: 'App client statistics unavailable' }, 503)
  }
})

export default appClients
