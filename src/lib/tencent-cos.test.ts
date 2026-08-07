import assert from 'node:assert/strict'
import test from 'node:test'

import {
	buildCosObjectUrl,
	createCosDeleteAuthorization,
	createCosGetAuthorization,
	createCosHeadAuthorization,
	createCosPutAuthorization,
	deleteObjectFromCos,
	headPrivateObjectFromCos,
	headObjectFromCos,
	putObjectToCos,
} from './tencent-cos.ts'

const credentials = {
	secretId: 'AKIDEXAMPLEFAKE',
	secretKey: 'fake-secret-key-for-tests-only',
}
const now = new Date('2026-07-29T08:00:00.000Z')

test('creates a stable five-minute PUT authorization that forbids overwrites', async () => {
	const result = await createCosPutAuthorization({
		...credentials,
		objectKey: 'media/a b.jpg',
		contentType: 'image/jpeg',
		metadataSha256: 'a'.repeat(64),
		now,
	})

	assert.deepEqual(result, {
		url: 'https://abdl-1339643562.cos.ap-shanghai.myqcloud.com/media/a%20b.jpg',
		host: 'abdl-1339643562.cos.ap-shanghai.myqcloud.com',
		expiresAt: 1785312300,
		headers: {
			Authorization: 'q-sign-algorithm=sha1&q-ak=AKIDEXAMPLEFAKE&q-sign-time=1785312000;1785312300&q-key-time=1785312000;1785312300&q-header-list=content-type;host;x-cos-forbid-overwrite;x-cos-meta-sha256&q-url-param-list=&q-signature=aa36a36326e77b3508ab92142d5b824ca395ea22',
			'Content-Type': 'image/jpeg',
			'x-cos-forbid-overwrite': 'true',
			'x-cos-meta-sha256': 'a'.repeat(64),
		},
	})
})

test('keeps the existing PUT vector when SHA-256 metadata is omitted', async () => {
	const result = await createCosPutAuthorization({
		...credentials,
		objectKey: 'media/a b.jpg',
		contentType: 'image/jpeg',
		now,
	})

	assert.equal(result.headers.Authorization, 'q-sign-algorithm=sha1&q-ak=AKIDEXAMPLEFAKE&q-sign-time=1785312000;1785312300&q-key-time=1785312000;1785312300&q-header-list=content-type;host;x-cos-forbid-overwrite&q-url-param-list=&q-signature=b2fb4b3f7c8565e43fc3f55fdd212d82b61c51ea')
	assert.equal(Object.hasOwn(result.headers, 'x-cos-meta-sha256'), false)
})

test('signs a decoded Unicode canonical path while keeping the request URL encoded', async () => {
	const result = await createCosPutAuthorization({
		...credentials,
		objectKey: 'media/中文 a.jpg',
		contentType: 'image/jpeg',
		now,
	})

	assert.equal(result.url, 'https://abdl-1339643562.cos.ap-shanghai.myqcloud.com/media/%E4%B8%AD%E6%96%87%20a.jpg')
	assert.equal(result.headers.Authorization, 'q-sign-algorithm=sha1&q-ak=AKIDEXAMPLEFAKE&q-sign-time=1785312000;1785312300&q-key-time=1785312000;1785312300&q-header-list=content-type;host;x-cos-forbid-overwrite&q-url-param-list=&q-signature=368d0f79c8d93dcc57a731e7f771436c1a6d6d16')
	assert.equal(result.headers['x-cos-forbid-overwrite'], 'true')
})

test('creates HEAD authorization with a method-specific signature', async () => {
	const result = await createCosHeadAuthorization({
		...credentials,
		objectKey: 'media/a b.jpg',
		contentType: 'image/jpeg',
		now,
	})

	assert.equal(result.expiresAt, 1785312300)
	assert.equal(Object.hasOwn(result.headers, 'Content-Type'), false)
	assert.equal(Object.hasOwn(result.headers, 'x-cos-forbid-overwrite'), false)
	assert.match(result.headers.Authorization, /q-header-list=host(?:&|$)/)
})

test('creates a short-lived GET URL with authorization in the query string', async () => {
	const result = await createCosGetAuthorization({
		...credentials,
		objectKey: 'novels/private/42/book.epub',
		contentType: 'application/epub+zip',
		now,
	})

	assert.equal(result.expiresAt, 1785312300)
	const expectedAuthorization = 'q-sign-algorithm=sha1&q-ak=AKIDEXAMPLEFAKE&q-sign-time=1785312000;1785312300&q-key-time=1785312000;1785312300&q-header-list=host&q-url-param-list=&q-signature=adf9c7eb17e66eda9b353f45c735935fb85fe778'
	assert.equal(result.headers.Authorization, expectedAuthorization)
	assert.equal(result.url, `https://abdl-1339643562.cos.ap-shanghai.myqcloud.com/novels/private/42/book.epub?${expectedAuthorization}`)
	assert.equal(Object.hasOwn(result.headers, 'Content-Type'), false)
	assert.equal(Object.hasOwn(result.headers, 'x-cos-forbid-overwrite'), false)
})

test('private HEAD exposes safe HTTP status without leaking authorization', async () => {
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => new Response(null, { status: 403, headers: { Authorization: 'must-not-leak' } })
	try {
		await assert.rejects(
			headPrivateObjectFromCos({ ...credentials, objectKey: 'novels/private/42/book.epub', contentType: 'application/epub+zip', now }),
			(error: Error & { status?: number }) => {
				assert.equal(error.status, 403)
				assert.doesNotMatch(error.message, /Authorization|AKIDEXAMPLEFAKE|q-signature/)
				return true
			},
		)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('private HEAD rejects redirects as a safe upstream failure', async () => {
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: 'https://attacker.test/' } })
	try {
		await assert.rejects(
			headPrivateObjectFromCos({ ...credentials, objectKey: 'novels/private/42/book.epub', contentType: 'application/epub+zip', now }),
			(error: Error & { status?: number }) => {
				assert.equal(error.status, 502)
				assert.doesNotMatch(error.message, /attacker|Authorization|q-signature/)
				return true
			},
		)
	} finally {
		globalThis.fetch = originalFetch
	}
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
		assert.equal(request?.init?.redirect, 'manual')
		assert.equal(request?.init?.body, body)
		assert.equal(Object.hasOwn(request?.init?.headers ?? {}, 'Host'), false)
		assert.equal((request?.init?.headers as Record<string, string>)['x-cos-forbid-overwrite'], 'true')
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

test('checks a public object without authorization and with manual redirects', async () => {
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
			bucket: 'abdl-123',
			objectKey: 'media/a.jpg',
			contentType: 'image/jpeg',
			now,
		})

		assert.equal(response.status, 200)
		assert.equal(request?.init?.method, 'HEAD')
		assert.equal(request?.init?.redirect, 'manual')
		assert.equal(request?.input, 'https://abdl-123.cos.ap-shanghai.myqcloud.com/media/a.jpg')
		assert.equal(request?.init?.headers, undefined)
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

test('deletes an object with a method-specific signature and no overwrite header', async () => {
	const originalFetch = globalThis.fetch
	let request: { input: string | URL | Request; init?: RequestInit } | undefined
	globalThis.fetch = async (input, init) => {
		request = { input, init }
		return new Response(null, { status: 204 })
	}

	try {
		const signed = await createCosDeleteAuthorization({
			...credentials,
			objectKey: 'generic/42/a.jpg',
			contentType: 'image/jpeg',
			now,
		})
		assert.equal(Object.hasOwn(signed.headers, 'x-cos-forbid-overwrite'), false)
		assert.equal(Object.hasOwn(signed.headers, 'Content-Type'), false)
		assert.match(signed.headers.Authorization, /q-header-list=host(?:&|$)/)
		await deleteObjectFromCos({
			...credentials,
			objectKey: 'generic/42/a.jpg',
			contentType: 'image/jpeg',
			now,
		})
		assert.equal(request?.init?.method, 'DELETE')
		assert.equal(request?.init?.redirect, 'manual')
		assert.deepEqual(request?.init?.headers, signed.headers)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('DELETE failures expose only a safe status', async () => {
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => new Response(null, { status: 500, headers: { Authorization: 'must-not-leak' } })
	try {
		await assert.rejects(
			deleteObjectFromCos({
				...credentials,
				objectKey: 'novels/private/42/book.epub',
				contentType: 'application/epub+zip',
				now,
			}),
			(error: Error & { status?: number }) => {
				assert.equal(error.status, 500)
				assert.doesNotMatch(error.message, /Authorization|AKIDEXAMPLEFAKE|q-signature|must-not-leak/)
				return true
			},
		)
	} finally {
		globalThis.fetch = originalFetch
	}
})
