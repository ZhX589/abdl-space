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
	database.exec(readFileSync(new URL('../../migrations/0052_novel_structure.sql', import.meta.url), 'utf8'))
	database.exec(readFileSync(new URL('../../migrations/0053_novel_revisions.sql', import.meta.url), 'utf8'))
	database.exec(readFileSync(new URL('../../migrations/0054_novel_review_pipeline.sql', import.meta.url), 'utf8'))
	database.exec(readFileSync(new URL('../../migrations/0055_novel_publish.sql', import.meta.url), 'utf8'))
	const prepare = (sql: string) => ({
		bind: (...params: unknown[]) => ({
			_sql: sql,
			_params: params,
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
	const batch = async (statements: Array<{ _sql: string, _params: unknown[] }>) => {
		database.exec('BEGIN')
		try {
			const results = statements.map(statement => {
				const result = database.prepare(statement._sql).run(...statement._params)
				return { success: true, meta: { changes: Number(result.changes) } }
			})
			database.exec('COMMIT')
			return results
		} catch (error) {
			database.exec('ROLLBACK')
			throw error
		}
	}
	return { database, prepare, batch }
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
	insertUser(db, 1, 72 * 60 * 60 - 10, true)
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

test('volume and chapter structure is owner isolated, ordered, and idempotent', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	insertUser(db, 2, 72 * 60 * 60 + 60, true)
	const work = await createWork(db, 1, 'structure-work')

	const volume = await request(db, 1, 'POST', `/works/${work.id}/volumes`, { title: '第一卷' }, { 'Idempotency-Key': 'volume-1' })
	const replay = await request(db, 1, 'POST', `/works/${work.id}/volumes`, { title: '第一卷' }, { 'Idempotency-Key': 'volume-1' })
	assert.equal(volume.status, 201)
	assert.equal(replay.status, 200)
	const volumeBody = await volume.json() as { id: string }
	assert.equal(volumeBody.id, (await replay.json() as { id: string }).id)

	const chapter = await request(db, 1, 'POST', `/works/${work.id}/volumes/${volumeBody.id}/chapters`, { title: '第一章' }, { 'Idempotency-Key': 'chapter-1' })
	assert.equal(chapter.status, 201)
	const structure = await request(db, 1, 'GET', `/works/${work.id}/structure`)
	const other = await request(db, 2, 'GET', `/works/${work.id}/structure`)
	const body = await structure.json() as { volumes: Array<{ title: string, chapters: Array<{ title: string }> }> }
	assert.equal(body.volumes[0].title, '第一卷')
	assert.equal(body.volumes[0].chapters[0].title, '第一章')
	assert.equal(other.status, 404)
})

test('existing draft structure remains editable after eligibility loss but published structure is read only', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const work = await createWork(db, 1, 'eligibility-loss-structure')
	db.database.prepare('DELETE FROM posts WHERE user_id = 1').run()
	const allowed = await request(db, 1, 'POST', `/works/${work.id}/volumes`, { title: '资格失效后仍可编辑' }, { 'Idempotency-Key': 'allowed-volume' })
	assert.equal(allowed.status, 201)
	db.database.prepare(`UPDATE novels SET status = 'published' WHERE id = ?`).run(work.id)
	const denied = await request(db, 1, 'POST', `/works/${work.id}/volumes`, { title: '不应创建' }, { 'Idempotency-Key': 'denied-volume' })
	assert.equal(denied.status, 409)
	assert.equal((await denied.json() as { code: string }).code, 'work_not_editable')
})

test('volume and chapter titles and order can update while deletes are soft and safe', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const work = await createWork(db, 1, 'mutate-structure')
	const volumeResponse = await request(db, 1, 'POST', `/works/${work.id}/volumes`, { title: '旧卷名' }, { 'Idempotency-Key': 'mutate-volume' })
	const volume = await volumeResponse.json() as { id: string }
	const chapterResponse = await request(db, 1, 'POST', `/works/${work.id}/volumes/${volume.id}/chapters`, { title: '旧章名' }, { 'Idempotency-Key': 'mutate-chapter' })
	const chapter = await chapterResponse.json() as { id: string }

	const updatedVolume = await request(db, 1, 'PATCH', `/works/${work.id}/volumes/${volume.id}`, { sort_order: 20 })
	const renamedVolume = await request(db, 1, 'PATCH', `/works/${work.id}/volumes/${volume.id}`, { title: '新卷名' })
	const updatedChapter = await request(db, 1, 'PATCH', `/works/${work.id}/volumes/${volume.id}/chapters/${chapter.id}`, { sort_order: 10 })
	const renamedChapter = await request(db, 1, 'PATCH', `/works/${work.id}/volumes/${volume.id}/chapters/${chapter.id}`, { title: '新章名' })
	assert.equal(updatedVolume.status, 200)
	assert.equal(renamedVolume.status, 200)
	assert.equal(updatedChapter.status, 200)
	assert.equal(renamedChapter.status, 200)
	assert.equal((await renamedChapter.json() as { title: string }).title, '新章名')
	assert.equal((await updatedChapter.json() as { sort_order: number }).sort_order, 10)
	assert.equal((await updatedVolume.json() as { sort_order: number }).sort_order, 20)

	const nonEmptyDelete = await request(db, 1, 'DELETE', `/works/${work.id}/volumes/${volume.id}`)
	assert.equal(nonEmptyDelete.status, 409)
	assert.equal((await nonEmptyDelete.json() as { code: string }).code, 'volume_not_empty')
	assert.equal((await request(db, 1, 'DELETE', `/works/${work.id}/volumes/${volume.id}/chapters/${chapter.id}`)).status, 200)
	assert.equal((await request(db, 1, 'DELETE', `/works/${work.id}/volumes/${volume.id}`)).status, 200)
	const structure = await request(db, 1, 'GET', `/works/${work.id}/structure`)
	assert.deepEqual((await structure.json() as { volumes: unknown[] }).volumes, [])
})

test('0052 independently creates constrained volume and chapter tables', () => {
	const database = new DatabaseSync(':memory:')
	database.exec('PRAGMA foreign_keys = ON;')
	database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);`)
	database.exec(readFileSync(new URL('../../migrations/0051_novel_authoring.sql', import.meta.url), 'utf8'))
	database.exec(readFileSync(new URL('../../migrations/0052_novel_structure.sql', import.meta.url), 'utf8'))
	assert.deepEqual(database.prepare(`PRAGMA table_info(novel_volumes)`).all().map(row => row.name), ['id', 'novel_id', 'title', 'sort_order', 'idempotency_key', 'created_at', 'updated_at', 'deleted_at'])
	assert.deepEqual(database.prepare(`PRAGMA table_info(novel_chapters)`).all().map(row => row.name), ['id', 'novel_id', 'volume_id', 'title', 'sort_order', 'idempotency_key', 'created_at', 'updated_at', 'deleted_at'])
	assert.equal(database.prepare(`PRAGMA foreign_key_list(novel_chapters)`).all().some(row => row.table === 'novel_volumes'), true)
	database.prepare(`INSERT INTO users (id) VALUES (1), (2)`).run()
	database.prepare(`INSERT INTO novels (id, author_id, title, category) VALUES ('a', 1, 'A', 'fiction'), ('b', 2, 'B', 'fiction')`).run()
	database.prepare(`INSERT INTO novel_volumes (id, novel_id, title, sort_order) VALUES ('volume', 'a', '卷', 0)`).run()
	assert.throws(() => database.prepare(`INSERT INTO novel_chapters (id, novel_id, volume_id, title, sort_order) VALUES ('bad', 'b', 'volume', '章', 0)`).run())
	assert.throws(() => database.prepare(`INSERT INTO novel_volumes (id, novel_id, title, sort_order) VALUES ('negative', 'a', '卷', -1)`).run())
})

test('chapter revisions create idempotently and remain owner isolated', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	insertUser(db, 2, 72 * 60 * 60 + 60, true)
	const { work, volume, chapter } = await createStructure(db, 1, 'revision-create')
	const body = { body: '第一段\r\n第二段' }
	const first = await request(db, 1, 'POST', `/chapters/${chapter.id}/revisions`, body, { 'Idempotency-Key': 'create-revision' })
	const replay = await request(db, 1, 'POST', `/chapters/${chapter.id}/revisions`, body, { 'Idempotency-Key': 'create-revision' })
	assert.equal(first.status, 201)
	assert.equal(replay.status, 200)
	const revision = await first.json() as { id: string, body: string, version: number, status: string, chapter_id: string }
	assert.equal(revision.id, (await replay.json() as { id: string }).id)
	assert.equal(revision.body, '第一段\n第二段')
	assert.equal(revision.version, 1)
	assert.equal(revision.status, 'draft')
	assert.equal(revision.chapter_id, chapter.id)
	assert.equal((await request(db, 2, 'GET', `/revisions/${revision.id}`)).status, 404)
	assert.equal((await request(db, 1, 'GET', `/revisions/${revision.id}`)).status, 200)
	assert.equal(work.id.length > 0 && volume.id.length > 0, true)
})

test('draft updates use atomic base versions and return the server revision on conflict', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { chapter } = await createStructure(db, 1, 'revision-cas')
	const created = await request(db, 1, 'POST', `/chapters/${chapter.id}/revisions`, { body: 'v1' }, { 'Idempotency-Key': 'create-cas' })
	const revision = await created.json() as { id: string }

	const success = await request(db, 1, 'PUT', `/revisions/${revision.id}/draft`, { body: 'v2', base_version: 1 }, { 'Idempotency-Key': 'put-v2' })
	assert.equal(success.status, 200)
	assert.equal((await success.json() as { version: number, body: string }).version, 2)
	const conflict = await request(db, 1, 'PUT', `/revisions/${revision.id}/draft`, { body: 'stale', base_version: 1 }, { 'Idempotency-Key': 'stale-put' })
	assert.equal(conflict.status, 409)
	const conflictBody = await conflict.json() as { code: string, server_revision: { body: string, version: number } }
	assert.equal(conflictBody.code, 'revision_conflict')
	assert.deepEqual(conflictBody.server_revision, { id: revision.id, chapter_id: chapter.id, body: 'v2', status: 'draft', version: 2, created_at: conflictBody.server_revision.created_at, updated_at: conflictBody.server_revision.updated_at })
	const stored = db.database.prepare(`SELECT body, version FROM chapter_revisions WHERE id = ?`).get(revision.id)!
	assert.equal(stored.body, 'v2')
	assert.equal(stored.version, 2)
})

test('successful draft retries reuse their original response instead of becoming false conflicts', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { chapter } = await createStructure(db, 1, 'revision-idempotency')
	const revision = await (await request(db, 1, 'POST', `/chapters/${chapter.id}/revisions`, { body: 'v1' }, { 'Idempotency-Key': 'create-idem' })).json() as { id: string }
	const input = { body: 'confirmed', base_version: 1 }
	const first = await request(db, 1, 'PUT', `/revisions/${revision.id}/draft`, input, { 'Idempotency-Key': 'stable-update' })
	const replay = await request(db, 1, 'PUT', `/revisions/${revision.id}/draft`, input, { 'Idempotency-Key': 'stable-update' })
	assert.equal(first.status, 200)
	assert.equal(replay.status, 200)
	assert.deepEqual(await replay.json(), await first.json())
	assert.equal(db.database.prepare(`SELECT version FROM chapter_revisions WHERE id = ?`).get(revision.id)!.version, 2)
	const changedPayload = await request(db, 1, 'PUT', `/revisions/${revision.id}/draft`, { body: 'different', base_version: 1 }, { 'Idempotency-Key': 'stable-update' })
	assert.equal(changedPayload.status, 409)
	assert.equal((await changedPayload.json() as { code: string }).code, 'idempotency_conflict')
})

test('only one concurrent writer advances a revision and frozen revisions reject drafts', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { chapter } = await createStructure(db, 1, 'revision-concurrency')
	const revision = await (await request(db, 1, 'POST', `/chapters/${chapter.id}/revisions`, { body: 'v1' }, { 'Idempotency-Key': 'create-race' })).json() as { id: string }
	const [left, right] = await Promise.all([
		request(db, 1, 'PUT', `/revisions/${revision.id}/draft`, { body: 'left', base_version: 1 }, { 'Idempotency-Key': 'left' }),
		request(db, 1, 'PUT', `/revisions/${revision.id}/draft`, { body: 'right', base_version: 1 }, { 'Idempotency-Key': 'right' }),
	])
	assert.deepEqual([left.status, right.status].sort(), [200, 409])
	assert.equal(db.database.prepare(`SELECT version FROM chapter_revisions WHERE id = ?`).get(revision.id)!.version, 2)
	db.database.prepare(`UPDATE chapter_revisions SET status = 'review_pending' WHERE id = ?`).run(revision.id)
	const frozen = await request(db, 1, 'PUT', `/revisions/${revision.id}/draft`, { body: 'forbidden', base_version: 2 }, { 'Idempotency-Key': 'frozen' })
	assert.equal(frozen.status, 409)
	assert.equal((await frozen.json() as { code: string }).code, 'revision_frozen')
})

test('0053 creates revision and idempotency tables with draft constraints', () => {
	const database = new DatabaseSync(':memory:')
	database.exec('PRAGMA foreign_keys = ON;')
	database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);`)
	database.exec(readFileSync(new URL('../../migrations/0051_novel_authoring.sql', import.meta.url), 'utf8'))
	database.exec(readFileSync(new URL('../../migrations/0052_novel_structure.sql', import.meta.url), 'utf8'))
	database.exec(readFileSync(new URL('../../migrations/0053_novel_revisions.sql', import.meta.url), 'utf8'))
	assert.deepEqual(database.prepare(`PRAGMA table_info(chapter_revisions)`).all().map(row => row.name), ['id', 'owner_id', 'chapter_id', 'body', 'status', 'version', 'create_idempotency_key', 'created_at', 'updated_at'])
	assert.equal(database.prepare(`PRAGMA foreign_key_list(chapter_revisions)`).all().some(row => row.table === 'novel_chapters'), true)
	assert.throws(() => database.prepare(`INSERT INTO chapter_revisions (id, chapter_id, body, status, version) VALUES ('bad', 'missing', '', 'unknown', 1)`).run())
})

async function createWork(db: ReturnType<typeof createDatabase>, sub: number, key: string) {
	const response = await request(db, sub, 'POST', '/works', { title: key, description: '', category: 'fiction' }, { 'Idempotency-Key': key })
	assert.equal(response.status, 201)
	return response.json() as Promise<{ id: string }>
}

async function createStructure(db: ReturnType<typeof createDatabase>, sub: number, key: string) {
	const work = await createWork(db, sub, key)
	const volume = await (await request(db, sub, 'POST', `/works/${work.id}/volumes`, { title: '第一卷' }, { 'Idempotency-Key': `${key}-volume` })).json() as { id: string }
	const chapter = await (await request(db, sub, 'POST', `/works/${work.id}/volumes/${volume.id}/chapters`, { title: '第一章' }, { 'Idempotency-Key': `${key}-chapter` })).json() as { id: string }
	return { work, volume, chapter }
}

function assertEligibility(eligible: boolean, accountAgeEligible: boolean, postEligible: boolean, reason?: string) {
	return {
		eligible,
		account_age_eligible: accountAgeEligible,
		post_eligible: postEligible,
		reasons: reason ? [reason] : [],
	}
}

// === MiMo 审核、评级与申诉 (spec S9 / migration 0054) ===

interface MiMoStub {
	result?: Record<string, unknown>
	throwError?: Error
	delayMs?: number
	calls: string[]
}

function makeMiMoStub() {
	const stub: MiMoStub = { calls: [] }
	const caller = {
		async review(body: string) {
			stub.calls.push(body)
			if (stub.delayMs) await new Promise(resolve => setTimeout(resolve, stub.delayMs))
			if (stub.throwError) throw stub.throwError
			if (stub.result === undefined) throw new Error('MiMo stub not configured')
			return stub.result
		},
	}
	return { stub, caller }
}

async function reviewRequest(
	db: ReturnType<typeof createDatabase>,
	mimo: unknown,
	sub: number,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
) {
	return createAppWithMiMo().request(`/api/v1/novels/authoring${path}`, {
		method,
		headers: {
			Authorization: await bearer(sub),
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			...headers,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	}, { abdl_space_db: db, JWT_SECRET: jwtSecret, novel_mimo_caller: mimo } as never)
}

function createAppWithMiMo() {
	const app = new Hono()
	app.route('/api/v1/novels/authoring', novelAuthoring)
	return app
}

async function createDraftRevision(db: ReturnType<typeof createDatabase>, sub: number, key: string, body = '第一章正文内容。') {
	const { work, volume, chapter } = await createStructure(db, sub, key)
	const revisionResponse = await (await request(db, sub, 'POST', `/chapters/${chapter.id}/revisions`, { body }, { 'Idempotency-Key': `${key}-rev` })).json() as { id: string, chapter_id: string }
	return { work, volume, chapter, revision: { id: revisionResponse.id, chapter_id: revisionResponse.chapter_id } }
}

const COMPLIANT_RESULT = {
	violation_flag: false,
	risk_categories: [{ category: 'none', confidence: 0.05 }],
	rating: 'all_ages',
	content_hint: '适合所有年龄段',
	summary: '内容合规',
}
const VIOLATION_RESULT = {
	violation_flag: true,
	risk_categories: [{ category: 'explicit_content', confidence: 0.97 }],
	rating: 'suggest_18',
	content_hint: '包含成内容描写',
	summary: '过分违规，拒绝发布',
}

test('0054 creates review pipeline tables with revision foreign keys', () => {
	const database = new DatabaseSync(':memory:')
	database.exec('PRAGMA foreign_keys = ON;')
	database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);`)
	database.exec(`CREATE TABLE novels (id TEXT PRIMARY KEY, author_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE);`)
	database.exec(readFileSync(new URL('../../migrations/0051_novel_authoring.sql', import.meta.url), 'utf8'))
	database.exec(readFileSync(new URL('../../migrations/0052_novel_structure.sql', import.meta.url), 'utf8'))
	database.exec(readFileSync(new URL('../../migrations/0053_novel_revisions.sql', import.meta.url), 'utf8'))
	database.exec(readFileSync(new URL('../../migrations/0054_novel_review_pipeline.sql', import.meta.url), 'utf8'))
	for (const table of ['novel_review_snapshots', 'novel_review_results', 'novel_review_appeals', 'novel_review_audit']) {
		const row = database.prepare(`SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = ?) AS e`).get(table) as { e: number }
		assert.equal(row.e, 1)
	}
	assert.equal(database.prepare(`PRAGMA foreign_key_list(novel_review_results)`).all().some(row => row.table === 'novel_review_snapshots'), true)
	assert.throws(() => database.prepare(`INSERT INTO novel_review_results (id, owner_id, revision_id, snapshot_id, violation_flag, rating) VALUES ('r', 1, 'c', 's', 0, 'bogus')`).run())
})

test('submitting a draft revision with a compliant MiMo result freezes snapshot and approves', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { stub, caller } = makeMiMoStub()
	stub.result = COMPLIANT_RESULT
	const { chapter, revision } = await createDraftRevision(db, 1, 'compliant')

	const response = await reviewRequest(db, caller, 1, 'POST', `/chapters/${chapter.id}/revisions/${revision.id}/submit`, undefined, { 'Idempotency-Key': 'submit-compliant' })
	assert.equal(response.status, 200)
	const result = await response.json() as { status: string, rating: string, snapshot_id: string, result_id: string }
	assert.equal(result.status, 'approved')
	assert.equal(result.rating, 'all_ages')
	assert.ok(result.snapshot_id)
	assert.ok(result.result_id)

	const audit = db.database.prepare(`SELECT action FROM novel_review_audit WHERE revision_id = ? ORDER BY id`).all(revision.id) as { action: string }[]
	assert.deepEqual(audit.map(row => row.action), ['submit', 'auto_approve'])

	const snapshot = db.database.prepare(`SELECT body_snapshot FROM novel_review_snapshots WHERE revision_id = ?`).get(revision.id) as { body_snapshot: string }
	assert.equal(snapshot.body_snapshot, '第一章正文内容。')
	assert.equal(stub.calls.length, 1)
})

test('submitting with a violation result rejects but keeps the private draft', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { stub, caller } = makeMiMoStub()
	stub.result = VIOLATION_RESULT
	const { chapter, revision } = await createDraftRevision(db, 1, 'violation')

	const response = await reviewRequest(db, caller, 1, 'POST', `/chapters/${chapter.id}/revisions/${revision.id}/submit`, undefined, { 'Idempotency-Key': 'submit-violation' })
	assert.equal(response.status, 200)
	const result = await response.json() as { status: string, violation_flag: boolean }
	assert.equal(result.status, 'rejected')
	assert.equal(result.violation_flag, true)

	const body = db.database.prepare(`SELECT body, status FROM chapter_revisions WHERE id = ?`).get(revision.id) as { body: string, status: string }
	assert.equal(body.status, 'rejected')
	assert.equal(body.body, '第一章正文内容。')
})

test('MiMo timeout keeps the revision review_pending and never auto-approves', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { stub, caller } = makeMiMoStub()
	stub.throwError = new Error('MiMo timeout')
	const { chapter, revision } = await createDraftRevision(db, 1, 'timeout')

	const response = await reviewRequest(db, caller, 1, 'POST', `/chapters/${chapter.id}/revisions/${revision.id}/submit`, undefined, { 'Idempotency-Key': 'submit-timeout' })
	assert.equal(response.status, 200)
	const result = await response.json() as { status: string }
	assert.equal(result.status, 'review_pending')

	const status = db.database.prepare(`SELECT status FROM chapter_revisions WHERE id = ?`).get(revision.id) as { status: string }
	assert.equal(status.status, 'review_pending')
	const resultCount = db.database.prepare(`SELECT COUNT(*) AS c FROM novel_review_results WHERE revision_id = ?`).get(revision.id) as { c: number }
	assert.equal(resultCount.c, 0)
	const audit = db.database.prepare(`SELECT action FROM novel_review_audit WHERE revision_id = ? ORDER BY id`).all(revision.id) as { action: string }[]
	assert.deepEqual(audit.map(row => row.action), ['submit', 'review_kept_pending'])
})

test('MiMo returning invalid JSON schema keeps the revision review_pending', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { stub, caller } = makeMiMoStub()
	stub.result = { unexpected_field: true, rating: 'not_a_valid_rating' }
	const { chapter, revision } = await createDraftRevision(db, 1, 'invalid')

	const response = await reviewRequest(db, caller, 1, 'POST', `/chapters/${chapter.id}/revisions/${revision.id}/submit`, undefined, { 'Idempotency-Key': 'submit-invalid' })
	assert.equal(response.status, 200)
	const result = await response.json() as { status: string }
	assert.equal(result.status, 'review_pending')

	const status = db.database.prepare(`SELECT status FROM chapter_revisions WHERE id = ?`).get(revision.id) as { status: string }
	assert.equal(status.status, 'review_pending')
})

test('submitting a non-draft revision is rejected with 409', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { stub, caller } = makeMiMoStub()
	stub.result = COMPLIANT_RESULT
	const { chapter, revision } = await createDraftRevision(db, 1, 'resubmit')

	const first = await reviewRequest(db, caller, 1, 'POST', `/chapters/${chapter.id}/revisions/${revision.id}/submit`, undefined, { 'Idempotency-Key': 'submit-once' })
	assert.equal(first.status, 200)
	assert.equal((await first.json() as { status: string }).status, 'approved')

	const again = await reviewRequest(db, caller, 1, 'POST', `/chapters/${chapter.id}/revisions/${revision.id}/submit`, undefined, { 'Idempotency-Key': 'submit-twice' })
	assert.equal(again.status, 409)
})

test('submit replay with the same idempotency key returns the original result without calling MiMo again', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { stub, caller } = makeMiMoStub()
	stub.result = COMPLIANT_RESULT
	const { chapter, revision } = await createDraftRevision(db, 1, 'idempotent')

	const first = await reviewRequest(db, caller, 1, 'POST', `/chapters/${chapter.id}/revisions/${revision.id}/submit`, undefined, { 'Idempotency-Key': 'submit-stable' })
	const replay = await reviewRequest(db, caller, 1, 'POST', `/chapters/${chapter.id}/revisions/${revision.id}/submit`, undefined, { 'Idempotency-Key': 'submit-stable' })
	assert.equal(first.status, 200)
	assert.equal(replay.status, 200)
	assert.equal((await first.json() as { result_id: string }).result_id, (await replay.json() as { result_id: string }).result_id)
	assert.equal(stub.calls.length, 1)
})

test('cross-owner submit is forbidden (returns 404 to avoid leaking existence)', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	insertUser(db, 2, 72 * 60 * 60 + 60, true)
	const { stub, caller } = makeMiMoStub()
	stub.result = COMPLIANT_RESULT
	const { chapter, revision } = await createDraftRevision(db, 1, 'owner')

	const intruder = await reviewRequest(db, caller, 2, 'POST', `/chapters/${chapter.id}/revisions/${revision.id}/submit`, undefined, { 'Idempotency-Key': 'intruder' })
	assert.equal(intruder.status, 404)
	assert.equal(stub.calls.length, 0)
})

test('GET review returns the snapshot rating and content hint for the owner', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { stub, caller } = makeMiMoStub()
	stub.result = COMPLIANT_RESULT
	const { chapter, revision } = await createDraftRevision(db, 1, 'getreview')
	await reviewRequest(db, caller, 1, 'POST', `/chapters/${chapter.id}/revisions/${revision.id}/submit`, undefined, { 'Idempotency-Key': 'submit-getreview' })

	const response = await reviewRequest(db, caller, 1, 'GET', `/revisions/${revision.id}/review`)
	assert.equal(response.status, 200)
	const result = await response.json() as { status: string, rating: string, content_hint: string, violation_flag: boolean }
	assert.equal(result.status, 'approved')
	assert.equal(result.rating, 'all_ages')
	assert.equal(result.content_hint, '适合所有年龄段')
	assert.equal(result.violation_flag, false)
})

test('a rejected revision can be appealed into a human queue', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { stub, caller } = makeMiMoStub()
	stub.result = VIOLATION_RESULT
	const { revision } = await createDraftRevision(db, 1, 'appeal')
	await reviewRequest(db, caller, 1, 'POST', `/chapters/${revision.chapter_id}/revisions/${revision.id}/submit`, undefined, { 'Idempotency-Key': 'submit-appeal' })

	const appeal = await reviewRequest(db, caller, 1, 'POST', `/revisions/${revision.id}/appeals`, { reason: '我认为误判，请人工复核。' }, { 'Idempotency-Key': 'appeal-1' })
	assert.equal(appeal.status, 201)
	const appealResult = await appeal.json() as { id: string, status: string }
	assert.equal(appealResult.status, 'pending')

	const row = db.database.prepare(`SELECT status, reason, decided_at FROM novel_review_appeals WHERE revision_id = ?`).get(revision.id) as { status: string, reason: string, decided_at: number | null }
	assert.equal(row.status, 'pending')
	assert.equal(row.reason, '我认为误判，请人工复核。')
	assert.equal(row.decided_at, null)

	const audit = db.database.prepare(`SELECT action FROM novel_review_audit WHERE revision_id = ? ORDER BY id`).all(revision.id) as { action: string }[]
	assert.ok(audit.some(row => row.action === 'appeal'))
})

test('appealing a non-rejected revision is rejected with 409', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { stub, caller } = makeMiMoStub()
	stub.result = COMPLIANT_RESULT
	const { revision } = await createDraftRevision(db, 1, 'badappeal')
	await reviewRequest(db, caller, 1, 'POST', `/chapters/${revision.chapter_id}/revisions/${revision.id}/submit`, undefined, { 'Idempotency-Key': 'submit-badappeal' })

	const appeal = await reviewRequest(db, caller, 1, 'POST', `/revisions/${revision.id}/appeals`, { reason: '想申诉' }, { 'Idempotency-Key': 'badappeal-1' })
	assert.equal(appeal.status, 409)
})

// === 评级原子发布 (spec S9/S14 / migration 0055) ===

async function approveRevision(db: ReturnType<typeof createDatabase>, mimo: { stub: MiMoStub, caller: unknown }, sub: number, key: string, body = '可发布正文。') {
	const { chapter, revision } = await createDraftRevision(db, sub, key, body)
	mimo.stub.result = COMPLIANT_RESULT
	const submit = await reviewRequest(db, mimo.caller, sub, 'POST', `/chapters/${chapter.id}/revisions/${revision.id}/submit`, undefined, { 'Idempotency-Key': `approve-${key}` })
	assert.equal(submit.status, 200)
	assert.equal((await submit.json() as { status: string }).status, 'approved')
	return { chapter, revision }
}

test('publishing an approved revision atomically makes it published and writes a publish audit', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { stub, caller } = makeMiMoStub()
	const { chapter, revision } = await approveRevision(db, { stub, caller }, 1, 'pub1')

	const response = await reviewRequest(db, caller, 1, 'POST', `/revisions/${revision.id}/publish`, undefined, { 'Idempotency-Key': 'publish-pub1' })
	assert.equal(response.status, 200)
	const result = await response.json() as { status: string, published_revision_id: string }
	assert.equal(result.status, 'published')
	assert.equal(result.published_revision_id, revision.id)

	const row = db.database.prepare(`SELECT status FROM chapter_revisions WHERE id = ?`).get(revision.id) as { status: string }
	assert.equal(row.status, 'published')
	const audit = db.database.prepare(`SELECT action FROM novel_review_audit WHERE revision_id = ? AND action = 'publish'`).all(revision.id)
	assert.equal(audit.length, 1)
})

test('only one published revision per chapter: re-publishing supersedes the old one atomically', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { stub, caller } = makeMiMoStub()
	const { chapter, revision: firstRevision } = await approveRevision(db, { stub, caller }, 1, 'republish1', '第一版正文。')
	await reviewRequest(db, caller, 1, 'POST', `/revisions/${firstRevision.id}/publish`, undefined, { 'Idempotency-Key': 'publish-republish1' })

	stub.result = COMPLIANT_RESULT
	const secondRevision = await (await request(db, 1, 'POST', `/chapters/${chapter.id}/revisions`, { body: '第二版正文。' }, { 'Idempotency-Key': 'republish2-rev' })).json() as { id: string, chapter_id: string }
	const submitSecond = await reviewRequest(db, caller, 1, 'POST', `/chapters/${chapter.id}/revisions/${secondRevision.id}/submit`, undefined, { 'Idempotency-Key': 'submit-republish2' })
	assert.equal((await submitSecond.json() as { status: string }).status, 'approved')

	const response = await reviewRequest(db, caller, 1, 'POST', `/revisions/${secondRevision.id}/publish`, undefined, { 'Idempotency-Key': 'publish-republish2' })
	assert.equal(response.status, 200)
	assert.equal((await response.json() as { status: string }).status, 'published')

	const statuses = db.database.prepare(`SELECT id, status FROM chapter_revisions WHERE chapter_id = ? ORDER BY created_at`).all(chapter.id) as { id: string, status: string }[]
	const published = statuses.filter(row => row.status === 'published')
	assert.equal(published.length, 1)
	assert.equal(published[0].id, secondRevision.id)
	const superseded = statuses.find(row => row.id === firstRevision.id)
	assert.equal(superseded?.status, 'superseded')
})

test('publishing a non-approved revision is rejected with 409', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { caller } = makeMiMoStub()
	const { revision } = await createDraftRevision(db, 1, 'nonapproved')

	const response = await reviewRequest(db, caller, 1, 'POST', `/revisions/${revision.id}/publish`, undefined, { 'Idempotency-Key': 'publish-nonapproved' })
	assert.equal(response.status, 409)
	const row = db.database.prepare(`SELECT status FROM chapter_revisions WHERE id = ?`).get(revision.id) as { status: string }
	assert.equal(row.status, 'draft')
})

test('publish replay with the same idempotency key returns the original result without re-auditing', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { stub, caller } = makeMiMoStub()
	const { revision } = await approveRevision(db, { stub, caller }, 1, 'idempotentpub')

	const first = await reviewRequest(db, caller, 1, 'POST', `/revisions/${revision.id}/publish`, undefined, { 'Idempotency-Key': 'publish-stable' })
	const replay = await reviewRequest(db, caller, 1, 'POST', `/revisions/${revision.id}/publish`, undefined, { 'Idempotency-Key': 'publish-stable' })
	assert.equal(first.status, 200)
	assert.equal(replay.status, 200)
	assert.equal((await first.json() as { published_revision_id: string }).published_revision_id, (await replay.json() as { published_revision_id: string }).published_revision_id)
	const audits = db.database.prepare(`SELECT action FROM novel_review_audit WHERE revision_id = ? AND action = 'publish'`).all(revision.id)
	assert.equal(audits.length, 1)
})

test('cross-owner publish is forbidden (returns 404)', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	insertUser(db, 2, 72 * 60 * 60 + 60, true)
	const { stub, caller } = makeMiMoStub()
	const { revision } = await approveRevision(db, { stub, caller }, 1, 'xowner')

	const intruder = await reviewRequest(db, caller, 2, 'POST', `/revisions/${revision.id}/publish`, undefined, { 'Idempotency-Key': 'intruder-pub' })
	assert.equal(intruder.status, 404)
	const row = db.database.prepare(`SELECT status FROM chapter_revisions WHERE id = ?`).get(revision.id) as { status: string }
	assert.equal(row.status, 'approved')
})

test('GET published chapter returns the current published revision body, rating and content hint for the owner', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { stub, caller } = makeMiMoStub()
	const { chapter, revision } = await approveRevision(db, { stub, caller }, 1, 'readpub', '读者可见的正文。')
	await reviewRequest(db, caller, 1, 'POST', `/revisions/${revision.id}/publish`, undefined, { 'Idempotency-Key': 'publish-readpub' })

	const response = await reviewRequest(db, caller, 1, 'GET', `/chapters/${chapter.id}/published`)
	assert.equal(response.status, 200)
	const result = await response.json() as { revision_id: string, body: string, status: string, rating: string, rating_label: string, content_hint: string }
	assert.equal(result.revision_id, revision.id)
	assert.equal(result.status, 'published')
	assert.equal(result.body, '读者可见的正文。')
	assert.equal(result.rating, 'all_ages')
	assert.equal(result.rating_label, '全年龄')
	assert.equal(result.content_hint, '适合所有年龄段')
})

test('GET published chapter returns 404 when nothing is published yet', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { caller } = makeMiMoStub()
	const { chapter, revision } = await createDraftRevision(db, 1, 'nothingpub')

	const response = await reviewRequest(db, caller, 1, 'GET', `/chapters/${chapter.id}/published`)
	assert.equal(response.status, 404)
	const stillDraft = db.database.prepare(`SELECT status FROM chapter_revisions WHERE id = ?`).get(revision.id) as { status: string }
	assert.equal(stillDraft.status, 'draft')
})

test('submit rechecks publish eligibility: an author who lost eligibility cannot submit a revision', async () => {
	const db = createDatabase()
	insertUser(db, 1, 72 * 60 * 60 + 60, true)
	const { stub, caller } = makeMiMoStub()
	stub.result = COMPLIANT_RESULT
	const { chapter, revision } = await createDraftRevision(db, 1, 'losteligible')
	db.database.prepare(`DELETE FROM posts WHERE user_id = 1`).run()

	const response = await reviewRequest(db, caller, 1, 'POST', `/chapters/${chapter.id}/revisions/${revision.id}/submit`, undefined, { 'Idempotency-Key': 'submit-losteligible' })
	assert.equal(response.status, 403)
	assert.equal((await response.json() as { code: string }).code, 'author_ineligible')
	const row = db.database.prepare(`SELECT status FROM chapter_revisions WHERE id = ?`).get(revision.id) as { status: string }
	assert.equal(row.status, 'draft')
	assert.equal(stub.calls.length, 0)
})
