import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

interface TableColumn {
	name: string
	notnull: number
	pk: number
}

const migrationUrl = new URL('../../migrations/0050_novel_private_library.sql', import.meta.url)
const schemaUrl = new URL('../../schemas/schema.sql', import.meta.url)

function createDatabase(useCompleteSchema = false): DatabaseSync {
	const database = new DatabaseSync(':memory:')
	database.exec('PRAGMA foreign_keys = ON;')
	if (useCompleteSchema) {
		database.exec(readFileSync(schemaUrl, 'utf8'))
		database.exec('INSERT INTO users (email, password_hash, username) VALUES (\'one@example.com\', \'hash\', \'one\'), (\'two@example.com\', \'hash\', \'two\')')
	} else {
		database.exec(`
			CREATE TABLE users (id INTEGER PRIMARY KEY NOT NULL);
			INSERT INTO users (id) VALUES (1), (2);
		`)
		database.exec(readFileSync(migrationUrl, 'utf8'))
	}
	return database
}

function insertBook(database: DatabaseSync, id: string, ownerId: number, contentHash: string, objectKey = `novels/${ownerId}/${id}`): void {
	database.prepare(`
		INSERT INTO novel_books (
			id, owner_id, title, author, format, object_key, content_hash,
			declared_size, verified_size, parse_status
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(id, ownerId, `Book ${id}`, 'Author', 'epub', objectKey, contentHash, 100, 100, 'ready')
}

function insertSyncItem(database: DatabaseSync, bookId: string, ownerId: number, itemId: string): void {
	database.prepare(`
		INSERT INTO novel_sync_items (
			book_id, owner_id, item_type, item_id, payload_json, updated_at
		) VALUES (?, ?, 'bookmark', ?, '{}', 1)
	`).run(bookId, ownerId, itemId)
}

test('creates the complete private novel metadata schema with explicit non-null primary keys', () => {
	const database = createDatabase()
	try {
		const bookColumns = database.prepare('PRAGMA table_info(novel_books)').all() as unknown as TableColumn[]
		assert.deepEqual(bookColumns.map(({ name }) => name), [
			'id', 'owner_id', 'title', 'author', 'format', 'object_key', 'content_hash',
			'declared_size', 'verified_size', 'parse_status', 'created_at', 'updated_at', 'deleted_at',
		])
		assert.deepEqual(
			bookColumns.filter(({ pk }) => pk > 0).sort((a, b) => a.pk - b.pk).map(({ name, notnull }) => [name, notnull]),
			[['owner_id', 1], ['id', 1]],
		)

		const syncColumns = database.prepare('PRAGMA table_info(novel_sync_items)').all() as unknown as TableColumn[]
		assert.deepEqual(syncColumns.map(({ name }) => name), [
			'book_id', 'owner_id', 'item_type', 'item_id', 'payload_json', 'updated_at', 'deleted_at',
		])
		assert.deepEqual(
			syncColumns.filter(({ pk }) => pk > 0).sort((a, b) => a.pk - b.pk).map(({ name, notnull }) => [name, notnull]),
			[['owner_id', 1], ['item_type', 1], ['item_id', 1]],
		)
	} finally {
		database.close()
	}
})

test('keeps the complete schema aligned with the private novel migration', () => {
	const database = createDatabase(true)
	try {
		insertBook(database, 'book-1', 1, 'same-hash', 'shared-object-key')
		assert.throws(() => insertBook(database, 'book-2', 1, 'same-hash'), /UNIQUE constraint failed/)
		assert.doesNotThrow(() => insertBook(database, 'book-1', 2, 'same-hash', 'shared-object-key'))
		insertSyncItem(database, 'book-1', 1, 'stable-item')
		assert.doesNotThrow(() => insertSyncItem(database, 'book-1', 2, 'stable-item'))
	} finally {
		database.close()
	}
})

test('scopes book deduplication and object keys to the owner', () => {
	const database = createDatabase()
	try {
		insertBook(database, 'book-1', 1, 'same-hash', 'shared-object-key')
		assert.throws(() => insertBook(database, 'book-2', 1, 'same-hash'), /UNIQUE constraint failed/)
		assert.throws(() => insertBook(database, 'book-3', 1, 'different-hash', 'shared-object-key'), /UNIQUE constraint failed/)
		assert.doesNotThrow(() => insertBook(database, 'book-1', 2, 'same-hash', 'shared-object-key'))
	} finally {
		database.close()
	}
})

test('scopes sync identities and book foreign keys to the owner', () => {
	const database = createDatabase()
	try {
		insertBook(database, 'owner-1-book', 1, 'owner-1-hash')
		insertBook(database, 'owner-2-book', 2, 'owner-2-hash')
		insertSyncItem(database, 'owner-1-book', 1, 'stable-item')
		assert.throws(() => insertSyncItem(database, 'owner-2-book', 1, 'wrong-owner'), /FOREIGN KEY constraint failed/)
		assert.throws(() => insertSyncItem(database, 'owner-1-book', 1, 'stable-item'), /UNIQUE constraint failed/)
		assert.doesNotThrow(() => insertSyncItem(database, 'owner-2-book', 2, 'stable-item'))
	} finally {
		database.close()
	}
})

test('cascades private books and sync items without affecting another owner', () => {
	const database = createDatabase()
	try {
		insertBook(database, 'owner-1-book', 1, 'owner-1-hash')
		insertBook(database, 'owner-2-book', 2, 'owner-2-hash')
		insertSyncItem(database, 'owner-1-book', 1, 'owner-1-item')
		insertSyncItem(database, 'owner-2-book', 2, 'owner-2-item')

		database.exec('DELETE FROM users WHERE id = 1')
		assert.equal(database.prepare('SELECT COUNT(*) AS count FROM novel_books WHERE owner_id = 1').get()?.count, 0)
		assert.equal(database.prepare('SELECT COUNT(*) AS count FROM novel_sync_items WHERE owner_id = 1').get()?.count, 0)
		assert.equal(database.prepare('SELECT COUNT(*) AS count FROM novel_books WHERE owner_id = 2').get()?.count, 1)
		assert.equal(database.prepare('SELECT COUNT(*) AS count FROM novel_sync_items WHERE owner_id = 2').get()?.count, 1)
	} finally {
		database.close()
	}
})
