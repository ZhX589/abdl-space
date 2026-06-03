import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { adminMiddleware } from '../middleware/auth.ts'

// BUG-178: Encrypt API keys at rest using AES-GCM
async function deriveEncKey(password: string): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('abdl-api-keys'), iterations: 100000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  )
}

async function encryptValue(plaintext: string, password: string): Promise<string> {
  const key = await deriveEncKey(password)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  return btoa(String.fromCharCode(...iv)) + ':' + btoa(String.fromCharCode(...new Uint8Array(ct)))
}

async function decryptValue(cipherText: string, password: string): Promise<string> {
  const [ivB64, dataB64] = cipherText.split(':')
  const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0))
  const data = Uint8Array.from(atob(dataB64), c => c.charCodeAt(0))
  const key = await deriveEncKey(password)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data)
  return new TextDecoder().decode(pt)
}

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const apiKeys = new Hono<AppType>()

/**
 * GET /api/api_keys — 获取所有 API key（不返回 key_value 明文）
 */
apiKeys.get('/', adminMiddleware, async (c) => {
  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    'SELECT id, provider, label, created_at, updated_at FROM api_keys ORDER BY provider'
  )
  return c.json({ keys: rows.map(r => ({
    id: r.id,
    provider: r.provider,
    label: r.label ?? null,
    has_key: !!r.provider,
    created_at: r.created_at,
    updated_at: r.updated_at
  })) })
})

/**
 * POST /api/api_keys — 设置或更新 API key
 */
apiKeys.post('/', adminMiddleware, async (c) => {
  const body = await c.req.json<{ provider: string; key_value: string; label?: string }>()
  const { provider, key_value, label } = body

  if (!provider || !key_value) {
    return c.json({ error: 'provider and key_value are required' }, 400)
  }
  if (!['deepseek', 'openai', 'anthropic'].includes(provider)) {
    return c.json({ error: 'provider must be deepseek, openai, or anthropic' }, 400)
  }

  const existing = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM api_keys WHERE provider = ?',
    [provider]
  )

  const encPassword = c.env.ENCRYPT_KEY || c.env.JWT_SECRET
  const encryptedKey = await encryptValue(key_value, encPassword)

  if (existing) {
    await run(
      c.env.abdl_space_db,
      'UPDATE api_keys SET key_value = ?, label = ?, updated_at = CURRENT_TIMESTAMP WHERE provider = ?',
      [encryptedKey, label ?? null, provider]
    )
    return c.json({ message: `${provider} API key updated` })
  } else {
    await run(
      c.env.abdl_space_db,
      'INSERT INTO api_keys (provider, key_value, label) VALUES (?, ?, ?)',
      [provider, encryptedKey, label ?? null]
    )
    return c.json({ message: `${provider} API key saved` }, 201)
  }
})

/**
 * DELETE /api/api_keys/:provider — 删除 API key
 */
apiKeys.delete('/:provider', adminMiddleware, async (c) => {
  const provider = c.req.param('provider')

  const existing = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM api_keys WHERE provider = ?',
    [provider]
  )
  if (!existing) return c.json({ error: 'API key not found' }, 404)

  await run(c.env.abdl_space_db, 'DELETE FROM api_keys WHERE provider = ?', [provider])
  return c.json({ message: `${provider} API key deleted` })
})

export default apiKeys