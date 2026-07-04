/**
 * NBW S2S + OAuth 共享工具
 * nbwS2SRequest 被 routes/nbw.ts 和 lib/nbw-sync.ts 使用
 * getNBWConfig / isMobileOrigin 被 routes/nbw.ts 和 routes/auth.ts 共用
 */

import type { Env } from '../types/index.ts'

const NBW_BASE_URL = 'https://www.newbabyworld.top/api/abdl-space/api.php'

/**
 * NBW S2S API 请求封装
 * 所有参数通过 query string 传递，鉴权通过 X-ABDL-API-Key header
 */
export async function nbwS2SRequest(
  env: Env,
  action: string,
  params?: Record<string, string>
): Promise<{ code: number; msg: string; data: unknown }> {
  const query = new URLSearchParams({ action, ...params } as Record<string, string>)
  const res = await fetch(`${NBW_BASE_URL}?${query}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-ABDL-API-Key': env.NBW_API_KEY || '',
    },
  })
  return res.json()
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
