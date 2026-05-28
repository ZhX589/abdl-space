import { Hono } from 'hono'
import type { Env } from '../types/index.ts'
import { queryOne, queryAll, run } from '../lib/db.ts'

const app = new Hono<{ Bindings: Env }>()

async function sha256(input: string): Promise<string> {
  const enc = new TextEncoder()
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(input))
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function decryptKey(cipherB64: string, password: string): Promise<string> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('key-split-salt-v2'), iterations: 600000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  )
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
  const prompt = usage.prompt_tokens || 0
  const completion = usage.completion_tokens || 0
  const total = usage.total_tokens || (prompt + completion)
  await run(env.abdl_space_db,
    'INSERT INTO ks_usage_logs (sub_key_id, channel_id, model, prompt_tokens, completion_tokens, total_tokens, status, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [subKeyId, channelId, model, prompt, completion, total, status, latencyMs])
  await run(env.abdl_space_db, 'UPDATE ks_sub_keys SET used_tokens = used_tokens + ?, last_used_at = unixepoch() WHERE id = ?', [total, subKeyId])
}

// 所有 /v1/* 请求走代理
app.all('/*', async (c) => {
  const startTime = Date.now()
  const path = c.req.path // /v1/chat/completions

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

  // 3. 负载均衡选择渠道
  let channelIds: number[] = []
  try { channelIds = JSON.parse(subKey.channel_ids || '[]') } catch {}

  let channels: any[]
  if (channelIds.length > 0) {
    const placeholders = channelIds.map(() => '?').join(',')
    channels = await queryAll(c.env.abdl_space_db, `SELECT * FROM ks_channels WHERE id IN (${placeholders}) AND enabled = 1`, channelIds)
  } else {
    channels = await queryAll(c.env.abdl_space_db, 'SELECT * FROM ks_channels WHERE enabled = 1', [])
  }

  const channel = pickChannel(channels)
  if (!channel) return c.json({ error: 'No available channel' }, 503)

  // 4. 转发请求（带重试）
  const bodyText = await c.req.text()
  let body: any; try { body = JSON.parse(bodyText) } catch { body = null }
  const isStream = body?.stream === true

  const tried = new Set<number>()
  let upstreamResp: Response | null = null
  let usedChannel = channel

  for (let attempt = 0; attempt < Math.min(channels.length, 3); attempt++) {
    const ch = attempt === 0 ? channel : pickChannel(channels.filter(c => !tried.has(c.id)))
    if (!ch) break
    tried.add(ch.id)

    const realKey = await decryptKey(ch.api_key_enc, c.env.ENCRYPT_KEY || c.env.JWT_SECRET)
    const upstreamUrl = `${ch.base_url}${path}`

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${realKey}`,
      'Content-Type': c.req.header('Content-Type') || 'application/json',
    }

    upstreamResp = await fetch(upstreamUrl, { method: c.req.method, headers, body: bodyText })
    if (upstreamResp.status < 500) { usedChannel = ch; break }
  }

  if (!upstreamResp) return c.json({ error: 'All channels failed' }, 502)

  // 5. 处理响应
  if (isStream) {
    const reader = upstreamResp.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let usage: any = null

    const stream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read()
        if (done) {
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
          if (usage) await recordUsage(c.env, subKey.id, usedChannel.id, body?.model || '', usage, 200, Date.now() - startTime)
          else await recordUsage(c.env, subKey.id, usedChannel.id, body?.model || '', { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, 200, Date.now() - startTime)
          controller.close(); return
        }
        buffer += decoder.decode(value, { stream: true })
        controller.enqueue(value)
      }
    })

    return new Response(stream, {
      status: upstreamResp.status,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
    })
  }

  // 非流式
  const respText = await upstreamResp.text()
  let usage: any = null; let model = ''
  try { const j = JSON.parse(respText); usage = j.usage; model = j.model || '' } catch {}
  if (usage) await recordUsage(c.env, subKey.id, usedChannel.id, model, usage, upstreamResp.status, Date.now() - startTime)

  return new Response(respText, {
    status: upstreamResp.status,
    headers: { 'Content-Type': 'application/json' }
  })
})

export default app
