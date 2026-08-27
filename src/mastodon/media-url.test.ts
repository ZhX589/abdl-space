import test from 'node:test'
import assert from 'node:assert/strict'
import { isAllowedStatusMediaUrl } from './routes.ts'

test('allows only project media origins for status attachments', () => {
  assert.equal(isAllowedStatusMediaUrl('https://img.abdl-space.top/file/old.jpg'), true)
  assert.equal(isAllowedStatusMediaUrl('https://cloudflare-imgbed-790.pages.dev/file/old.jpg'), true)
  assert.equal(isAllowedStatusMediaUrl('https://abdl-1339643562.cos.ap-shanghai.myqcloud.com/media/new.jpg'), true)
  assert.equal(isAllowedStatusMediaUrl('https://cdn.example.com/path/image.webp'), false)
})

test('rejects non-https and invalid media URLs', () => {
  assert.equal(isAllowedStatusMediaUrl('http://img.abdl-space.top/file/insecure.jpg'), false)
  assert.equal(isAllowedStatusMediaUrl('/file/local.jpg'), false)
  assert.equal(isAllowedStatusMediaUrl('not a url'), false)
})
