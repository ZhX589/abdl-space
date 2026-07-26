import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMediaPreviewUrl,
  calculateMediaPreviewSize,
  parseMediaPreviewSource,
  resizeMediaPreview,
} from '../lib/media-preview.ts'

const apiOrigin = 'https://api.abdl-space.top'

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
  assert.equal(buildMediaPreviewUrl(`${apiOrigin}/api/v1/media/preview/v1/recursive`, apiOrigin), `${apiOrigin}/api/v1/media/preview/v1/recursive`)
  assert.equal(parseMediaPreviewSource('/api/v1/media/preview/v1/not-valid'), null)
})

test('limits preview longest edge to 720 pixels without upscaling', () => {
  assert.deepEqual(calculateMediaPreviewSize(1440, 1080), { width: 720, height: 540 })
  assert.deepEqual(calculateMediaPreviewSize(1080, 1920), { width: 405, height: 720 })
  assert.deepEqual(calculateMediaPreviewSize(320, 240), { width: 320, height: 240 })
  assert.equal(calculateMediaPreviewSize(0, 240), null)
})

test('encodes a valid image as webp without enlarging it', () => {
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
  const preview = resizeMediaPreview(png)

  assert.ok(preview)
  assert.deepEqual({ width: preview.width, height: preview.height }, { width: 1, height: 1 })
  assert.deepEqual(Array.from(preview.bytes.slice(0, 4)), [0x52, 0x49, 0x46, 0x46])
  assert.equal(new TextDecoder().decode(preview.bytes.slice(8, 12)), 'WEBP')
})
