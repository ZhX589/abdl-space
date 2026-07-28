import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
	MEDIA_UPLOAD_AUTHORIZATION_TTL_SECONDS,
	assertUploadOwner,
	buildMediaObjectKey,
	canCompleteUpload,
	getMediaUploadPolicy,
	getUploadExpiresAt,
	validateMediaUpload,
} from './media-upload.ts'

const mib = 1024 * 1024
const now = new Date('2026-07-29T23:59:59.000Z')

function assertMediaUploadIdRejectsNull(database: DatabaseSync): void {
	assert.throws(() => database.exec(`
		INSERT INTO media_uploads (
			id, user_id, purpose, object_key, public_url, mime_type,
			declared_size, storage_provider, expires_at
		) VALUES (
			NULL, 1, 'generic', 'generic/1/test.jpg', 'https://example.com/test.jpg',
			'image/jpeg', 1, 'cos', 1
		)
	`), /NOT NULL constraint failed: media_uploads\.id/)
}

test('rejects NULL media upload IDs in migration and complete schema', () => {
	const migrationDatabase = new DatabaseSync(':memory:')
	migrationDatabase.exec(`
		CREATE TABLE users (id INTEGER PRIMARY KEY);
		CREATE TABLE post_images (id INTEGER PRIMARY KEY);
		INSERT INTO users (id) VALUES (1);
	`)
	migrationDatabase.exec(readFileSync(new URL('../../migrations/0042_cos_uploads.sql', import.meta.url), 'utf8'))
	assertMediaUploadIdRejectsNull(migrationDatabase)
	migrationDatabase.close()

	const schemaDatabase = new DatabaseSync(':memory:')
	schemaDatabase.exec(readFileSync(new URL('../../schemas/schema.sql', import.meta.url), 'utf8'))
	schemaDatabase.exec("INSERT INTO users (id, email, password_hash, username) VALUES (1, 'test@example.com', 'hash', 'tester')")
	assertMediaUploadIdRejectsNull(schemaDatabase)
	schemaDatabase.close()
})

test('defines MIME and size policy for every supported upload purpose', () => {
	assert.deepEqual(getMediaUploadPolicy('status_original'), {
		mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
		maxBytes: 10 * mib,
		requiresImageMetadata: true,
	})
	assert.deepEqual(getMediaUploadPolicy('status_preview'), {
		mimeTypes: ['image/jpeg', 'image/webp'],
		maxBytes: 2 * mib,
		requiresImageMetadata: true,
	})
	assert.deepEqual(getMediaUploadPolicy('avatar'), {
		mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
		maxBytes: 10 * mib,
		requiresImageMetadata: true,
	})
	assert.deepEqual(getMediaUploadPolicy('header'), {
		mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
		maxBytes: 10 * mib,
		requiresImageMetadata: true,
	})
	assert.deepEqual(getMediaUploadPolicy('generic'), {
		mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
		maxBytes: 10 * mib,
		requiresImageMetadata: true,
	})
	assert.deepEqual(getMediaUploadPolicy('release'), {
		mimeTypes: ['application/vnd.android.package-archive'],
		maxBytes: 200 * mib,
		requiresImageMetadata: false,
	})
	assert.throws(() => getMediaUploadPolicy('arbitrary'), /purpose/i)
})

test('accepts valid metadata and rejects unsupported MIME, size, or missing image dimensions', () => {
	assert.deepEqual(validateMediaUpload({
		purpose: 'status_original',
		mimeType: 'image/png',
		declaredSize: 1234,
		width: 1200,
		height: 800,
	}), { purpose: 'status_original', mimeType: 'image/png', declaredSize: 1234, width: 1200, height: 800 })
	assert.throws(() => validateMediaUpload({ purpose: 'status_original', mimeType: 'video/mp4', declaredSize: 1, width: 1, height: 1 }), /MIME/i)
	assert.throws(() => validateMediaUpload({ purpose: 'generic', mimeType: 'image/jpeg', declaredSize: 10 * mib + 1, width: 1, height: 1 }), /size/i)
	assert.throws(() => validateMediaUpload({ purpose: 'avatar', mimeType: 'image/jpeg', declaredSize: 1 }), /metadata/i)
	assert.throws(() => validateMediaUpload({ purpose: 'release', mimeType: 'application/vnd.android.package-archive', declaredSize: 0 }), /size/i)
})

test('limits status preview longest edge to 540px without upscaling smaller images', () => {
	assert.doesNotThrow(() => validateMediaUpload({ purpose: 'status_preview', mimeType: 'image/jpeg', declaredSize: 1, width: 540, height: 360 }))
	assert.doesNotThrow(() => validateMediaUpload({ purpose: 'status_preview', mimeType: 'image/webp', declaredSize: 1, width: 320, height: 400 }))
	assert.throws(() => validateMediaUpload({ purpose: 'status_preview', mimeType: 'image/jpeg', declaredSize: 1, width: 541, height: 360 }), /540/)
	assert.throws(() => validateMediaUpload({ purpose: 'status_original', mimeType: 'image/jpeg', declaredSize: 1, width: 0, height: 1 }), /metadata/i)
})

test('rejects client-provided object keys', () => {
	assert.throws(() => validateMediaUpload({
		purpose: 'generic',
		mimeType: 'image/jpeg',
		declaredSize: 1,
		width: 1,
		height: 1,
		objectKey: 'generic/42/client-controlled.jpg',
	}), /object key/i)
})

test('generates server-owned keys from purpose, user, UTC date, UUID, and MIME extension', () => {
	const uuid = '123e4567-e89b-12d3-a456-426614174000'
	const makeUuid = () => uuid
	assert.equal(buildMediaObjectKey({ purpose: 'status_original', userId: 42, mimeType: 'image/jpeg', now, makeUuid }), `media/original/42/2026-07-29/${uuid}.jpg`)
	assert.equal(buildMediaObjectKey({ purpose: 'status_preview', userId: 42, mimeType: 'image/webp', now, makeUuid }), `media/preview/42/2026-07-29/${uuid}.webp`)
	assert.equal(buildMediaObjectKey({ purpose: 'avatar', userId: 42, mimeType: 'image/png', now, makeUuid }), `profile/avatar/42/2026-07-29/${uuid}.png`)
	assert.equal(buildMediaObjectKey({ purpose: 'header', userId: 42, mimeType: 'image/gif', now, makeUuid }), `profile/header/42/2026-07-29/${uuid}.gif`)
	assert.equal(buildMediaObjectKey({ purpose: 'generic', userId: 42, mimeType: 'image/jpeg', now, makeUuid }), `generic/42/2026-07-29/${uuid}.jpg`)
	assert.equal(buildMediaObjectKey({ purpose: 'release', userId: 42, mimeType: 'application/vnd.android.package-archive', now, makeUuid }), `releases/42/2026-07-29/${uuid}.apk`)
	assert.throws(() => buildMediaObjectKey({ purpose: 'generic', userId: 0, mimeType: 'image/jpeg', now, makeUuid }), /user/i)
	assert.throws(() => buildMediaObjectKey({ purpose: 'generic', userId: 42, mimeType: 'image/avif', now, makeUuid }), /MIME/i)
})

test('expires upload authorization exactly five minutes after creation', () => {
	assert.equal(MEDIA_UPLOAD_AUTHORIZATION_TTL_SECONDS, 300)
	assert.equal(getUploadExpiresAt(now), 1785369899)
})

test('enforces upload ownership and pending-to-complete status transition', () => {
	assert.doesNotThrow(() => assertUploadOwner({ userId: 42 }, 42))
	assert.throws(() => assertUploadOwner({ userId: 42 }, 7), /owner/i)
	assert.equal(canCompleteUpload({ userId: 42, status: 'pending', expiresAt: 1785369899 }, 42, 1785369800), true)
	assert.equal(canCompleteUpload({ userId: 42, status: 'complete', expiresAt: 1785369899 }, 42, 1785369800), false)
	assert.equal(canCompleteUpload({ userId: 42, status: 'pending', expiresAt: 1785369799 }, 42, 1785369800), false)
	assert.equal(canCompleteUpload({ userId: 42, status: 'pending', expiresAt: 1785369899 }, 7, 1785369800), false)
})
