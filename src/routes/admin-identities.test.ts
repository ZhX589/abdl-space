import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Hono } from 'hono'
import { signJWT } from '../lib/auth.ts'
import { issueToken } from '../lib/oauth.ts'
import adminIdentities from './admin-identities.ts'

const JWT_SECRET = 'admin-identities-test-secret'
const APP_ID = '1905661071'

type Statement = { run: () => Promise<unknown> }

function makeD1(database: DatabaseSync) {
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    async first<T>() { return (database.prepare(sql).get(...params) ?? null) as T | null },
    async all<T>() { return { success: true, results: database.prepare(sql).all(...params) as T[] } },
    async run() {
      const result = database.prepare(sql).run(...params)
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }
    },
  })
  return {
    prepare: (sql: string) => statement(sql),
    async batch(items: Statement[]) {
      database.exec('BEGIN IMMEDIATE')
      try {
        const results = []
        for (const item of items) results.push(await item.run())
        database.exec('COMMIT')
        return results
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
}

function createFixture() {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys=ON')
  database.exec(readFileSync(new URL('../../schemas/schema.sql', import.meta.url), 'utf8'))
  database.exec(readFileSync(new URL('../../migrations/oauth.sql', import.meta.url), 'utf8'))
  database.exec(readFileSync(new URL('../../migrations/0038_webauthn.sql', import.meta.url), 'utf8'))
  database.exec(readFileSync(new URL('../../migrations/0067_qq_android_auth.sql', import.meta.url), 'utf8'))
  database.exec(readFileSync(new URL('../../migrations/0068_auth_login_method_guards.sql', import.meta.url), 'utf8'))
  database.exec(readFileSync(new URL('../../migrations/0069_admin_identity_management.sql', import.meta.url), 'utf8'))
  database.exec(`ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0;
    INSERT INTO users(id,email,password_hash,username,role,email_verified) VALUES
    (1,'admin@example.test','hash','admin','admin',1),
    (2,'user@example.test','hash','target','user',1),
    (3,'other@example.test','hash','other','user',1),
    (4,'admin2@example.test','hash','admin2','admin',1),
    (5,'sole@example.test','','sole','user',0);
    INSERT INTO qq_identities(unionid_hmac,user_id,nickname,avatar,created_at,updated_at) VALUES
    ('${'a'.repeat(64)}',2,'Target QQ','https://q.qlogo.cn/target',100,200),
    ('${'b'.repeat(64)}',4,'Admin QQ','http://unsafe.example/avatar',100,201),
    ('${'c'.repeat(64)}',5,'Sole QQ','https://q.qlogo.cn/sole',100,202);
    INSERT INTO qq_app_subjects(app_id,openid_hmac,unionid_hmac) VALUES
    ('${APP_ID}','${'d'.repeat(64)}','${'a'.repeat(64)}'),
    ('${APP_ID}','${'e'.repeat(64)}','${'b'.repeat(64)}'),
    ('${APP_ID}','${'f'.repeat(64)}','${'c'.repeat(64)}');
    INSERT INTO passkeys(id,user_id,public_key,last_used_at) VALUES('passkey-target',2,X'01',150);
    INSERT INTO oauth_clients(client_id,client_secret,name,redirect_uris,scopes,grant_types,token_endpoint_auth_method,owner_id,active,created_at,updated_at)
    VALUES('client','', 'Admin Console','["https://example.test/callback"]','read,write,admin','authorization_code,refresh_token','none',1,1,1,1);`)
  const env = { abdl_space_db: makeD1(database), JWT_SECRET }
  const app = new Hono()
  app.route('/api/admin/identities', adminIdentities)
  return { database, env, app }
}

async function jwt(userId = 1, role = 'admin') {
  return signJWT({ sub: userId, username: userId === 1 ? 'admin' : 'other', email: `${userId}@example.test`, role }, JWT_SECRET)
}

function adminHeaders(token: string, json = false) {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { 'Content-Type': 'application/json', Origin: 'https://abdl-space.top', 'Sec-Fetch-Site': 'same-origin' } : {}),
  }
}

async function unbind(fixture: ReturnType<typeof createFixture>, body: Record<string, unknown>, token: string) {
  return fixture.app.request('/api/admin/identities/users/2/qq/unbind', {
    method: 'POST', headers: adminHeaders(token, true), body: JSON.stringify(body),
  }, fixture.env as never)
}

test('identity detail minimizes fields, sanitizes avatar and reports login methods', async () => {
  const fixture = createFixture()
  try {
    const response = await fixture.app.request('/api/admin/identities/users/2', { headers: adminHeaders(await jwt()) }, fixture.env as never)
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    const text = await response.text()
    const body = JSON.parse(text) as Record<string, unknown>
    assert.doesNotMatch(text, /unionid|openid|hmac|access_token|refresh_token|app_id/i)
    const methods = body.methods as { password: boolean; verified_email: boolean; passkeys: { count: number }; qq: { avatar: string; can_unbind: boolean } }
    assert.equal(methods.password, true)
    assert.equal(methods.verified_email, true)
    assert.equal(methods.passkeys.count, 1)
    assert.equal(methods.qq.avatar, 'https://q.qlogo.cn/target')
    assert.equal(methods.qq.can_unbind, true)
  } finally { fixture.database.close() }
})

test('QQ admin unbind atomically audits, notifies, revokes and invalidates sessions', async () => {
  const fixture = createFixture()
  try {
    const token = await jwt()
    const operationId = crypto.randomUUID()
    const oauth = await issueToken(fixture.env.abdl_space_db as never, 'client', 2, 'read')
    const body = { operation_id: operationId, reason: 'suspected account recovery', confirm_username: 'target', expected_binding_version: 200 }
    const success = await unbind(fixture, body, token)
    assert.equal(success.status, 200, await success.clone().text())
    const saved = await success.json()
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM qq_identities WHERE user_id=2').get()?.count, 0)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM qq_app_subjects WHERE unionid_hmac=?').get('a'.repeat(64))?.count, 0)
    assert.equal(fixture.database.prepare('SELECT revoked FROM oauth_tokens WHERE access_token=?').get(oauth.access_token)?.revoked, 1)
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM notifications WHERE user_id=2 AND type='identity_security'").get()?.count, 1)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM admin_identity_audit WHERE operation_id=?').get(operationId)?.count, 1)
    assert.equal(typeof fixture.database.prepare('SELECT auth_invalid_before FROM users WHERE id=2').get()?.auth_invalid_before, 'number')

    const replay = await unbind(fixture, body, token)
    assert.equal(replay.status, 200)
    assert.deepEqual(await replay.json(), saved)
  } finally { fixture.database.close() }
})

test('QQ admin unbind rejects self, administrator targets and last-login failures', async () => {
  const fixture = createFixture()
  try {
    const token = await jwt()
    const self = await fixture.app.request('/api/admin/identities/users/1/qq/unbind', {
      method: 'POST', headers: adminHeaders(token, true), body: JSON.stringify({ operation_id: crypto.randomUUID(), reason: 'x', confirm_username: 'admin', expected_binding_version: 0 }),
    }, fixture.env as never)
    assert.equal(self.status, 403)
    const targetAdmin = await fixture.app.request('/api/admin/identities/users/4/qq/unbind', {
      method: 'POST', headers: adminHeaders(token, true), body: JSON.stringify({ operation_id: crypto.randomUUID(), reason: 'x', confirm_username: 'admin2', expected_binding_version: 201 }),
    }, fixture.env as never)
    assert.equal(targetAdmin.status, 403)
    const sole = await fixture.app.request('/api/admin/identities/users/5/qq/unbind', {
      method: 'POST', headers: adminHeaders(token, true), body: JSON.stringify({ operation_id: crypto.randomUUID(), reason: 'x', confirm_username: 'sole', expected_binding_version: 202 }),
    }, fixture.env as never)
    assert.equal(sole.status, 409)
  } finally { fixture.database.close() }
})
