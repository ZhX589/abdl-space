import { Hono } from 'hono'
import type { Env } from '../types/index.ts'
import { queryOne, queryAll, run } from '../lib/db.ts'

const app = new Hono<{ Bindings: Env }>()

async function sha256(input: string): Promise<string> {
  const enc = new TextEncoder()
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(input))
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** 从主密钥派生 AES-256-GCM 密钥（HKDF，密钥分离） */
async function deriveAesKey(masterKey: string): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(masterKey), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('abdl-key-split-v1'), info: new Uint8Array() },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  )
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

async function recordUsage(env: Env, subKeyId: number, channelId: number, model: string, usage: any, status: number, latencyMs: number) {
  try {
    const prompt = usage.prompt_tokens || 0
    const completion = usage.completion_tokens || 0
    const total = usage.total_tokens || (prompt + completion)
    await run(env.abdl_space_db,
      'INSERT INTO ks_usage_logs (sub_key_id, channel_id, model, prompt_tokens, completion_tokens, total_tokens, status, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [subKeyId, channelId, model, prompt, completion, total, status, latencyMs])
    await run(env.abdl_space_db, 'UPDATE ks_sub_keys SET used_tokens = used_tokens + ?, last_used_at = unixepoch() WHERE id = ?', [total, subKeyId])
  } catch (e) {
    console.error('recordUsage failed:', e)
  }
}

/** 只允许代理的 API 路径（精确前缀匹配） */
const ALLOWED_PATHS = ['/chat/completions', '/completions', '/embeddings', '/models', '/audio/transcriptions', '/audio/translations']

function isPathAllowed(path: string): boolean {
  // path 形如 /v1/chat/completions，去掉 /v1 前缀后精确匹配
  const apiPath = path.replace(/^\/v1/, '')
  return ALLOWED_PATHS.includes(apiPath)
}

/** 统一设置 CORS 头 */
function setCorsHeaders(c: any) {
  c.header('Access-Control-Allow-Origin', c.req.header('origin') || '*')
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  c.header('Access-Control-Max-Age', '86400')
}

// CORS 预检
app.options('/*', (c) => {
  setCorsHeaders(c)
  return c.body(null, 204)
})

// 所有 /v1/* 请求走代理
app.all('/*', async (c) => {
  const startTime = Date.now()
  const path = c.req.path // e.g. /v1/chat/completions

  // 设置 CORS 头
  c.header('Access-Control-Allow-Origin', c.req.header('origin') || '*')

  // 路径白名单（精确匹配）
  if (!isPathAllowed(path)) {
    return c.json({ error: 'Path not allowed' }, 403)
  }

  // 1. 提取子 Key
  const authHeader = c.req.header('Authorization') || ''
  const subKeyRaw = authHeader.replace('Bearer ', '')
  if (!subKeyRaw || subKeyRaw.length < 10) {
    return c.json({ error: 'Missing API key' }, 401)
  }

  const keyHash = await sha256(subKeyRaw)
  const subKey = await queryOne(c.env.abdl_space_db, 'SELECT * FROM ks_sub_keys WHERE key_hash = ? AND enabled = 1', [keyHash])
  if (!subKey) return c.json({ error: 'Invalid API key' }, 401)

  // 2. 检查额度
  if (subKey.quota_tokens > 0 && subKey.used_tokens >= subKey.quota_tokens) {
    return c.json({ error: 'Quota exceeded' }, 429)
  }

  // 3. 速率限制（原子 UPSERT，无竞态）
  const limit = subKey.rate_limit ?? 60
  if (limit > 0) {
    const minuteKey = `rate:${subKey.id}:${Math.floor(Date.now() / 60000)}`
    const rateResult = await run(c.env.abdl_space_db,
      `INSERT INTO rate_limits (key, count, window_start, expires_at)
       VALUES (?, 1, datetime("now"), datetime("now", "+2 minutes"))
       ON CONFLICT(key) DO UPDATE SET count = count + 1
       WHERE count < ?`,
      [minuteKey, limit])
    // changes === 0 表示 WHERE count < limit 不满足，被拦截
    if (rateResult.meta.changes === 0) {
      return c.json({ error: `Rate limit exceeded (${limit} req/min)` }, 429)
    }
  }

  // 4. 请求体大小限制
  const bodyText = await c.req.text()
  if (bodyText.length > 10 * 1024 * 1024) {
    return c.json({ error: 'Request body too large' }, 413)
  }

  // 5. 负载均衡选择渠道
  let channelIds: number[] = []
  try { channelIds = JSON.parse(subKey.channel_ids || '[]') } catch {}

  let channels: any[]
  if (channelIds.length > 0) {
    const placeholders = channelIds.map(() => '?').join(',')
    channels = await queryAll(c.env.abdl_space_db,
      `SELECT * FROM ks_channels WHERE id IN (${placeholders}) AND enabled = 1 AND owner_id = ?`,
      [...channelIds, subKey.owner_id])
  } else {
    channels = await queryAll(c.env.abdl_space_db,
      'SELECT * FROM ks_channels WHERE enabled = 1 AND owner_id = ?',
      [subKey.owner_id])
  }

  const channel = pickChannel(channels)
  if (!channel) return c.json({ error: 'No available channel' }, 503)

  // 6. 转发请求（带重试 + 超时）
  let body: any; try { body = JSON.parse(bodyText) } catch { body = null }
  const isStream = body?.stream === true

  const tried = new Set<number>()
  let upstreamResp: Response | null = null
  let usedChannel = channel

  for (let attempt = 0; attempt < Math.min(channels.length, 3); attempt++) {
    const ch = attempt === 0 ? channel : pickChannel(channels.filter(ch => !tried.has(ch.id)))
    if (!ch) break
    tried.add(ch.id)

    const realKey = await decryptKey(ch.api_key_enc, c.env.ENCRYPT_KEY || c.env.JWT_SECRET)
    const baseUrl = ch.base_url.replace(/\/v1$/, '')
    const upstreamUrl = `${baseUrl}${path}`

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${realKey}`,
      'Content-Type': c.req.header('Content-Type') || 'application/json',
    }

    try {
      upstreamResp = await fetch(upstreamUrl, {
        method: c.req.method,
        headers,
        body: bodyText,
        signal: AbortSignal.timeout(120000)
      })
      usedChannel = ch  // 任何成功响应都更新 usedChannel
      if (upstreamResp.status < 500) break
    } catch {
      continue
    }
  }

  if (!upstreamResp) return c.json({ error: 'All channels failed' }, 502)

  const corsOrigin = c.req.header('origin') || '*'

  // 7. 流式处理：仅当请求是 stream 且上游成功且返回 SSE 时才走流式
  const actuallyStream = isStream && upstreamResp.ok
    && (upstreamResp.headers.get('content-type')?.includes('text/event-stream') ?? false)

  if (actuallyStream) {
    const reader = upstreamResp.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let usage: any = null

    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            // 从最后几个 chunk 中提取 usage
            try {
              const lines = buffer.split('\n')
              for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trim()
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                  const json = JSON.parse(line.slice(6))
                  if (json.usage) { usage = json.usage; break }
                }
              }
            } catch {}
            const finalUsage = usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
            await recordUsage(c.env, subKey.id, usedChannel.id, body?.model || '', finalUsage, 200, Date.now() - startTime)
            controller.close(); return
          }
          buffer += decoder.decode(value, { stream: true })
          // 只保留最后 8KB 用于 usage 提取
          if (buffer.length > 8192) buffer = buffer.slice(-8192)
          controller.enqueue(value)
        } catch (e) {
          console.error('Stream pull error:', e)
          controller.error(e)
        }
      }
    })

    return new Response(stream, {
      status: upstreamResp.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': corsOrigin,
      }
    })
  }

  // 8. 非流式响应
  const respText = await upstreamResp.text()
  let usage: any = null; let model = ''
  try { const j = JSON.parse(respText); usage = j.usage; model = j.model || '' } catch {}
  // 始终记录用量（usage 为空时记 0）
  const finalUsage = usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  await recordUsage(c.env, subKey.id, usedChannel.id, model, finalUsage, upstreamResp.status, Date.now() - startTime)

  return new Response(respText, {
    status: upstreamResp.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
    }
  })
})

export default app
