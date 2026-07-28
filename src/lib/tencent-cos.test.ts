import assert from 'node:assert/strict'
import test from 'node:test'

import {
	buildCosObjectUrl,
	createCosHeadAuthorization,
	createCosPutAuthorization,
	putObjectToCos,
} from './tencent-cos.ts'

const credentials = {
	secretId: 'AKIDEXAMPLEFAKE',
	secretKey: 'fake-secret-key-for-tests-only',
}
const now = new Date('2026-07-29T08:00:00.000Z')

test('creates a stable five-minute PUT authorization bound to content type, host, and encoded key', async () => {
	const result = await createCosPutAuthorization({
		...credentials,
		objectKey: 'media/a b.jpg',
		contentType: 'image/jpeg',
		now,
	})

	assert.deepEqual(result, {
		url: 'https://abdl-1339643562.cos.ap-shanghai.myqcloud.com/media/a%20b.jpg',
		host: 'abdl-1339643562.cos.ap-shanghai.myqcloud.com',
		expiresAt: 1785312300,
		headers: {
			Authorization: 'q-sign-algorithm=sha1&q-ak=AKIDEXAMPLEFAKE&q-sign-time=1785312000;1785312300&q-key-time=1785312000;1785312300&q-header-list=content-type;host&q-url-param-list=&q-signature=61ebdc70ae39a9160d1e0e5d84ed0e00900d31ad',
			'Content-Type': 'image/jpeg',
			Host: 'abdl-1339643562.cos.ap-shanghai.myqcloud.com',
		},
	})
})

test('creates HEAD authorization with a method-specific signature', async () => {
	const result = await createCosHeadAuthorization({
		...credentials,
		objectKey: 'media/a b.jpg',
		contentType: 'image/jpeg',
		now,
	})

	assert.equal(result.expiresAt, 1785312300)
	assert.equal(result.headers['Content-Type'], 'image/jpeg')
	assert.equal(result.headers.Authorization, 'q-sign-algorithm=sha1&q-ak=AKIDEXAMPLEFAKE&q-sign-time=1785312000;1785312300&q-key-time=1785312000;1785312300&q-header-list=content-type;host&q-url-param-list=&q-signature=69303e06e707e52032932855bbef0a9252189bc6')
})

test('builds encoded default and custom public object URLs', () => {
	assert.equal(
		buildCosObjectUrl('media/中文 a.jpg'),
		'https://abdl-1339643562.cos.ap-shanghai.myqcloud.com/media/%E4%B8%AD%E6%96%87%20a.jpg',
	)
	assert.equal(
		buildCosObjectUrl('media/a.jpg', { publicOrigin: 'https://media.example.test/' }),
		'https://media.example.test/media/a.jpg',
	)
})

test('rejects unsafe or non-canonical object keys', () => {
	for (const key of ['', '/media/a.jpg', 'media/', 'media//a.jpg', 'media/./a.jpg', 'media/../a.jpg', 'media\\a.jpg', 'media/a?.jpg', 'media/a#b.jpg', 'media/\u0000a.jpg']) {
		assert.throws(() => buildCosObjectUrl(key), /object key/i, key)
	}
})

test('uploads an object with signed PUT headers', async () => {
	const originalFetch = globalThis.fetch
	let request: { input: string | URL | Request, init?: RequestInit } | undefined
	globalThis.fetch = async (input, init) => {
		request = { input, init }
		return new Response(null, { status: 200, headers: { ETag: '"etag"' } })
	}

	try {
		const body = new Uint8Array([1, 2, 3])
		const response = await putObjectToCos({
			...credentials,
			objectKey: 'media/a b.jpg',
			contentType: 'image/jpeg',
			body,
			now,
		})

		assert.equal(response.status, 200)
		assert.equal(request?.input, 'https://abdl-1339643562.cos.ap-shanghai.myqcloud.com/media/a%20b.jpg')
		assert.equal(request?.init?.method, 'PUT')
		assert.equal(request?.init?.body, body)
		assert.deepEqual(request?.init?.headers, (await createCosPutAuthorization({
			...credentials,
			objectKey: 'media/a b.jpg',
			contentType: 'image/jpeg',
			now,
		})).headers)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('throws when COS rejects an object upload', async () => {
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => new Response('denied', { status: 403 })

	try {
		await assert.rejects(
			putObjectToCos({
				...credentials,
				objectKey: 'media/a.jpg',
				contentType: 'image/jpeg',
				body: new Uint8Array([1]),
				now,
			}),
			/COS PUT failed: 403/,
		)
	} finally {
		globalThis.fetch = originalFetch
	}
})
