import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Env, RegisterRequest, LoginRequest, LoginResponse, User, JWTPayload } from './types/index.ts'
import { hashPassword, verifyPassword, signJWT } from './lib/auth.ts'
import { queryOne, run } from './lib/db.ts'
import { authMiddleware } from './middleware/auth.ts'
import diapers from './routes/diapers.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const app = new Hono<AppType>()

app.use('*', cors())
app.use('*', logger())

app.get('/', (c) => c.json({ message: 'ABDL Space API' }))

app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

app.get('/api/health/db', async (c) => {
  try {
    const result = await c.env.abdl_space_db.prepare('SELECT 1 AS ok').first()
    return c.json({ status: 'ok', db: result })
  } catch {
    return c.json({ error: 'Database connection failed' }, 500)
  }
})

app.route('/api/diapers', diapers)

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

app.post('/api/auth/register', async (c) => {
  const body = await c.req.json<RegisterRequest>()
  const { email, password, username } = body

  if (!email || !password || !username) {
    return c.json({ error: 'email, password, and username are required' }, 400)
  }

  if (!EMAIL_REGEX.test(email)) {
    return c.json({ error: 'Invalid email format' }, 400)
  }

  if (password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400)
  }

  if (username.length < 2 || username.length > 32) {
    return c.json({ error: 'Username must be 2-32 characters' }, 400)
  }

  const existing = await queryOne<User>(
    c.env.abdl_space_db,
    'SELECT id FROM users WHERE email = ? OR username = ?',
    [email, username]
  )
  if (existing) {
    return c.json({ error: 'Email or username already exists' }, 409)
  }

  const passwordHash = await hashPassword(password)

  const result = await run(
    c.env.abdl_space_db,
    'INSERT INTO users (email, password_hash, username) VALUES (?, ?, ?)',
    [email, passwordHash, username]
  )

  const userId = result.meta.last_row_id as number
  const token = await signJWT({ sub: userId, username, email, role: 'user' }, c.env.JWT_SECRET)

  const response: LoginResponse = {
    token,
    user: {
      id: userId,
      email,
      username,
      avatar: null,
      role: 'user'
    }
  }
  return c.json(response, 201)
})

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json<LoginRequest>()
  const { login, password } = body

  if (!login || !password) {
    return c.json({ error: 'login and password are required' }, 400)
  }

  const user = await queryOne<User>(
    c.env.abdl_space_db,
    'SELECT id, email, username, password_hash, avatar, role FROM users WHERE email = ? OR username = ?',
    [login, login]
  )
  if (!user) {
    return c.json({ error: 'Invalid email or password' }, 401)
  }

  const valid = await verifyPassword(password, user.password_hash)
  if (!valid) {
    return c.json({ error: 'Invalid email or password' }, 401)
  }

  const token = await signJWT({ sub: user.id, username: user.username, email: user.email, role: user.role }, c.env.JWT_SECRET)

  const response: LoginResponse = {
    token,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      avatar: user.avatar,
      role: user.role
    }
  }
  return c.json(response)
})

app.get('/api/auth/me', authMiddleware, async (c) => {
  const payload = c.get('user')
  const user = await queryOne<User>(
    c.env.abdl_space_db,
    'SELECT id, email, username, avatar, role, age, region, weight, waist, hip, style_preference, bio, email_verified, created_at FROM users WHERE id = ?',
    [payload.sub]
  )
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }
  return c.json({
    id: user.id,
    email: user.email,
    username: user.username,
    avatar: user.avatar,
    role: user.role,
    age: user.age,
    region: user.region,
    weight: user.weight,
    waist: user.waist,
    hip: user.hip,
    style_preference: user.style_preference,
    bio: user.bio,
    email_verified: user.email_verified,
    created_at: user.created_at
  })
})

export default app
