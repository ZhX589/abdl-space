import assert from 'node:assert/strict'
import test from 'node:test'

import {
	buildCosObjectUrl,
	createCosHeadAuthorization,
	createCosPutAuthorization,
	headObjectFromCos,
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
			Authorization: 'q-sign-algorithm=sha1&q-ak=AKIDEXAMPLEFAKE&q-sign-time=1785312000;1785312300&q-key-time=1785312000;1785312300&q-header-list=content-type;host&q-url-param-list=&q-signature=a82aa9a46fca15257ba3903d7b7baa459baf5296',
			'Content-Type': 'image/jpeg',
			Host: 'abdl-1339643562.cos.ap-shanghai.myqcloud.com',
		},
	})
})

test('signs a decoded Unicode canonical path while keeping the request URL encoded', async () => {
	const result = await createCosPutAuthorization({
		...credentials,
		objectKey: 'media/中文 a.jpg',
		contentType: 'image/jpeg',
		now,
	})

	assert.equal(result.url, 'https://abdl-1339643562.cos.ap-shanghai.myqcloud.com/media/%E4%B8%AD%E6%96%87%20a.jpg')
	assert.equal(result.headers.Authorization, 'q-sign-algorithm=sha1&q-ak=AKIDEXAMPLEFAKE&q-sign-time=1785312000;1785312300&q-key-time=1785312000;1785312300&q-header-list=content-type;host&q-url-param-list=&q-signature=2f02627bc23545d0f4e55beb43a8c98e04e44119')
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
	assert.equal(result.headers.Authorization, 'q-sign-algorithm=sha1&q-ak=AKIDEXAMPLEFAKE&q-sign-time=1785312000;1785312300&q-key-time=1785312000;1785312300&q-header-list=content-type;host&q-url-param-list=&q-signature=00a32f5aa9b414d3a4cbb65e52a13d8a1a1a895b')
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

test('checks an object with signed HEAD headers and manual redirects', async () => {
	const originalFetch = globalThis.fetch
	let request: { input: string | URL | Request, init?: RequestInit } | undefined
	globalThis.fetch = async (input, init) => {
		request = { input, init }
		return new Response(null, {
			status: 200,
			headers: {
				'Content-Length': '123',
				'Content-Type': 'image/jpeg',
				'x-cos-request-id': 'safe-request-id',
			},
		})
	}

	try {
		const response = await headObjectFromCos({
			...credentials,
			objectKey: 'media/a.jpg',
			contentType: 'image/jpeg',
			now,
		})

		assert.equal(response.status, 200)
		assert.equal(request?.init?.method, 'HEAD')
		assert.equal(request?.init?.redirect, 'manual')
		assert.deepEqual(request?.init?.headers, (await createCosHeadAuthorization({
			...credentials,
			objectKey: 'media/a.jpg',
			contentType: 'image/jpeg',
			now,
		})).headers)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('reports only COS HEAD status and request ID on failure', async () => {
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => new Response(null, {
		status: 404,
		headers: { 'x-cos-request-id': 'safe-request-id' },
	})

	try {
		await assert.rejects(
			headObjectFromCos({
				...credentials,
				objectKey: 'media/a.jpg',
				contentType: 'image/jpeg',
				now,
			}),
			(error: Error) => {
				assert.match(error.message, /COS HEAD failed: 404/)
				assert.match(error.message, /safe-request-id/)
				assert.doesNotMatch(error.message, /AKIDEXAMPLEFAKE|q-signature|myqcloud\.com/)
				return true
			},
		)
	} finally {
		globalThis.fetch = originalFetch
	}
})
