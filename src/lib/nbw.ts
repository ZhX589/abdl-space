/**
 * NBW S2S + OAuth 共享工具
 * nbwS2SRequest 被 routes/nbw.ts 和 lib/nbw-sync.ts 使用
 * getNBWConfig / isMobileOrigin 被 routes/nbw.ts 和 routes/auth.ts 共用
 */

import type { Env } from '../types/index.ts'

const NBW_BASE_URL = 'https://www.newbabyworld.top/api/abdl-space/api.php'

type NBWUnavailableReason = 'http' | 'invalid_json' | 'invalid_response' | 'response_limit' | 'network' | 'timeout' | 'api'

/** Sanitized upstream failure: never retain response bodies, request parameters or credentials. */
export class NBWUnavailableError extends Error {
  readonly reason: NBWUnavailableReason
  readonly upstreamStatus: number | null

  constructor(reason: NBWUnavailableReason, upstreamStatus: number | null = null) {
    super('NBW service unavailable')
    this.name = 'NBWUnavailableError'
    this.reason = reason
    this.upstreamStatus = upstreamStatus
  }
}

async function boundedNBWJson(response: Response, maxBytes: number): Promise<unknown> {
  if (Number(response.headers.get('Content-Length')) > maxBytes) {
    void response.body?.cancel().catch(() => {})
    throw new NBWUnavailableError('response_limit', response.status)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new NBWUnavailableError('invalid_json', response.status)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) throw new NBWUnavailableError('response_limit', response.status)
      text += decoder.decode(value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** NBW S2S API: fixed HTTPS origin, no redirects, optional deadline/body cap for timeline reads only. */
export async function nbwS2SRequest(
  env: Env,
  action: string,
  params?: Record<string, string>,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ code: number; msg: string; data: unknown }> {
  const query = new URLSearchParams({ action, ...params } as Record<string, string>)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const request = async () => {
    const res = await fetch(`${NBW_BASE_URL}?${query}`, {
      method: 'GET',
      redirect: 'manual',
      ...(options.timeoutMs === undefined ? {} : { signal: controller.signal }),
      headers: {
        'Content-Type': 'application/json',
        'X-ABDL-API-Key': env.NBW_API_KEY || '',
      },
    })
    // Preserve valid 4xx API business errors, but never parse gateway HTML/text or follow redirects.
    if (res.redirected || (res.url && new URL(res.url).origin !== new URL(NBW_BASE_URL).origin)
      || (!res.ok && (res.status < 400 || res.status >= 500))) {
      void res.body?.cancel().catch(() => {})
      throw new NBWUnavailableError('http', res.status)
    }
    let value: unknown
    try { value = options.maxBytes === undefined ? await res.json() : await boundedNBWJson(res, options.maxBytes) } catch (error) {
      if (error instanceof NBWUnavailableError) throw error
      throw new NBWUnavailableError(controller.signal.aborted ? 'timeout' : 'invalid_json', res.status)
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NBWUnavailableError('invalid_response', res.status)
    const result = value as Record<string, unknown>
    if (typeof result.code !== 'number' || !Number.isInteger(result.code)
      || (result.msg !== undefined && typeof result.msg !== 'string') || (!res.ok && result.code === 200)) {
      throw new NBWUnavailableError('invalid_response', res.status)
    }
    return { code: result.code, msg: typeof result.msg === 'string' ? result.msg : '', data: result.data ?? null }
  }
  try {
    if (options.timeoutMs === undefined) return await request()
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new NBWUnavailableError('timeout'))
      }, options.timeoutMs)
    })
    return await Promise.race([request(), deadline])
  } catch (error) {
    if (error instanceof NBWUnavailableError) throw error
    throw new NBWUnavailableError(controller.signal.aborted ? 'timeout' : 'network')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (options.timeoutMs !== undefined) controller.abort()
  }
}

/**
 * NBW 图片上传（multipart/form-data）
 * upload_image 是唯一使用 POST + multipart 的 NBW 接口
 */
export async function nbwS2SUpload(
  env: Env,
  uid: string,
  file: Blob,
  filename = 'image.jpg'
): Promise<{ code: number; msg: string; data: { aid: number; url: string; width: number } | null }> {
  const form = new FormData()
  form.append('file', file, filename)
  const query = new URLSearchParams({ action: 'upload_image', uid })
  const res = await fetch(`${NBW_BASE_URL}?${query}`, {
    method: 'POST',
    headers: { 'X-ABDL-API-Key': env.NBW_API_KEY || '' },
    body: form,
  })
  return res.json()
}

export { NBW_BASE_URL }

/** 判断请求是否来自移动端（仅信任 Origin，精确匹配 hostname） */
export function isMobileOrigin(c: { req: { header: (name: string) => string | undefined } }): boolean {
  const origin = c.req.header('Origin') || ''
  if (!origin) return false
  try {
    return new URL(origin).hostname === 'm.abdl-space.top'
  } catch { return false }
}

/** 根据请求来源返回对应的 NBW OAuth 配置 */
export function getNBWConfig(c: { req: { header: (name: string) => string | undefined }; env: Env }): { clientId: string; clientSecret: string; redirectUri: string } {
  if (isMobileOrigin(c)) {
    return {
      clientId: c.env.NBW_CLIENT_ID_MOBILE || c.env.NBW_CLIENT_ID || '',
      clientSecret: c.env.NBW_CLIENT_SECRET_MOBILE || c.env.NBW_CLIENT_SECRET || '',
      redirectUri: c.env.NBW_REDIRECT_URI_MOBILE || c.env.NBW_REDIRECT_URI || '',
    }
  }
  return {
    clientId: c.env.NBW_CLIENT_ID || '',
    clientSecret: c.env.NBW_CLIENT_SECRET || '',
    redirectUri: c.env.NBW_REDIRECT_URI || '',
  }
}

/** 返回 App 专用的 NBW OAuth 配置（独立于桌面/移动端 Web） */
export function getAppNBWConfig(env: Env): { clientId: string; clientSecret: string; redirectUri: string } {
  return {
    clientId: env.NBW_CLIENT_ID_APP || '',
    clientSecret: env.NBW_CLIENT_SECRET_APP || '',
    redirectUri: env.NBW_REDIRECT_URI_APP || 'https://api.abdl-space.top/api/auth/nbw/mobile-callback',
  }
}
