import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toAccount } from './converter.ts'

test('toAccount passes last_status_province through and defaults to null', () => {
  const withProvince = toAccount(
    { id: 1, username: 'u', avatar: null, role: 'user', created_at: '2026-01-01 00:00:00' },
    { last_status_province: '广东省' }
  )
  assert.equal(withProvince.last_status_province, '广东省')

  const withoutOpt = toAccount(
    { id: 2, username: 'v', avatar: null, role: 'user', created_at: '2026-01-01 00:00:00' }
  )
  assert.equal(withoutOpt.last_status_province, null)
})
