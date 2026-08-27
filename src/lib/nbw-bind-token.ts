const DEFAULT_AVATAR = 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png'

function utf8ToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToUtf8(str: string): string {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4)
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export async function signNBWBindToken(data: { uid: string; username: string; avatar: string | null }, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Date.now()
  const payload = { ...data, type: 'nbw_bind', iat: now, exp: now + 10 * 60 * 1000 }
  const encoder = new TextEncoder()
  const headerB64 = utf8ToBase64Url(encoder.encode(JSON.stringify(header)))
  const payloadB64 = utf8ToBase64Url(encoder.encode(JSON.stringify(payload)))
  const signInput = `${headerB64}.${payloadB64}`
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signInput))
  return `${signInput}.${utf8ToBase64Url(new Uint8Array(signature))}`
}

export async function verifyNBWBindToken(token: string, secret: string): Promise<{ uid: string; username: string; avatar: string | null } | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const signInput = `${parts[0]}.${parts[1]}`
    const sig = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
    const valid = await crypto.subtle.verify('HMAC', key, sig, encoder.encode(signInput))
    if (!valid) return null
    const payload = JSON.parse(base64UrlToUtf8(parts[1]))
    if (payload.type !== 'nbw_bind' || !payload.exp || payload.exp < Date.now()) return null
    return { uid: payload.uid, username: payload.username, avatar: payload.avatar || DEFAULT_AVATAR }
  } catch { return null }
}

export function buildNBWRegisterPrefill(data: { uid?: string | number; username?: string; email?: string; avatar?: string | null }): { uid: string; username: string; email: string; avatar: string } {
  return {
    uid: String(data.uid || ''),
    username: data.username || '',
    email: data.email || '',
    avatar: data.avatar || DEFAULT_AVATAR,
  }
}
