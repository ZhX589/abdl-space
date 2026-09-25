import { Hono } from 'hono'
import { signJWT } from '../lib/auth.ts'
import { queryOne } from '../lib/db.ts'
import { QQAuthError, verifyQQAndroidCode } from '../lib/qq.ts'
import { rateLimit } from '../lib/rate-limit.ts'
import { authMiddleware } from '../middleware/auth.ts'
import type { Env, JWTPayload } from '../types/index.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

type QQRouteError =
  | 'QQ_REQUEST_INVALID'
  | 'QQ_CREDENTIAL_INVALID'
  | 'QQ_UNIONID_REQUIRED'
  | 'QQ_ACCOUNT_NOT_BOUND'
  | 'QQ_BINDING_EXISTS'
  | 'QQ_ALREADY_BOUND'
  | 'QQ_UNBIND_WOULD_LOCK_ACCOUNT'
  | 'QQ_UPSTREAM_UNAVAILABLE'
  | 'RATE_LIMITED'

interface QQBody {
  client_id?: string
  authorization_code?: string
}

interface QQIdentityRow {
  unionid_hmac: string
  user_id: number
  nickname: string
  avatar: string
}

interface LoginUserRow {
  id: number
  email: string
  username: string
  avatar: string | null
  role: string
}

interface QQAppSubjectRow {
  unionid_hmac: string
}

const qq = new Hono<AppType>()

function jsonError(c: { json: (body: { error: QQRouteError }, status: number) => Response }, code: QQRouteError, status: number): Response {
  return c.json({ error: code }, status)
}

async function readBody(c: { req: { json: <T>() => Promise<T> } }): Promise<QQBody | null> {
  try {
    const body = await c.req.json<QQBody>()
    if (!body || typeof body.client_id !== 'string' || typeof body.authorization_code !== 'string') return null
    return body
  } catch {
    return null
  }
}

async function verifyRequest(c: { env: Env }, body: QQBody) {
  const appId = c.env.QQ_ANDROID_APP_ID
  if (!appId || !c.env.QQ_ANDROID_APP_KEY || !c.env.QQ_IDENTITY_HMAC_KEY) {
    throw new QQAuthError('QQ_UPSTREAM_UNAVAILABLE', 503)
  }
  return verifyQQAndroidCode(
    body.authorization_code ?? '',
    body.client_id ?? '',
    appId,
    c.env.QQ_ANDROID_APP_KEY,
    c.env.QQ_IDENTITY_HMAC_KEY
  )
}

function mapQQError(c: { json: (body: { error: QQRouteError }, status: number) => Response }, error: unknown): Response {
  if (error instanceof QQAuthError) return jsonError(c, error.code, error.status)
  return jsonError(c, 'QQ_UPSTREAM_UNAVAILABLE', 502)
}

async function getAppSubject(c: { env: Env }, openidHmac: string): Promise<QQAppSubjectRow | null> {
  return queryOne<QQAppSubjectRow>(
    c.env.abdl_space_db,
    'SELECT unionid_hmac FROM qq_app_subjects WHERE app_id = ? AND openid_hmac = ?',
    [c.env.QQ_ANDROID_APP_ID, openidHmac]
  )
}

function appSubjectStatement(c: { env: Env }, openidHmac: string, unionidHmac: string) {
  return c.env.abdl_space_db.prepare(
    `INSERT INTO qq_app_subjects (app_id, openid_hmac, unionid_hmac)
     VALUES (?, ?, ?)
     ON CONFLICT(app_id, openid_hmac) DO UPDATE SET updated_at = unixepoch()
     WHERE qq_app_subjects.unionid_hmac = excluded.unionid_hmac`
  ).bind(c.env.QQ_ANDROID_APP_ID, openidHmac, unionidHmac)
}

async function appSubjectMatches(c: { env: Env }, openidHmac: string, unionidHmac: string): Promise<boolean> {
  const stored = await getAppSubject(c, openidHmac)
  return stored?.unionid_hmac === unionidHmac
}

// Best-effort only: isolate-local memory is not a distributed or durable security boundary.
qq.use('/android/exchange', rateLimit('qq-android-exchange', 60_000, 20))
qq.use('/android/bind', rateLimit('qq-android-bind', 60_000, 15))

/** Android QQ 登录：已绑定则签发 ABDL token，未绑定仅返回稳定状态。 */
qq.post('/android/exchange', async (c) => {
  const body = await readBody(c)
  if (!body) return jsonError(c, 'QQ_REQUEST_INVALID', 400)

  try {
    const verified = await verifyRequest(c, body)
    const appSubject = await getAppSubject(c, verified.openidHmac)
    if (appSubject && appSubject.unionid_hmac !== verified.unionidHmac) {
      return jsonError(c, 'QQ_CREDENTIAL_INVALID', 401)
    }

    const identity = await queryOne<QQIdentityRow>(
      c.env.abdl_space_db,
      'SELECT unionid_hmac, user_id, nickname, avatar FROM qq_identities WHERE unionid_hmac = ?',
      [verified.unionidHmac]
    )
    if (!identity) {
      const result = await appSubjectStatement(c, verified.openidHmac, verified.unionidHmac).run()
      if (!result.success || !(await appSubjectMatches(c, verified.openidHmac, verified.unionidHmac))) {
        return jsonError(c, 'QQ_CREDENTIAL_INVALID', 401)
      }
      return c.json({ action: 'not_bound', code: 'QQ_ACCOUNT_NOT_BOUND' as const }, 200)
    }

    const user = await queryOne<LoginUserRow>(
      c.env.abdl_space_db,
      'SELECT id, email, username, avatar, role FROM users WHERE id = ?',
      [identity.user_id]
    )
    if (!user) return jsonError(c, 'QQ_CREDENTIAL_INVALID', 401)

    await c.env.abdl_space_db.batch([
      c.env.abdl_space_db.prepare(
        'UPDATE qq_identities SET nickname = ?, avatar = ?, updated_at = unixepoch() WHERE unionid_hmac = ?'
      ).bind(verified.nickname, verified.avatar, verified.unionidHmac),
      appSubjectStatement(c, verified.openidHmac, verified.unionidHmac),
    ])

    const token = await signJWT(
      { sub: user.id, username: user.username, email: user.email, role: user.role },
      c.env.JWT_SECRET
    )
    return c.json({
      action: 'login' as const,
      token,
      user: { id: user.id, email: user.email, username: user.username, avatar: user.avatar, role: user.role },
    })
  } catch (error) {
    return mapQQError(c, error)
  }
})

/** 将重新验证的 QQ 身份绑定到当前 ABDL 用户。 */
qq.post('/android/bind', authMiddleware, async (c) => {
  const body = await readBody(c)
  if (!body) return jsonError(c, 'QQ_REQUEST_INVALID', 400)
  const currentUser = c.get('user')

  try {
    const verified = await verifyRequest(c, body)
    const [currentBinding, qqBinding, appSubject] = await Promise.all([
      queryOne<QQIdentityRow>(
        c.env.abdl_space_db,
        'SELECT unionid_hmac, user_id, nickname, avatar FROM qq_identities WHERE user_id = ?',
        [currentUser.sub]
      ),
      queryOne<QQIdentityRow>(
        c.env.abdl_space_db,
        'SELECT unionid_hmac, user_id, nickname, avatar FROM qq_identities WHERE unionid_hmac = ?',
        [verified.unionidHmac]
      ),
      getAppSubject(c, verified.openidHmac),
    ])

    if (appSubject && appSubject.unionid_hmac !== verified.unionidHmac) {
      return jsonError(c, 'QQ_ALREADY_BOUND', 409)
    }
    if (currentBinding && currentBinding.unionid_hmac !== verified.unionidHmac) {
      return jsonError(c, 'QQ_BINDING_EXISTS', 409)
    }
    if (qqBinding && qqBinding.user_id !== currentUser.sub) {
      return jsonError(c, 'QQ_ALREADY_BOUND', 409)
    }

    await c.env.abdl_space_db.batch([
      appSubjectStatement(c, verified.openidHmac, verified.unionidHmac),
      c.env.abdl_space_db.prepare(
        `INSERT INTO qq_identities (unionid_hmac, user_id, nickname, avatar)
         SELECT ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM qq_app_subjects WHERE app_id = ? AND openid_hmac = ? AND unionid_hmac = ?
         )
         ON CONFLICT(unionid_hmac) DO UPDATE SET nickname = excluded.nickname, avatar = excluded.avatar, updated_at = unixepoch()`
      ).bind(
        verified.unionidHmac,
        currentUser.sub,
        verified.nickname,
        verified.avatar,
        c.env.QQ_ANDROID_APP_ID,
        verified.openidHmac,
        verified.unionidHmac
      ),
    ])
    if (!(await appSubjectMatches(c, verified.openidHmac, verified.unionidHmac))) {
      return jsonError(c, 'QQ_ALREADY_BOUND', 409)
    }
    const storedBinding = await queryOne<QQIdentityRow>(
      c.env.abdl_space_db,
      'SELECT unionid_hmac, user_id, nickname, avatar FROM qq_identities WHERE unionid_hmac = ?',
      [verified.unionidHmac]
    )
    if (!storedBinding || storedBinding.user_id !== currentUser.sub) {
      return jsonError(c, 'QQ_ALREADY_BOUND', 409)
    }

    return c.json({ bound: true, nickname: verified.nickname, avatar: verified.avatar })
  } catch (error) {
    return mapQQError(c, error)
  }
})

/** 返回当前用户的最小 QQ 绑定状态。 */
qq.get('/status', authMiddleware, async (c) => {
  try {
    const identity = await queryOne<{ nickname: string; avatar: string }>(
      c.env.abdl_space_db,
      'SELECT nickname, avatar FROM qq_identities WHERE user_id = ?',
      [c.get('user').sub]
    )
    return c.json(identity
      ? { bound: true, nickname: identity.nickname, avatar: identity.avatar }
      : { bound: false, nickname: null, avatar: null })
  } catch (error) {
    return mapQQError(c, error)
  }
})

/** 删除 QQ 绑定；如果这是唯一登录方式则拒绝。 */
qq.delete('/binding', authMiddleware, async (c) => {
  try {
    const userId = c.get('user').sub
    const identity = await queryOne<{ unionid_hmac: string }>(
      c.env.abdl_space_db,
      'SELECT unionid_hmac FROM qq_identities WHERE user_id = ?',
      [userId]
    )
    if (!identity) return c.json({ bound: false })

    const account = await queryOne<{
      password_hash: string | null
      email: string | null
      email_verified: number | null
      nbw_uid: string | null
    }>(
      c.env.abdl_space_db,
      'SELECT password_hash, email, email_verified, nbw_uid FROM users WHERE id = ?',
      [userId]
    )
    if (!account) return jsonError(c, 'QQ_CREDENTIAL_INVALID', 401)

    const hasPasswordEmailOrNBW = Boolean(account.password_hash)
      || Boolean(account.email && account.email_verified)
      || Boolean(account.nbw_uid)
    if (!hasPasswordEmailOrNBW) {
      let passkey: { id: string } | null
      try {
        passkey = await queryOne<{ id: string }>(
          c.env.abdl_space_db,
          'SELECT id FROM passkeys WHERE user_id = ? LIMIT 1',
          [userId]
        )
      } catch {
        return jsonError(c, 'QQ_UPSTREAM_UNAVAILABLE', 503)
      }
      if (!passkey) return jsonError(c, 'QQ_UNBIND_WOULD_LOCK_ACCOUNT', 409)
    }

    const deleteResults = await c.env.abdl_space_db.batch([
      c.env.abdl_space_db.prepare('DELETE FROM qq_app_subjects WHERE unionid_hmac = ?').bind(identity.unionid_hmac),
      c.env.abdl_space_db.prepare(
        'DELETE FROM qq_identities WHERE user_id = ? AND unionid_hmac = ?'
      ).bind(userId, identity.unionid_hmac),
    ])
    if (deleteResults.some(result => !result.success)) return jsonError(c, 'QQ_UPSTREAM_UNAVAILABLE', 502)
    return c.json({ bound: false })
  } catch (error) {
    if (error instanceof Error && error.message.includes('AUTH_LAST_LOGIN_METHOD')) {
      return jsonError(c, 'QQ_UNBIND_WOULD_LOCK_ACCOUNT', 409)
    }
    return mapQQError(c, error)
  }
})

export default qq
