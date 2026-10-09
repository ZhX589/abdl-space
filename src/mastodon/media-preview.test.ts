import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AVATAR_LONG_EDGE,
  AVATAR_PREVIEW_PATH_PREFIX,
  buildAvatarPreviewUrl,
  buildMediaPreviewUrl,
  calculateMediaPreviewSize,
  canonicalMediaPreviewCacheUrl,
  inspectMediaImageDimensions,
  parseMediaPreviewSource,
  resizeMediaPreview,
} from '../lib/media-preview.ts'

const apiOrigin = 'https://api.abdl-space.top'
const cosSource = 'https://abdl-1339643562.cos.ap-shanghai.myqcloud.com/posts/example.jpg'
/** 200x100 不透明 PNG，用来验证两条端点各自的长边上限。 */
const opaquePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAIAAABM5OhcAAABXklEQVR42u3bMQ0AIAxFwSphRhOKUVIdiKBL00sQ8NJ/K7H2qXpZ91R1rwrHUgWWKrBMCJZjqQJLFVgmBMuxVIGlCiwTguVYqsBSBZYJwXIsVWCpAsuEYDmWKrBUgWVCsBxLFViqwDIhWI6lCixVYJlwEKx7ql7WPVXdq8BSBZYqsEwIlmOpAksVWCYEy7FUgaUKLBOC5ViqwFIFlgnBcixVYKkCy4RgOZYqsFSBZUKwHEsVWKrAMiFYjqUKLFVgmXASLL97VflirwosE4LlWKrAUgWWCcFyLFVgqQLLhGA5liqwVIFlQrAcSxVYqsAyIViOpQosVWCZECzHUgWWKrBMCJZjqQJLFVgmBMuxVH3B8rtXlS/2qsAyIViOpQosVWCZECzHUgWWKrBMCJZjqQJLFVgmBMuxVIGlCiwTguVYqsBSBZYJwXIsVWCpAsuEYDmWKrBUgWVCsBxL1cd7l4bIisb4HhUAAAAASUVORK5CYII='

test('builds deterministic preview URLs for trusted media hosts', () => {
  const source = 'https://img.abdl-space.top/file/posts/example image.jpg'
  const preview = buildMediaPreviewUrl(source, apiOrigin)

  assert.notEqual(preview, source)
  assert.equal(preview, buildMediaPreviewUrl(source, apiOrigin))
  assert.equal(parseMediaPreviewSource(new URL(preview).pathname), source)
})

test('keeps unknown and insecure media URLs unchanged', () => {
  assert.equal(buildMediaPreviewUrl('https://cdn.example.com/image.jpg', apiOrigin), 'https://cdn.example.com/image.jpg')
  assert.equal(buildMediaPreviewUrl('http://img.abdl-space.top/image.jpg', apiOrigin), 'http://img.abdl-space.top/image.jpg')
  assert.equal(buildMediaPreviewUrl(`${apiOrigin}/api/v1/media/preview/v3/recursive`, apiOrigin), `${apiOrigin}/api/v1/media/preview/v3/recursive`)
  assert.equal(parseMediaPreviewSource('/api/v1/media/preview/v3/not-valid'), null)
})

test('limits preview longest edge to 720 pixels without upscaling', () => {
  assert.deepEqual(calculateMediaPreviewSize(1440, 1080), { width: 720, height: 540 })
  assert.deepEqual(calculateMediaPreviewSize(1080, 1920), { width: 405, height: 720 })
  assert.deepEqual(calculateMediaPreviewSize(320, 240), { width: 320, height: 240 })
  assert.equal(calculateMediaPreviewSize(0, 240), null)
})

test('encodes an opaque image as a compressed jpeg without enlarging it', () => {
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
  const preview = resizeMediaPreview(png)

  assert.ok(preview)
  assert.deepEqual({ width: preview.width, height: preview.height }, { width: 1, height: 1 })
  assert.equal(preview.contentType, 'image/jpeg')
  assert.deepEqual(Array.from(preview.bytes.slice(0, 2)), [0xff, 0xd8])
})

test('reads image dimensions before decoding and rejects excessive pixels', () => {
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
  assert.deepEqual(inspectMediaImageDimensions(png), { width: 1, height: 1 })

  const oversizedPng = png.slice()
  oversizedPng.set([0x00, 0x00, 0x13, 0x88], 16)
  oversizedPng.set([0x00, 0x00, 0x13, 0x88], 20)
  assert.equal(inspectMediaImageDimensions(oversizedPng), null)
})

test('canonical cache URL ignores query strings', () => {
  assert.equal(
    canonicalMediaPreviewCacheUrl(`${apiOrigin}/api/v1/media/preview/v3/source?nonce=1`),
    `${apiOrigin}/api/v1/media/preview/v3/source`,
  )
})

test('routes COS objects through the worker preview endpoint instead of the raw object', () => {
  const preview = buildMediaPreviewUrl(cosSource, apiOrigin)

  assert.notEqual(preview, cosSource)
  assert.ok(preview.startsWith(`${apiOrigin}/api/v1/media/preview/v3/`))
  assert.equal(parseMediaPreviewSource(new URL(preview).pathname), cosSource)
})

test('keeps insecure and foreign media sources unchanged', () => {
  const insecure = 'http://abdl-1339643562.cos.ap-shanghai.myqcloud.com/posts/example.jpg'
  assert.equal(buildMediaPreviewUrl(insecure, apiOrigin), insecure)

  // 只有自有桶进可信集，别人的 COS 桶不改写
  const foreign = 'https://other-bucket.cos.ap-shanghai.myqcloud.com/posts/example.jpg'
  assert.equal(buildMediaPreviewUrl(foreign, apiOrigin), foreign)
})

test('builds avatar previews on a separate 160px path', () => {
  const source = 'https://img.abdl-space.top/file/avatars/user.png'
  const preview = buildAvatarPreviewUrl(source, apiOrigin)

  assert.ok(preview.startsWith(`${apiOrigin}${AVATAR_PREVIEW_PATH_PREFIX}`))
  assert.equal(parseMediaPreviewSource(new URL(preview).pathname, [], AVATAR_PREVIEW_PATH_PREFIX), source)
  // 两条前缀互不认领：头像地址不会被内容图路由当作来源
  assert.equal(parseMediaPreviewSource(new URL(preview).pathname), null)
  assert.equal(buildAvatarPreviewUrl('https://cdn.example.com/a.png', apiOrigin), 'https://cdn.example.com/a.png')
  assert.equal(buildAvatarPreviewUrl('', apiOrigin), '')
})

test('limits avatar preview longest edge to 160 pixels without upscaling', () => {
  assert.deepEqual(calculateMediaPreviewSize(1024, 512, AVATAR_LONG_EDGE), { width: 160, height: 80 })
  assert.deepEqual(calculateMediaPreviewSize(64, 64, AVATAR_LONG_EDGE), { width: 64, height: 64 })
})

test('resizes avatars down to the requested long edge', () => {
  const png = Uint8Array.from(atob(opaquePngBase64), char => char.charCodeAt(0))
  assert.deepEqual(inspectMediaImageDimensions(png), { width: 200, height: 100 })

  const avatar = resizeMediaPreview(png, AVATAR_LONG_EDGE)
  if (!avatar) throw new Error('expected an avatar preview')
  assert.deepEqual({ width: avatar.width, height: avatar.height }, { width: 160, height: 80 })

  const content = resizeMediaPreview(png)
  if (!content) throw new Error('expected a content preview')
  assert.deepEqual({ width: content.width, height: content.height }, { width: 200, height: 100 })
})
