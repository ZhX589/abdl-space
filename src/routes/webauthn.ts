import { Hono } from 'hono'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'
import { signJWT } from '../lib/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const webauthn = new Hono<AppType>()

const rpName = 'ABDL Space'
const rpID = 'abdl-space.top'
const expectedOrigin = 'https://abdl-space.top'

const tokenCookieOptions = 'HttpOnly; Secure; SameSite=None; Domain=.abdl-space.top; Path=/; Max-Age=604800'

// ============================================================
// POST /register/options — 生成注册选项（需登录）
// ============================================================
webauthn.post('/register/options', authMiddleware, async (c) => {
  const user = c.get('user')
  const db = c.env.abdl_space_db

  const existingCredentials = await query<{ id: string; transports: string }>(
    db, 'SELECT id, transports FROM passkeys WHERE user_id = ?', [user.sub]
  )

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.username,
    attestationType: 'none',
    excludeCredentials: existingCredentials.map(cred => ({
      id: cred.id,
      transports: cred.transports ? JSON.parse(cred.transports) : undefined,
    })),
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'preferred',
      userVerification: 'required',
    },
  })

  return c.json(options)
})

// ============================================================
// POST /register/verify — 验证注册响应（需登录）
// ============================================================
webauthn.post('/register/verify', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const db = c.env.abdl_space_db

  let verification
  try {
    verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: body.challenge,
      expectedOrigin,
      expectedRPID: rpID,
    })
  } catch (error) {
    return c.json({ verified: false, error: (error as Error).message }, 400)
  }

  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ verified: false }, 400)
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo

  await run(db,
    `INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, transports, nickname, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
    [
      credential.id,
      user.sub,
      Buffer.from(credential.publicKey),
      credential.counter,
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      JSON.stringify(credential.transports || []),
      body.nickname || null,
    ]
  )

  return c.json({ verified: true })
})

// ============================================================
// POST /authenticate/options — 生成认证选项（无需登录）
// ============================================================
webauthn.post('/authenticate/options', async (c) => {
  const body = await c.req.json<{ username?: string }>()
  const db = c.env.abdl_space_db

  let allowCredentials: { id: string; transports?: string[] }[] = []

  if (body.username) {
    const user = await queryOne<{ id: number }>(
      db, 'SELECT id FROM users WHERE username = ? OR email = ?', [body.username, body.username]
    )
    if (user) {
      const credentials = await query<{ id: string; transports: string }>(
        db, 'SELECT id, transports FROM passkeys WHERE user_id = ?', [user.id]
      )
      allowCredentials = credentials.map(cred => ({
        id: cred.id,
        transports: cred.transports ? JSON.parse(cred.transports) : undefined,
      }))
    }
  }

  // 防枚举：即使无凭证也返回正常选项（假挑战）
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials,
    userVerification: 'required',
  })

  return c.json(options)
})

// ============================================================
// POST /authenticate/verify — 验证认证响应（返回 JWT）
// ============================================================
webauthn.post('/authenticate/verify', async (c) => {
  const body = await c.req.json()
  const db = c.env.abdl_space_db

  const credential = await queryOne<{
    id: string; user_id: number; public_key: Uint8Array; counter: number; transports: string
  }>(
    db, 'SELECT * FROM passkeys WHERE id = ?', [body.id]
  )

  // 防枚举：凭证不存在时返回统一错误
  if (!credential) {
    return c.json({ verified: false, error: '验证失败' }, 401)
  }

  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: body.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(credential.public_key),
        counter: credential.counter,
        transports: credential.transports ? JSON.parse(credential.transports) : undefined,
      },
    })
  } catch (error) {
    return c.json({ verified: false, error: '验证失败' }, 401)
  }

  // 防枚举：验证失败时返回统一错误
  if (!verification.verified) {
    return c.json({ verified: false, error: '验证失败' }, 401)
  }

  // 更新 counter
  await run(db, 'UPDATE passkeys SET counter = ?, last_used_at = unixepoch() WHERE id = ?',
    [verification.authenticationInfo.newCounter, credential.id]
  )

  // 获取用户信息并签发 JWT
  const user = await queryOne<{ id: number; email: string; username: string; avatar: string; role: string }>(
    db, 'SELECT id, email, username, avatar, role FROM users WHERE id = ?', [credential.user_id]
  )

  if (!user) {
    return c.json({ verified: false, error: '用户不存在' }, 404)
  }

  const token = await signJWT(
    { sub: user.id, username: user.username, email: user.email, role: user.role },
    c.env.JWT_SECRET
  )

  c.header('Set-Cookie', `token=${token}; ${tokenCookieOptions}`)

  return c.json({
    verified: true,
    token,
    user: { id: user.id, email: user.email, username: user.username, avatar: user.avatar, role: user.role },
  })
})

// ============================================================
// GET /credentials — 获取用户凭证列表（需登录）
// ============================================================
webauthn.get('/credentials', authMiddleware, async (c) => {
  const user = c.get('user')
  const db = c.env.abdl_space_db

  const credentials = await query<{
    id: string; device_type: string; backed_up: number; nickname: string; created_at: number; last_used_at: number
  }>(
    db, 'SELECT id, device_type, backed_up, nickname, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at DESC',
    [user.sub]
  )

  return c.json({ credentials })
})

// ============================================================
// DELETE /credentials/:id — 删除凭证（需登录）
// ============================================================
webauthn.delete('/credentials/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const db = c.env.abdl_space_db

  await run(db, 'DELETE FROM passkeys WHERE id = ? AND user_id = ?', [id, user.sub])
  return c.json({ success: true })
})

export default webauthn
