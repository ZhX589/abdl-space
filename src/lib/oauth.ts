import type { D1Database } from '@cloudflare/workers-types'
import { query, queryOne, run } from './db.ts'

/* ============================================================
 * OAuth 2.0 Service — Authorization Code Grant + PKCE
 * ============================================================ */

/* ---- 配置 ---- */
export const OAUTH_CONFIG = {
  CODE_TTL_S:          600,       // 授权码有效期 10 分钟
  ACCESS_TTL_S:        3600,      // access_token 1 小时
  REFRESH_TTL_S:       2592000,   // refresh_token 30 天
  MAX_CLIENTS_PER_USER: 20,
}

export type GrantType = 'authorization_code' | 'refresh_token'
export type Scope = 'profile' | 'email' | 'read' | 'write' | 'admin'

export const ALL_SCOPES: Scope[] = ['profile', 'email', 'read', 'write', 'admin']
export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  profile: '读取你的基本信息（用户名、头像）',
  email:   '读取你的邮箱地址',
  read:    '读取你的数据',
  write:   '写入和修改你的数据',
  admin:   '管理操作（需要特别授权）',
}

/* ---- 工具 ---- */

function generateId(len = 24): string {
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function generateClientId(): string {
  return `oc_${generateId(16)}`
}

export function generateClientSecret(): string {
  return `ocs_${generateId(24)}`
}

export async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder()
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function nowS(): number {
  return Math.floor(Date.now() / 1000)
}

/* ---- 数据类型 ---- */

export interface OAuthClient {
  id: number
  client_id: string
  name: string
  description: string | null
  logo_url: string | null
  homepage_url: string | null
  redirect_uris: string[]
  scopes: string[]
  grant_types: string[]
  owner_id: number
  active: boolean
  created_at: number
  updated_at: number
}

export interface AuthorizationResult {
  code: string
  redirect_uri: string
}

export interface TokenResult {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token?: string
  scope: string
}

export interface IntrospectResult {
  active: boolean
  scope?: string
  client_id?: string
  username?: string
  exp?: number
  sub?: number
}

/* ============================================================
 * Client 管理
 * ============================================================ */

export async function createClient(
  db: D1Database,
  ownerId: number,
  data: {
    name: string
    description?: string
    logo_url?: string
    homepage_url?: string
    redirect_uris: string[]
    scopes?: string[]
  }
): Promise<{ client: OAuthClient; raw_secret: string }> {
  // 限制数量
  const count = await queryOne<{ cnt: number }>(
    db, 'SELECT COUNT(*) as cnt FROM oauth_clients WHERE owner_id = ?', [ownerId]
  )
  if (count && count.cnt >= OAUTH_CONFIG.MAX_CLIENTS_PER_USER) {
    throw new Error('MAX_CLIENTS')
  }

  const clientId = generateClientId()
  const rawSecret = generateClientSecret()
  const secretHash = await sha256(rawSecret)
  const now = nowS()

  const scopes = data.scopes?.filter(s => ALL_SCOPES.includes(s as Scope)) || ['profile']
  const redirectUris = data.redirect_uris.filter(u => {
    try { new URL(u); return true } catch { return false }
  })
  if (redirectUris.length === 0) throw new Error('INVALID_REDIRECT_URIS')

  await run(db,
    `INSERT INTO oauth_clients
      (client_id, client_secret, name, description, logo_url, homepage_url,
       redirect_uris, scopes, grant_types, owner_id, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      clientId, secretHash, data.name,
      data.description || null, data.logo_url || null, data.homepage_url || null,
      JSON.stringify(redirectUris), scopes.join(','),
      'authorization_code,refresh_token',
      ownerId, now, now,
    ]
  )

  const client: OAuthClient = {
    id: 0, client_id: clientId, name: data.name,
    description: data.description || null,
    logo_url: data.logo_url || null,
    homepage_url: data.homepage_url || null,
    redirect_uris: redirectUris, scopes,
    grant_types: ['authorization_code', 'refresh_token'],
    owner_id: ownerId, active: true,
    created_at: now, updated_at: now,
  }

  return { client, raw_secret: rawSecret }
}

export async function getClient(db: D1Database, clientId: string): Promise<OAuthClient | null> {
  const row = await queryOne<{
    id: number; client_id: string; name: string; description: string | null;
    logo_url: string | null; homepage_url: string | null;
    redirect_uris: string; scopes: string; grant_types: string;
    owner_id: number; active: number; created_at: number; updated_at: number
  }>(db, 'SELECT * FROM oauth_clients WHERE client_id = ?', [clientId])

  if (!row) return null
  return {
    id: row.id, client_id: row.client_id, name: row.name,
    description: row.description, logo_url: row.logo_url,
    homepage_url: row.homepage_url,
    redirect_uris: JSON.parse(row.redirect_uris),
    scopes: row.scopes.split(','),
    grant_types: row.grant_types.split(','),
    owner_id: row.owner_id, active: !!row.active,
    created_at: row.created_at, updated_at: row.updated_at,
  }
}

export async function getClientsByOwner(db: D1Database, ownerId: number): Promise<OAuthClient[]> {
  const rows = await query<{
    id: number; client_id: string; name: string; description: string | null;
    logo_url: string | null; homepage_url: string | null;
    redirect_uris: string; scopes: string; grant_types: string;
    owner_id: number; active: number; created_at: number; updated_at: number
  }>(db, 'SELECT * FROM oauth_clients WHERE owner_id = ? ORDER BY created_at DESC', [ownerId])

  return rows.map(row => ({
    id: row.id, client_id: row.client_id, name: row.name,
    description: row.description, logo_url: row.logo_url,
    homepage_url: row.homepage_url,
    redirect_uris: JSON.parse(row.redirect_uris),
    scopes: row.scopes.split(','),
    grant_types: row.grant_types.split(','),
    owner_id: row.owner_id, active: !!row.active,
    created_at: row.created_at, updated_at: row.updated_at,
  }))
}

export async function updateClient(
  db: D1Database, clientId: string, ownerId: number,
  data: Partial<{ name: string; description: string; logo_url: string; homepage_url: string; redirect_uris: string[]; scopes: string[]; active: boolean }>
): Promise<boolean> {
  const client = await getClient(db, clientId)
  if (!client || client.owner_id !== ownerId) return false

  const sets: string[] = []
  const params: unknown[] = []

  if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name) }
  if (data.description !== undefined) { sets.push('description = ?'); params.push(data.description) }
  if (data.logo_url !== undefined) { sets.push('logo_url = ?'); params.push(data.logo_url) }
  if (data.homepage_url !== undefined) { sets.push('homepage_url = ?'); params.push(data.homepage_url) }
  if (data.redirect_uris) { sets.push('redirect_uris = ?'); params.push(JSON.stringify(data.redirect_uris)) }
  if (data.scopes) { sets.push('scopes = ?'); params.push(data.scopes.filter(s => ALL_SCOPES.includes(s as Scope)).join(',')) }
  if (data.active !== undefined) { sets.push('active = ?'); params.push(data.active ? 1 : 0) }

  if (sets.length === 0) return true
  sets.push('updated_at = ?'); params.push(nowS())
  params.push(clientId)

  await run(db, `UPDATE oauth_clients SET ${sets.join(', ')} WHERE client_id = ?`, params)
  return true
}

export async function deleteClient(db: D1Database, clientId: string, ownerId: number): Promise<boolean> {
  const client = await getClient(db, clientId)
  if (!client || client.owner_id !== ownerId) return false
  // 同时吊销所有相关 token
  await run(db, 'UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ?', [clientId])
  await run(db, 'DELETE FROM oauth_clients WHERE client_id = ?', [clientId])
  return true
}

/** 验证 client_secret（登录时用） */
export async function verifyClientSecret(db: D1Database, clientId: string, rawSecret: string): Promise<boolean> {
  const row = await queryOne<{ client_secret: string; active: number }>(
    db, 'SELECT client_secret, active FROM oauth_clients WHERE client_id = ?', [clientId]
  )
  if (!row || !row.active) return false
  return row.client_secret === await sha256(rawSecret)
}

/* ============================================================
 * 授权码 Grant
 * ============================================================ */

export async function createAuthorizationCode(
  db: D1Database,
  clientId: string,
  userId: number,
  redirectUri: string,
  scopes: string,
  codeChallenge?: string,
  codeChallengeMethod?: string
): Promise<string> {
  const code = generateId(24)
  const now = nowS()

  await run(db,
    `INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at, used, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [code, clientId, userId, redirectUri, scopes, codeChallenge || null, codeChallengeMethod || null, now + OAUTH_CONFIG.CODE_TTL_S, now]
  )

  return code
}

export async function consumeAuthorizationCode(
  db: D1Database,
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier?: string
): Promise<{ valid: boolean; userId?: number; scopes?: string; error?: string }> {
  const row = await queryOne<{
    client_id: string; user_id: number; redirect_uri: string;
    scopes: string; code_challenge: string | null; code_challenge_method: string | null;
    expires_at: number; used: number
  }>(db, 'SELECT * FROM oauth_codes WHERE code = ?', [code])

  if (!row) return { valid: false, error: 'invalid_grant: code not found' }
  if (row.used) return { valid: false, error: 'invalid_grant: code already used' }
  if (nowS() > row.expires_at) return { valid: false, error: 'invalid_grant: code expired' }
  if (row.client_id !== clientId) return { valid: false, error: 'invalid_grant: client mismatch' }
  if (row.redirect_uri !== redirectUri) return { valid: false, error: 'invalid_grant: redirect_uri mismatch' }

  // PKCE 校验
  if (row.code_challenge) {
    if (!codeVerifier) return { valid: false, error: 'invalid_grant: code_verifier required' }
    const challenge = await sha256(codeVerifier)
    if (challenge !== row.code_challenge) return { valid: false, error: 'invalid_grant: code_verifier mismatch' }
  }

  // 标记已使用
  await run(db, 'UPDATE oauth_codes SET used = 1 WHERE code = ?', [code])

  return { valid: true, userId: row.user_id, scopes: row.scopes }
}

/* ============================================================
 * Token 签发 / 刷新 / 吊销
 * ============================================================ */

export async function issueToken(
  db: D1Database,
  clientId: string,
  userId: number,
  scopes: string
): Promise<TokenResult> {
  const accessToken = generateId(24)
  const refreshToken = generateId(24)
  const now = nowS()

  await run(db,
    `INSERT INTO oauth_tokens
      (access_token, refresh_token, client_id, user_id, scopes,
       access_expires_at, refresh_expires_at, revoked, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      accessToken, refreshToken, clientId, userId, scopes,
      now + OAUTH_CONFIG.ACCESS_TTL_S,
      now + OAUTH_CONFIG.REFRESH_TTL_S,
      now,
    ]
  )

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: OAUTH_CONFIG.ACCESS_TTL_S,
    refresh_token: refreshToken,
    scope: scopes,
  }
}

export async function refreshAccessToken(
  db: D1Database,
  refreshToken: string,
  clientId: string
): Promise<{ valid: boolean; result?: TokenResult; error?: string }> {
  const row = await queryOne<{
    client_id: string; user_id: number; scopes: string;
    refresh_expires_at: number; revoked: number
  }>(db, 'SELECT * FROM oauth_tokens WHERE refresh_token = ?', [refreshToken])

  if (!row) return { valid: false, error: 'invalid_grant: refresh_token not found' }
  if (row.revoked) return { valid: false, error: 'invalid_grant: token revoked' }
  if (row.client_id !== clientId) return { valid: false, error: 'invalid_grant: client mismatch' }
  if (nowS() > row.refresh_expires_at) return { valid: false, error: 'invalid_grant: refresh_token expired' }

  // 吊销旧 token
  await run(db, 'UPDATE oauth_tokens SET revoked = 1 WHERE refresh_token = ?', [refreshToken])

  // 签发新 token pair
  const result = await issueToken(db, clientId, row.user_id, row.scopes)
  return { valid: true, result }
}

export async function revokeToken(
  db: D1Database,
  token: string,
  tokenType: 'access_token' | 'refresh_token' = 'access_token'
): Promise<boolean> {
  const col = tokenType === 'access_token' ? 'access_token' : 'refresh_token'
  const result = await run(db, `UPDATE oauth_tokens SET revoked = 1 WHERE ${col} = ?`, [token])
  return (result.meta.changes ?? 0) > 0
}

export async function introspectToken(
  db: D1Database,
  accessToken: string,
  dbUser?: D1Database
): Promise<IntrospectResult> {
  const row = await queryOne<{
    client_id: string; user_id: number; scopes: string;
    access_expires_at: number; revoked: number
  }>(db, 'SELECT * FROM oauth_tokens WHERE access_token = ?', [accessToken])

  if (!row || row.revoked || nowS() > row.access_expires_at) {
    return { active: false }
  }

  // 尝试获取用户名
  let username: string | undefined
  if (dbUser) {
    const user = await queryOne<{ username: string }>(
      dbUser, 'SELECT username FROM users WHERE id = ?', [row.user_id]
    )
    username = user?.username
  }

  return {
    active: true,
    scope: row.scopes,
    client_id: row.client_id,
    username,
    exp: row.access_expires_at,
    sub: row.user_id,
  }
}

/* ============================================================
 * 用户已授权的 token 管理
 * ============================================================ */

export async function getUserTokens(db: D1Database, userId: number) {
  const rows = await query<{
    id: number; client_id: string; scopes: string;
    access_expires_at: number; refresh_expires_at: number | null;
    revoked: number; created_at: number
  }>(db,
    `SELECT t.*, c.name as client_name, c.logo_url
     FROM oauth_tokens t
     LEFT JOIN oauth_clients c ON t.client_id = c.client_id
     WHERE t.user_id = ? AND t.revoked = 0 AND t.refresh_expires_at > ?
     ORDER BY t.created_at DESC`,
    [userId, nowS()]
  )
  return rows
}

export async function revokeAllUserTokensForClient(db: D1Database, userId: number, clientId: string): Promise<number> {
  const result = await run(db,
    'UPDATE oauth_tokens SET revoked = 1 WHERE user_id = ? AND client_id = ? AND revoked = 0',
    [userId, clientId]
  )
  return result.meta.changes ?? 0
}
