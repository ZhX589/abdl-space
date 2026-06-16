/**
 * NBW OAuth 共享工具
 * getNBWConfig / isMobileOrigin 被 routes/nbw.ts 和 routes/auth.ts 共用
 */

import type { Env } from '../types/index.ts'

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
