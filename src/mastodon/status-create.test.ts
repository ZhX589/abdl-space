import test from 'node:test'
import assert from 'node:assert/strict'
import { isAllowedStatusMediaUrl } from './routes.ts'

test('accepts HTTPS media URLs returned by the upload CDN', () => {
  assert.equal(isAllowedStatusMediaUrl('https://img.abdl-space.top/file/a.jpg'), true)
  assert.equal(isAllowedStatusMediaUrl('https://cloudflare-imgbed-790.pages.dev/file/a.jpg'), true)
  assert.equal(isAllowedStatusMediaUrl('https://cdn.example.com/file/a.jpg'), true)
  assert.equal(isAllowedStatusMediaUrl('http://cdn.example.com/file/a.jpg'), false)
  assert.equal(isAllowedStatusMediaUrl('not-a-url'), false)
})
