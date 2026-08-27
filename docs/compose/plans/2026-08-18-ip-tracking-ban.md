# IP Tracking And Ban Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow administrators to permanently block all API access from IPs associated with a monitored user, including requests from the web, mobile site, and native app.

**Architecture:** Add D1 tables that hold monitored users, user-to-IP observations, and permanently banned IPs. A first-position Worker middleware rejects banned client IPs before routing, and the authentication middleware records a valid authenticated user's IP and immediately bans a newly observed IP for monitored users. The existing user-management rows expose one destructive admin action that activates this behavior.

**Tech Stack:** Cloudflare Workers, Hono, D1, TypeScript, React 18, Vite.

---

### Task 1: Persist monitored users and banned IPs

**Files:**
- Create: `migrations/0056_ip_tracking_bans.sql`
- Test: `src/routes/admin.test.ts`

- [ ] **Step 1: Write the failing migration test**

```ts
test('0056 creates IP tracking and permanent ban tables', () => {
  const database = new DatabaseSync(':memory:')
  database.exec(readFileSync(new URL('../../schemas/schema.sql', import.meta.url), 'utf8'))
  database.exec(readFileSync(new URL('../../migrations/0056_ip_tracking_bans.sql', import.meta.url), 'utf8'))

  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ip_tracked_users', 'user_ip_addresses', 'ip_bans') ORDER BY name").all().map((row: { name: string }) => row.name)
  assert.deepEqual(tables, ['ip_bans', 'ip_tracked_users', 'user_ip_addresses'])
})
```

- [ ] **Step 2: Run the targeted test and confirm failure**

Run: `npm test -- --test-name-pattern="0056 creates IP tracking"`

Expected: FAIL because migration `0056_ip_tracking_bans.sql` is absent.

- [ ] **Step 3: Create the minimal migration**

```sql
CREATE TABLE IF NOT EXISTS ip_tracked_users (
  user_id INTEGER PRIMARY KEY,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_ip_addresses (
  user_id INTEGER NOT NULL,
  ip TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ip)
);

CREATE TABLE IF NOT EXISTS ip_bans (
  ip TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

- [ ] **Step 4: Run the targeted test and confirm pass**

Run: `npm test -- --test-name-pattern="0056 creates IP tracking"`

Expected: PASS.

### Task 2: Block banned IPs globally and track authenticated requests

**Files:**
- Create: `src/middleware/ip-ban.ts`
- Modify: `src/index.ts:61-100`
- Modify: `src/middleware/auth.ts:95-145`
- Test: `src/api-worker.test.ts`

- [ ] **Step 1: Write failing middleware tests**

```ts
test('banned IP is denied before API routing', async () => {
  const response = await app.request('/api/health', { headers: { 'CF-Connecting-IP': '203.0.113.8' } }, bindingsWithBannedIp)
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'IP 已被永久封禁' })
})

test('a monitored authenticated user records and bans a newly seen IP', async () => {
  const response = await app.request('/api/auth/me', { headers: { Authorization: `Bearer ${monitoredUserToken}`, 'CF-Connecting-IP': '203.0.113.9' } }, bindings)
  assert.equal(response.status, 403)
  assert.equal(database.prepare('SELECT ip FROM ip_bans WHERE ip = ?').get('203.0.113.9')?.ip, '203.0.113.9')
})
```

- [ ] **Step 2: Run targeted tests and confirm failure**

Run: `npm test -- --test-name-pattern="banned IP|monitored authenticated"`

Expected: FAIL because no IP-ban middleware exists.

- [ ] **Step 3: Implement shared client IP and global ban middleware**

```ts
export function getClientIp(c: Context<AppType>): string | null {
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
  return ip && ip !== 'unknown' ? ip : null
}

export async function ipBanMiddleware(c: Context<AppType>, next: Next) {
  const ip = getClientIp(c)
  if (ip && await queryOne(c.env.abdl_space_db, 'SELECT ip FROM ip_bans WHERE ip = ?', [ip])) {
    return c.json({ error: 'IP 已被永久封禁' }, 403)
  }
  await next()
}
```

Register `ipBanMiddleware` as the first `app.use('*', ...)` in `src/index.ts`. In `authMiddleware`, after validating the current user, insert or update `user_ip_addresses`; if `ip_tracked_users` contains the user, insert the IP into `ip_bans` and return the same 403 response before reaching the route. Ignore missing client IPs rather than persisting `unknown`.

- [ ] **Step 4: Run targeted tests and confirm pass**

Run: `npm test -- --test-name-pattern="banned IP|monitored authenticated"`

Expected: PASS.

### Task 3: Add an idempotent administrator activation endpoint

**Files:**
- Modify: `src/routes/admin.ts:151-177`
- Modify: `src/routes/admin.test.ts`

- [ ] **Step 1: Write the failing endpoint test**

```ts
test('admin permanently tracks a user and bans every known IP', async () => {
  database.prepare('INSERT INTO user_ip_addresses (user_id, ip, first_seen_at, last_seen_at) VALUES (2, ?, 1, 1)').run('203.0.113.10')
  const response = await app.request('/api/admin/users/2/track-ip-ban', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, bindings as never)

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { tracked: true, bannedIps: 1 })
  assert.equal(database.prepare('SELECT user_id FROM ip_tracked_users WHERE user_id = 2').get()?.user_id, 2)
  assert.equal(database.prepare('SELECT ip FROM ip_bans WHERE ip = ?').get('203.0.113.10')?.ip, '203.0.113.10')
})
```

- [ ] **Step 2: Run targeted test and confirm failure**

Run: `npm test -- --test-name-pattern="permanently tracks a user"`

Expected: FAIL with 404.

- [ ] **Step 3: Implement the endpoint**

```ts
admin.post('/users/:id/track-ip-ban', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')
  const operator = c.get('user').sub
  const user = await queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM users WHERE id = ?', [id])
  if (!user) return c.json({ error: 'User not found' }, 404)

  const now = Math.floor(Date.now() / 1000)
  await run(c.env.abdl_space_db, 'INSERT OR IGNORE INTO ip_tracked_users (user_id, created_by, created_at) VALUES (?, ?, ?)', [id, operator, now])
  const knownIps = await query<{ ip: string }>(c.env.abdl_space_db, 'SELECT ip FROM user_ip_addresses WHERE user_id = ?', [id])
  for (const { ip } of knownIps) {
    await run(c.env.abdl_space_db, 'INSERT OR IGNORE INTO ip_bans (ip, user_id, created_by, created_at) VALUES (?, ?, ?, ?)', [ip, id, operator, now])
  }
  await run(c.env.abdl_space_db, 'UPDATE users SET banned = 1 WHERE id = ?', [id])
  return c.json({ tracked: true, bannedIps: knownIps.length })
})
```

- [ ] **Step 4: Run targeted test and confirm pass**

Run: `npm test -- --test-name-pattern="permanently tracks a user"`

Expected: PASS.

### Task 4: Expose the action in web and mobile admin pages

**Files:**
- Modify: `client/src/api.js:938-1071`
- Modify: `client/src/pages/AdminPage.jsx:114-122,299-315`
- Modify: `/home/ZYongX/projects/abdl-space-mobile/src/api.js:940-1054`
- Modify: `/home/ZYongX/projects/abdl-space-mobile/src/pages/AdminPage.jsx:108-116,292-307`

- [ ] **Step 1: Add the API client method in both frontends**

```js
trackAndBanUserIp: async (id) => {
  if (USE_API) return apiFetch(`/api/admin/users/${id}/track-ip-ban`, { method: 'POST' });
  return { tracked: true, bannedIps: 0 };
},
```

- [ ] **Step 2: Add a verified destructive action to both user lists**

```jsx
<button
  className="btn btn-sm"
  style={{ padding: '4px 10px', fontSize: '0.75rem', background: 'var(--danger)', color: 'white' }}
  onClick={() => handleTrackAndBanUserIp(u.id)}
  title="追踪并永久封禁 IP"
>
  <i className="fa-solid fa-user-lock" />
</button>
```

`handleTrackAndBanUserIp` must run through the existing `trigger` verification wrapper, call `adminAPI.trackAndBanUserIp(id)`, set the matching user as banned and IP-tracked in local state, and show `已开始追踪并永久封禁 IP（已封禁 ${data.bannedIps} 个已知 IP）`.

- [ ] **Step 3: Build both frontend projects**

Run: `npm run build`

Working directory: `client`

Expected: Vite build completes successfully.

Run: `npm run build`

Working directory: `/home/ZYongX/projects/abdl-space-mobile`

Expected: Vite build completes successfully.

### Task 5: Verify the complete feature

**Files:**
- Modify: `MODIFICATIONS.md`

- [ ] **Step 1: Run all API tests**

Run: `npm test`

Working directory: `/home/ZYongX/projects/git/abdl-space`

Expected: all test files pass.

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Working directory: `/home/ZYongX/projects/git/abdl-space`

Expected: no lint errors.

- [ ] **Step 3: Record the focused change**

Add a concise Chinese entry to the applicable project `MODIFICATIONS.md` files, noting API-level IP tracing and permanent blocking plus the synchronized mobile admin control.
