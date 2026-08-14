import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Hono } from 'hono'
import { signJWT } from '../lib/auth.ts'
import novelAuthoring from './novel-authoring.ts'

const jwtSecret = 'novel-authoring-test-secret'

function createDatabase() {
	const database = new DatabaseSync(':memory:')
	database.exec('PRAGMA foreign_keys = ON;')
	database.exec(readFileSync(new URL('../../schemas/schema.sql', import.meta.url), 'utf8'))
	database.exec(readFileSync(new URL('../../migrations/oauth.sql', import.meta.url), 'utf8'))
	database.exec(readFileSync(new URL('../../migrations/0051_novel_authoring.sql', import.meta.url), 'utf8'))
	const prepare = (sql: string) => ({
		bind: (...params: unknown[]) => ({
			async all<T>() {
				return { success: true, results: database.prepare(sql).all(...params) as T[] }
			},
			async first<T>() {
				return database.prepare(sql).get(...params) as T | null
			},
			async run() {
				const result = database.prepare(sql).run(...params)
				return { success: true, meta: { changes: Number(result.changes) } }
			},
		}),
	})
	return { database, prepare }
}

function createApp() {
	const app = new Hono()
	app.route('/api/v1/novels/authoring', novelAuthoring)
	return app
}

async function bearer(sub: number) {
	return `Bearer ${await signJWT({ sub, username: `user${sub}`, email: `user${sub}@example.test`, role: 'user' }, jwtSecret)}`
}

async function request(db: ReturnType<typeof createDatabase>, sub: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
	return createApp().request(`/api/v1/novels/authoring${path}`, {
		method,
		headers: {
			Authorization: await bearer(sub),
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			...headers,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	}, { abdl_space_db: db, JWT_SECRET: jwtSecret } as never)
}

function insertUser(db: ReturnType<typeof createDatabase>, id: number, ageSeconds: number, withPost: boolean) {
	db.database.prepare(`
		INSERT INTO users (id, email, password_hash, username, created_at)
		VALUES (?, ?, 'hash', ?, datetime('now', ?))
	`).run(id, `user${id}@example.test`, `user${id}`, `-${ageSeconds} seconds`)
	if (withPost) db.database.prepare(`INSERT INTO posts (user_id, content) VALUES (?, 'qualifying post')`).run(id)
}

test('author eligibility requires both 72 hours and an existing post', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 - 1, true)
	insertUser(db, 2, 72 * 60 * 60 + 60, false)
	insertUser(db, 3, 72 * 60 * 60 + 60, true)

	const tooNew = await request(db, 1, 'GET', '/eligibility')
	const noPost = await request(db, 2, 'GET', '/eligibility')
	const eligible = await request(db, 3, 'GET', '/eligibility')

	assert.deepEqual(await tooNew.json(), assertEligibility(false, false, true, 'account_too_new'))
	assert.deepEqual(await noPost.json(), assertEligibility(false, true, false, 'post_required'))
	assert.deepEqual(await eligible.json(), assertEligibility(true, true, true))
})

test('creating a work rechecks eligibility and is idempotent per author', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	insertUser(db, 2, 72 * 60 * 60 + 60, false)
	const body = { title: '第一部作品', description: '只创建私有草稿。', category: 'fiction' }

	const denied = await request(db, 2, 'POST', '/works', body, { 'Idempotency-Key': 'denied-key' })
	assert.equal(denied.status, 403)
	assert.equal((await denied.json() as { code: string }).code, 'author_ineligible')

	const first = await request(db, 1, 'POST', '/works', body, { 'Idempotency-Key': 'stable-key' })
	const replay = await request(db, 1, 'POST', '/works', body, { 'Idempotency-Key': 'stable-key' })
	assert.equal(first.status, 201)
	assert.equal(replay.status, 200)
	const firstWork = await first.json() as { id: string, status: string }
	const replayWork = await replay.json() as { id: string }
	assert.equal(firstWork.id, replayWork.id)
	assert.equal(firstWork.status, 'draft')
	assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM novels').get()!.count, 1)
})

test('an existing idempotent result remains replayable after eligibility is lost', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const body = { title: '可靠重放', description: '', category: 'fiction' }
	const first = await request(db, 1, 'POST', '/works', body, { 'Idempotency-Key': 'replay-after-loss' })
	db.database.prepare('DELETE FROM posts WHERE user_id = 1').run()
	const replay = await request(db, 1, 'POST', '/works', body, { 'Idempotency-Key': 'replay-after-loss' })

	assert.equal(first.status, 201)
	assert.equal(replay.status, 200)
	assert.equal((await first.json() as { id: string }).id, (await replay.json() as { id: string }).id)
})

test('concurrent requests with one idempotency key converge on one work', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const body = { title: '并发作品', description: '', category: 'fiction' }
	const [left, right] = await Promise.all([
		request(db, 1, 'POST', '/works', body, { 'Idempotency-Key': 'concurrent-key' }),
		request(db, 1, 'POST', '/works', body, { 'Idempotency-Key': 'concurrent-key' }),
	])
	const leftWork = await left.json() as { id: string }
	const rightWork = await right.json() as { id: string }

	assert.deepEqual([left.status, right.status].sort(), [200, 201])
	assert.equal(leftWork.id, rightWork.id)
	assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM novels').get()!.count, 1)
})

test('the exact 72 hour boundary qualifies when a post exists', async () => {
	const db = createDatabase()
	db.database.prepare(`
		INSERT INTO users (id, email, password_hash, username, created_at)
		VALUES (1, 'boundary@example.test', 'hash', 'boundary', datetime('now', '-72 hours'))
	`).run()
	db.database.prepare(`INSERT INTO posts (user_id, content) VALUES (1, 'qualifying post')`).run()

	const response = await request(db, 1, 'GET', '/eligibility')
	assert.deepEqual(await response.json(), assertEligibility(true, true, true))
})

test('migration independently creates the authoring table, constraints, and indexes', () => {
	const database = new DatabaseSync(':memory:')
	database.exec('PRAGMA foreign_keys = ON;')
	database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);`)
	database.exec(readFileSync(new URL('../../migrations/0051_novel_authoring.sql', import.meta.url), 'utf8'))

	const columns = database.prepare(`PRAGMA table_info(novels)`).all().map(row => row.name)
	const indexes = database.prepare(`PRAGMA index_list(novels)`).all().map(row => row.name)
	const foreignKeys = database.prepare(`PRAGMA foreign_key_list(novels)`).all()
	assert.deepEqual(columns, ['id', 'author_id', 'title', 'description', 'category', 'status', 'idempotency_key', 'created_at', 'updated_at', 'deleted_at'])
	assert.equal(indexes.includes('idx_novels_author_idempotency'), true)
	assert.equal(indexes.includes('idx_novels_author_updated'), true)
	assert.equal(foreignKeys.some(row => row.table === 'users' && row.from === 'author_id'), true)
	assert.throws(() => database.prepare(`
		INSERT INTO novels (id, author_id, title, category) VALUES ('bad', 1, '', 'fiction')
	`).run())
})

test('authors retain access to existing drafts after eligibility is lost', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const created = await request(db, 1, 'POST', '/works', {
		title: '保留的草稿', description: '', category: 'fiction',
	}, { 'Idempotency-Key': 'retained-work' })
	assert.equal(created.status, 201)
	const work = await created.json() as { id: string }
	db.database.prepare('DELETE FROM posts WHERE user_id = 1').run()

	const list = await request(db, 1, 'GET', '/works')
	const detail = await request(db, 1, 'GET', `/works/${work.id}`)
	const denied = await request(db, 1, 'POST', '/works', {
		title: '不应创建', description: '', category: 'fiction',
	}, { 'Idempotency-Key': 'new-work' })

	assert.equal(list.status, 200)
	assert.equal((await list.json() as { items: unknown[] }).items.length, 1)
	assert.equal(detail.status, 200)
	assert.equal(denied.status, 403)
})

test('work details are owner isolated and never expose cover fields', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	insertUser(db, 2, 72 * 60 * 60 + 60, true)
	const created = await request(db, 1, 'POST', '/works', {
		title: '无封面作品', description: 'description', category: 'fiction',
	}, { 'Idempotency-Key': 'owner-work' })
	const work = await created.json() as { id: string }

	const ownerResponse = await request(db, 1, 'GET', `/works/${work.id}`)
	const otherResponse = await request(db, 2, 'GET', `/works/${work.id}`)
	const ownerWork = await ownerResponse.json() as Record<string, unknown>

	assert.equal(ownerResponse.status, 200)
	assert.equal(otherResponse.status, 404)
	assert.equal(Object.keys(ownerWork).some(key => key.includes('cover')), false)
})

function assertEligibility(eligible: boolean, accountAgeEligible: boolean, postEligible: boolean, reason?: string) {
	return {
		eligible,
		account_age_eligible: accountAgeEligible,
		post_eligible: postEligible,
		reasons: reason ? [reason] : [],
	}
}
