import test from 'node:test'
import assert from 'node:assert/strict'
import { isAllowedStatusMediaUrl } from './routes.ts'

test('accepts only project COS and historical legacy media origins', () => {
  assert.equal(isAllowedStatusMediaUrl('https://img.abdl-space.top/file/a.jpg'), true)
  assert.equal(isAllowedStatusMediaUrl('https://cloudflare-imgbed-790.pages.dev/file/a.jpg'), true)
  assert.equal(isAllowedStatusMediaUrl('https://abdl-1339643562.cos.ap-shanghai.myqcloud.com/media/a.jpg'), true)
  assert.equal(isAllowedStatusMediaUrl('https://media.example.test/media/a.jpg', 'https://media.example.test'), true)
  assert.equal(isAllowedStatusMediaUrl('https://cdn.example.com/file/a.jpg'), false)
  assert.equal(isAllowedStatusMediaUrl('http://cdn.example.com/file/a.jpg'), false)
  assert.equal(isAllowedStatusMediaUrl('not-a-url'), false)
})
