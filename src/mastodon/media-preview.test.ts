import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMediaPreviewUrl,
  calculateMediaPreviewSize,
  canonicalMediaPreviewCacheUrl,
  inspectMediaImageDimensions,
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
