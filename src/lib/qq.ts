const QQ_TOKEN_URL = 'https://graph.qq.com/oauth2.0/token'
const QQ_ME_URL = 'https://graph.qq.com/oauth2.0/me'
const QQ_USER_INFO_URL = 'https://graph.qq.com/user/get_user_info'
const QQ_HOST = 'graph.qq.com'
const QQ_REDIRECT_URI = 'auth://tauth.qq.com/'
const MAX_RESPONSE_BYTES = 32 * 1024
const MAX_NICKNAME_CODE_POINTS = 100
const MAX_AVATAR_LENGTH = 2048
const UNIONID_HMAC_DOMAIN = 'qq:unionid:v1'
const OPENID_HMAC_DOMAIN = 'qq:openid:v1'

export type QQErrorCode =
  | 'QQ_REQUEST_INVALID'
  | 'QQ_CREDENTIAL_INVALID'
  | 'QQ_UNIONID_REQUIRED'
  | 'QQ_UPSTREAM_UNAVAILABLE'

export class QQAuthError extends Error {
  readonly code: QQErrorCode
  readonly status: number

  constructor(code: QQErrorCode, status: number) {
    super(code)
    this.name = 'QQAuthError'
    this.code = code
    this.status = status
  }
}

export interface QQVerifiedIdentity {
  unionidHmac: string
  openidHmac: string
  nickname: string
  avatar: string
}

interface QQTokenResponse {
  access_token?: string
  client_id?: string
  openid?: string
  unionid?: string
  error?: number
}

interface QQUserInfoResponse {
  ret?: number
  nickname?: string
  figureurl_qq_1?: string
  figureurl_qq_2?: string
  figureurl_2?: string
  figureurl_1?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new QQAuthError('QQ_UPSTREAM_UNAVAILABLE', 502)

  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new QQAuthError('QQ_UPSTREAM_UNAVAILABLE', 502)
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof QQAuthError) throw error
    throw new QQAuthError('QQ_UPSTREAM_UNAVAILABLE', 502)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown
  } catch {
    throw new QQAuthError('QQ_UPSTREAM_UNAVAILABLE', 502)
  }
}

export function isForbiddenQQHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (normalized.includes(':')) {
    return normalized === '::'
      || normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized)
      || normalized.startsWith('2001:db8:')
  }

  const ipv4 = normalized.split('.').map(part => Number(part))
  if (ipv4.length !== 4 || ipv4.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false

  const [a, b, c] = ipv4
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  }

export function assertSafeQQUrl(url: URL): void {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || isForbiddenQQHostname(url.hostname) || url.hostname.toLowerCase() !== QQ_HOST) {
    throw new QQAuthError('QQ_REQUEST_INVALID', 400)
  }
}

async function qqFetch(url: URL, init?: RequestInit): Promise<Response> {
  assertSafeQQUrl(url)

  try {
    const response = await fetch(url, { ...init, redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      throw new QQAuthError('QQ_UPSTREAM_UNAVAILABLE', 502)
    }
    return response
  } catch (error) {
    if (error instanceof QQAuthError) throw error
    throw new QQAuthError('QQ_UPSTREAM_UNAVAILABLE', 502)
  }
}

function requiredString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function sanitizeNickname(value: string | undefined): string {
  return Array.from(value ?? '').slice(0, MAX_NICKNAME_CODE_POINTS).join('')
}

function sanitizeAvatar(value: string | undefined): string {
  if (!value || value.length > MAX_AVATAR_LENGTH) return ''
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

async function hmacHex(keyValue: string, domain: string, identifier: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyValue),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${domain}\0${identifier}`))
  return Array.from(new Uint8Array(signature)).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * 使用 Android QQ 的 loginServerSide authorization code 验证身份并返回不可逆数据库标识。
 */
export async function verifyQQAndroidCode(
  authorizationCode: string,
  requestedClientId: string,
  appId: string,
  appKey: string,
  identityHmacKey: string
): Promise<QQVerifiedIdentity> {
  if (!authorizationCode || authorizationCode.length > 4096 || requestedClientId !== appId) {
    throw new QQAuthError('QQ_REQUEST_INVALID', 400)
  }
  if (!appId || !appKey || !identityHmacKey) {
    throw new QQAuthError('QQ_UPSTREAM_UNAVAILABLE', 503)
  }

  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: appId,
    client_secret: appKey,
    code: authorizationCode,
    redirect_uri: QQ_REDIRECT_URI,
    fmt: 'json',
    need_openid: '1',
  })
  const tokenResponse = await qqFetch(new URL(QQ_TOKEN_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
  })
  const tokenUnknown = await readLimitedJson(tokenResponse)
  if (!tokenResponse.ok) {
    throw new QQAuthError(tokenResponse.status >= 500 || tokenResponse.status === 429 ? 'QQ_UPSTREAM_UNAVAILABLE' : 'QQ_CREDENTIAL_INVALID', tokenResponse.status >= 500 || tokenResponse.status === 429 ? 502 : 401)
  }
  if (!isRecord(tokenUnknown)) throw new QQAuthError('QQ_UPSTREAM_UNAVAILABLE', 502)
  const tokenData: QQTokenResponse = {
    access_token: requiredString(tokenUnknown, 'access_token'),
    client_id: requiredString(tokenUnknown, 'client_id'),
    openid: requiredString(tokenUnknown, 'openid'),
    unionid: requiredString(tokenUnknown, 'unionid'),
    error: typeof tokenUnknown.error === 'number' ? tokenUnknown.error : undefined,
  }
  if (tokenData.error || !tokenData.access_token) {
    throw new QQAuthError('QQ_CREDENTIAL_INVALID', 401)
  }

  const meUrl = new URL(QQ_ME_URL)
  meUrl.searchParams.set('access_token', tokenData.access_token)
  meUrl.searchParams.set('fmt', 'json')
  meUrl.searchParams.set('unionid', '1')
  const meResponse = await qqFetch(meUrl)
  const meUnknown = await readLimitedJson(meResponse)
  if (!meResponse.ok) {
    throw new QQAuthError(meResponse.status >= 500 || meResponse.status === 429 ? 'QQ_UPSTREAM_UNAVAILABLE' : 'QQ_CREDENTIAL_INVALID', meResponse.status >= 500 || meResponse.status === 429 ? 502 : 401)
  }
  if (!isRecord(meUnknown)) throw new QQAuthError('QQ_UPSTREAM_UNAVAILABLE', 502)
  const meData: QQTokenResponse = {
    client_id: requiredString(meUnknown, 'client_id'),
    openid: requiredString(meUnknown, 'openid'),
    unionid: requiredString(meUnknown, 'unionid'),
    error: typeof meUnknown.error === 'number' ? meUnknown.error : undefined,
  }
  if (meData.error || meData.client_id !== appId || (tokenData.client_id && tokenData.client_id !== appId)) {
    throw new QQAuthError('QQ_CREDENTIAL_INVALID', 401)
  }
  if (!meData.unionid) throw new QQAuthError('QQ_UNIONID_REQUIRED', 400)
  if (!meData.openid) throw new QQAuthError('QQ_CREDENTIAL_INVALID', 401)
  if (tokenData.openid && tokenData.openid !== meData.openid) {
    throw new QQAuthError('QQ_CREDENTIAL_INVALID', 401)
  }
  if (tokenData.unionid && tokenData.unionid !== meData.unionid) {
    throw new QQAuthError('QQ_CREDENTIAL_INVALID', 401)
  }

  const profileUrl = new URL(QQ_USER_INFO_URL)
  profileUrl.searchParams.set('access_token', tokenData.access_token)
  profileUrl.searchParams.set('oauth_consumer_key', appId)
  profileUrl.searchParams.set('openid', meData.openid)
  profileUrl.searchParams.set('fmt', 'json')
  const profileResponse = await qqFetch(profileUrl)
  const profileUnknown = await readLimitedJson(profileResponse)
  if (!profileResponse.ok || !isRecord(profileUnknown)) {
    throw new QQAuthError('QQ_UPSTREAM_UNAVAILABLE', 502)
  }
  const profile: QQUserInfoResponse = {
    ret: typeof profileUnknown.ret === 'number' ? profileUnknown.ret : undefined,
    nickname: requiredString(profileUnknown, 'nickname'),
    figureurl_qq_1: requiredString(profileUnknown, 'figureurl_qq_1'),
    figureurl_qq_2: requiredString(profileUnknown, 'figureurl_qq_2'),
    figureurl_2: requiredString(profileUnknown, 'figureurl_2'),
    figureurl_1: requiredString(profileUnknown, 'figureurl_1'),
  }
  if (profile.ret !== 0) throw new QQAuthError('QQ_UPSTREAM_UNAVAILABLE', 502)

  return {
    unionidHmac: await hmacHex(identityHmacKey, UNIONID_HMAC_DOMAIN, `${appId}\0${meData.unionid}`),
    openidHmac: await hmacHex(identityHmacKey, OPENID_HMAC_DOMAIN, `${appId}\0${meData.openid}`),
    nickname: sanitizeNickname(profile.nickname),
    avatar: sanitizeAvatar(profile.figureurl_qq_2 ?? profile.figureurl_qq_1 ?? profile.figureurl_2 ?? profile.figureurl_1),
  }
}
