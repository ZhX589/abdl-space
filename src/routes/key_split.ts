import { Hono } from 'hono'
import type { Env } from '../types/index.ts'
import { authMiddleware, adminMiddleware } from '../middleware/auth.ts'
import { queryOne, queryAll, run } from '../lib/db.ts'

const app = new Hono<{ Bindings: Env }>()

// ═══════════════ 工具函数 ═══════════════

async function sha256(input: string): Promise<string> {
  const enc = new TextEncoder()
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(input))
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function generateSubKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return 'sk-' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** 从主密钥派生 AES-256-GCM 密钥（HKDF，密钥分离） */
async function deriveAesKey(masterKey: string): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(masterKey), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('abdl-key-split-v1'), info: new Uint8Array() },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  )
}

async function encryptKey(plaintext: string, password: string): Promise<string> {
  const key = await deriveAesKey(password)
  const enc = new TextEncoder()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext))
  const combined = new Uint8Array(iv.length + new Uint8Array(ct).length)
  combined.set(iv); combined.set(new Uint8Array(ct), iv.length)
  return btoa(String.fromCharCode(...combined))
}

async function decryptKey(cipherB64: string, password: string): Promise<string> {
  const key = await deriveAesKey(password)
  const combined = new Uint8Array(atob(cipherB64).split('').map(c => c.charCodeAt(0)))
  const iv = combined.slice(0, 12); const ct = combined.slice(12)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  return new TextDecoder().decode(pt)
}

function pickChannel(channels: any[]): any | null {
  if (!channels.length) return null
  if (channels.length === 1) return channels[0]
  return channels[Math.floor(Math.random() * channels.length)]
}

/** URL 验证：仅允许 http/https，禁止内网地址 */
function validateBaseUrl(raw: string): string | null {
  try {
    const cleaned = raw.replace(/\/+$/, '').replace(/\/v1$/, '')
    const u = new URL(cleaned)
    if (!['http:', 'https:'].includes(u.protocol)) return null
    if (/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.|::1|localhost)/i.test(u.hostname)) return null
    return u.toString().replace(/\/+$/, '')
  } catch { return null }
}

// ═══════════════ 渠道管理 ═══════════════

app.get('/channels', authMiddleware, async (c) => {
  const user = c.get('user')
  const rows = await queryAll(c.env.abdl_space_db, 'SELECT * FROM ks_channels WHERE owner_id = ? ORDER BY id DESC', [user.sub])
  return c.json(rows.map((r: any) => ({ ...r, api_key_enc: r.api_key_enc ? '***' : '' })))
})

app.post('/channels', authMiddleware, async (c) => {
  try {
    const user = c.get('user')
    const { name, base_url, api_key, models } = await c.req.json()
    if (!name || !base_url || !api_key) return c.json({ error: 'name, base_url, api_key required' }, 400)
    if (name.length > 100) return c.json({ error: 'name too long (max 100)' }, 400)
    const safeUrl = validateBaseUrl(base_url)
    if (!safeUrl) return c.json({ error: 'Invalid base_url: must be http(s) and not a private address' }, 400)
    const encKey = await encryptKey(api_key, c.env.ENCRYPT_KEY || c.env.JWT_SECRET)
    const result = await run(c.env.abdl_space_db,
      'INSERT INTO ks_channels (owner_id, name, base_url, api_key_enc, models) VALUES (?, ?, ?, ?, ?)',
      [user.sub, name, safeUrl, encKey, JSON.stringify(models || [])])
    return c.json({ id: result.meta.last_row_id }, 201)
  } catch (e) {
    console.error('POST /channels error:', e)
    return c.json({ error: 'Internal error' }, 500)
  }
})

app.put('/channels/:id', authMiddleware, async (c) => {
  try {
    const user = c.get('user')
    const id = c.req.param('id')
    const body = await c.req.json()
    const sets: string[] = []; const vals: any[] = []
    if (body.name !== undefined) {
      if (body.name.length > 100) return c.json({ error: 'name too long (max 100)' }, 400)
      sets.push('name = ?'); vals.push(body.name)
    }
    if (body.base_url !== undefined) {
      const safeUrl = validateBaseUrl(body.base_url)
      if (!safeUrl) return c.json({ error: 'Invalid base_url' }, 400)
      sets.push('base_url = ?'); vals.push(safeUrl)
    }
    if (body.api_key !== undefined) { sets.push('api_key_enc = ?'); vals.push(await encryptKey(body.api_key, c.env.ENCRYPT_KEY || c.env.JWT_SECRET)) }
    if (body.models !== undefined) { sets.push('models = ?'); vals.push(JSON.stringify(body.models)) }
    if (body.enabled !== undefined) { sets.push('enabled = ?'); vals.push(body.enabled ? 1 : 0) }
    if (!sets.length) return c.json({ error: 'No fields' }, 400)
    sets.push('updated_at = unixepoch()')
    vals.push(id, user.sub)
    await run(c.env.abdl_space_db, `UPDATE ks_channels SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`, vals)
    return c.json({ ok: true })
  } catch (e) {
    console.error('PUT /channels error:', e)
    return c.json({ error: 'Internal error' }, 500)
  }
})

app.delete('/channels/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  await run(c.env.abdl_space_db, 'DELETE FROM ks_channels WHERE id = ? AND owner_id = ?', [c.req.param('id'), user.sub])
  return c.json({ ok: true })
})

app.post('/channels/:id/test', authMiddleware, async (c) => {
  const user = c.get('user')
  const ch = await queryOne(c.env.abdl_space_db, 'SELECT * FROM ks_channels WHERE id = ? AND owner_id = ?', [c.req.param('id'), user.sub])
  if (!ch) return c.json({ error: 'Not found' }, 404)
  try {
    const realKey = await decryptKey(ch.api_key_enc, c.env.ENCRYPT_KEY || c.env.JWT_SECRET)
    const baseUrl = ch.base_url.replace(/\/v1$/, '')
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${realKey}` },
      signal: AbortSignal.timeout(10000)
    })
    return c.json({ status: res.status, ok: res.ok })
  } catch (e: any) { return c.json({ error: e.message }, 500) }
})

// ═══════════════ 子 Key 管理 ═══════════════

app.get('/keys', authMiddleware, async (c) => {
  const user = c.get('user')
  const rows = await queryAll(c.env.abdl_space_db, 'SELECT * FROM ks_sub_keys WHERE owner_id = ? ORDER BY id DESC', [user.sub])
  // 不暴露 key_hash
  return c.json(rows.map((r: any) => ({ ...r, key_hash: undefined })))
})

app.post('/keys', authMiddleware, async (c) => {
  const user = c.get('user')
  const { name, channel_ids, quota_tokens, rate_limit } = await c.req.json()
  const rawKey = generateSubKey()
  const keyHash = await sha256(rawKey)
  const keyPrefix = rawKey.slice(0, 11)
  await run(c.env.abdl_space_db,
    'INSERT INTO ks_sub_keys (key_hash, key_prefix, name, channel_ids, quota_tokens, rate_limit, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [keyHash, keyPrefix, name || '', JSON.stringify(channel_ids || []), quota_tokens ?? -1, rate_limit ?? 60, user.sub])
  return c.json({ key: rawKey, prefix: keyPrefix, name }, 201)
})

app.put('/keys/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json()
  const sets: string[] = []; const vals: any[] = []
  if (body.name !== undefined) { sets.push('name = ?'); vals.push(body.name) }
  if (body.channel_ids !== undefined) { sets.push('channel_ids = ?'); vals.push(JSON.stringify(body.channel_ids)) }
  if (body.quota_tokens !== undefined) { sets.push('quota_tokens = ?'); vals.push(body.quota_tokens) }
  if (body.rate_limit !== undefined) { sets.push('rate_limit = ?'); vals.push(body.rate_limit) }
  if (body.enabled !== undefined) { sets.push('enabled = ?'); vals.push(body.enabled ? 1 : 0) }
  if (!sets.length) return c.json({ error: 'No fields' }, 400)
  sets.push('updated_at = unixepoch()')
  vals.push(id, user.sub)
  await run(c.env.abdl_space_db, `UPDATE ks_sub_keys SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`, vals)
  return c.json({ ok: true })
})

app.delete('/keys/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  await run(c.env.abdl_space_db, 'DELETE FROM ks_sub_keys WHERE id = ? AND owner_id = ?', [c.req.param('id'), user.sub])
  return c.json({ ok: true })
})

app.post('/keys/:id/reset', authMiddleware, async (c) => {
  const user = c.get('user')
  await run(c.env.abdl_space_db, 'UPDATE ks_sub_keys SET used_tokens = 0 WHERE id = ? AND owner_id = ?', [c.req.param('id'), user.sub])
  return c.json({ ok: true })
})

// ═══════════════ 用量统计 ═══════════════

app.get('/usage/stats', authMiddleware, async (c) => {
  const user = c.get('user')
  const days = parseInt(c.req.query('days') || '7')
  const since = Math.floor(Date.now() / 1000) - days * 86400

  const total = await queryOne(c.env.abdl_space_db,
    `SELECT SUM(ul.prompt_tokens) as prompt, SUM(ul.completion_tokens) as completion, SUM(ul.total_tokens) as total, COUNT(*) as requests,
           SUM(CASE WHEN ul.status >= 200 AND ul.status < 400 THEN 1 ELSE 0 END) as success,
           ROUND(AVG(ul.latency_ms)) as avg_latency
     FROM ks_usage_logs ul JOIN ks_sub_keys sk ON ul.sub_key_id = sk.id WHERE sk.owner_id = ? AND ul.request_at >= ?`,
    [user.sub, since])

  const daily = await queryAll(c.env.abdl_space_db,
    `SELECT date(ul.request_at, 'unixepoch') as date, SUM(ul.total_tokens) as tokens, COUNT(*) as requests
     FROM ks_usage_logs ul JOIN ks_sub_keys sk ON ul.sub_key_id = sk.id WHERE sk.owner_id = ? AND ul.request_at >= ?
     GROUP BY date ORDER BY date`, [user.sub, since])

  const byKey = await queryAll(c.env.abdl_space_db,
    `SELECT sk.name, sk.key_prefix, SUM(ul.total_tokens) as tokens, COUNT(*) as requests
     FROM ks_usage_logs ul JOIN ks_sub_keys sk ON ul.sub_key_id = sk.id WHERE sk.owner_id = ? AND ul.request_at >= ?
     GROUP BY sk.id ORDER BY tokens DESC`, [user.sub, since])

  const byModel = await queryAll(c.env.abdl_space_db,
    `SELECT ul.model, SUM(ul.total_tokens) as tokens, COUNT(*) as requests
     FROM ks_usage_logs ul JOIN ks_sub_keys sk ON ul.sub_key_id = sk.id WHERE sk.owner_id = ? AND ul.request_at >= ?
     GROUP BY ul.model ORDER BY tokens DESC`, [user.sub, since])

  return c.json({ total, daily, byKey, byModel })
})

app.get('/usage/logs', authMiddleware, async (c) => {
  const user = c.get('user')
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200)
  const offset = (page - 1) * limit

  const logs = await queryAll(c.env.abdl_space_db,
    `SELECT ul.*, sk.name as key_name, sk.key_prefix, ch.name as channel_name
     FROM ks_usage_logs ul JOIN ks_sub_keys sk ON ul.sub_key_id = sk.id JOIN ks_channels ch ON ul.channel_id = ch.id
     WHERE sk.owner_id = ? ORDER BY ul.request_at DESC LIMIT ? OFFSET ?`, [user.sub, limit, offset])

  const count = await queryOne(c.env.abdl_space_db,
    'SELECT COUNT(*) as total FROM ks_usage_logs ul JOIN ks_sub_keys sk ON ul.sub_key_id = sk.id WHERE sk.owner_id = ?',
    [user.sub])

  return c.json({ logs, total: count?.total || 0, page, limit })
})

// ═══════════════ 仪表盘汇总 ═══════════════

app.get('/stats', authMiddleware, async (c) => {
  const user = c.get('user')
  const keyCount = await queryOne(c.env.abdl_space_db, 'SELECT COUNT(*) as count FROM ks_sub_keys WHERE owner_id = ?', [user.sub])
  const channelCount = await queryOne(c.env.abdl_space_db, 'SELECT COUNT(*) as count FROM ks_channels WHERE owner_id = ?', [user.sub])
  const totalTokens = await queryOne(c.env.abdl_space_db,
    `SELECT SUM(ul.total_tokens) as total FROM ks_usage_logs ul JOIN ks_sub_keys sk ON ul.sub_key_id = sk.id WHERE sk.owner_id = ?`, [user.sub])
  return c.json({
    subKeys: keyCount?.count || 0,
    channels: channelCount?.count || 0,
    totalTokens: totalTokens?.total || 0
  })
})

export default app
